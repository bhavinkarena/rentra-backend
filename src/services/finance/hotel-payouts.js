import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '@/utils/apiError.js';
import { resolveCommission } from '../booking/hotel-stays.js';
import { maskedDestination } from '../domain/payout-destinations.js';
import { addLocalDays, propertyToday } from '../domain/booking-dates.js';

/**
 * Hotel payouts (hotel plan §5.8, Phase 8). A stay is payable after check-in is
 * marked, or 24 hours after check-in time if it was not (and a cancelled or
 * no-show stay pays out what the guest was charged). Every Tuesday one run pays
 * every payable stay. Per stay, from the money actually kept (captured minus
 * refunds, including refunds still in flight):
 *
 *   room kept + GST kept (registered hotel only)
 *   − commission − 18% GST on commission − TCS (s.52, registered only) − TDS (s.194-O)
 *   = net to the hotel
 *
 * A hotel that is not GST-registered does not receive the GST: under s.9(5)
 * Rentra owes it. Test-mode captures are not money, so a test run is a
 * statement only (no funded payout rows). Rates are the plan's current ones
 * (§2.6); the CA confirms them before launch.
 */
export const PAYOUT_POLICY = Object.freeze({
  commissionGstBps: 1800,
  tcsBps: 50,
  tdsBps: 10,
  payoutWeekday: 2, // Tuesday
});

const uuid = z.string().uuid();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Percentage of integer paise, rounded half up. */
const share = (minor, bps) => (BigInt(minor) * BigInt(bps) + 5000n) / 10000n;
const n = (value) => Number(value ?? 0);

/** One stay's statement line, all integer paise. Pure, so the money rules are unit-testable. */
export function stayLine({ roomPaidMinor, taxPaidMinor = 0, roomRefundedMinor = 0, taxRefundedMinor = 0, rateBps, gstRegistered }) {
  const room = BigInt(roomPaidMinor) - BigInt(roomRefundedMinor);
  const tax = BigInt(taxPaidMinor) - BigInt(taxRefundedMinor);
  if (room < 0n || tax < 0n) throw new RangeError('Refunds exceed what was paid');
  const commission = share(room, rateBps);
  const commissionGst = share(commission, PAYOUT_POLICY.commissionGstBps);
  const tcs = gstRegistered ? share(room, PAYOUT_POLICY.tcsBps) : 0n;
  const tds = share(room, PAYOUT_POLICY.tdsBps);
  const gstToHotel = gstRegistered ? tax : 0n;
  const net = room + gstToHotel - commission - commissionGst - tcs - tds;
  return {
    roomMinor: Number(room), gstMinor: Number(tax), gstToHotelMinor: Number(gstToHotel),
    gstRentraOwesMinor: Number(tax - gstToHotel), commissionMinor: Number(commission),
    commissionGstMinor: Number(commissionGst), tcsMinor: Number(tcs), tdsMinor: Number(tds),
    netMinor: Number(net), roomNetMinor: Number(room - commission - commissionGst - tcs - tds),
  };
}

/** The Tuesday a run made today pays on (today when today is Tuesday), in India time. */
export function nextPayoutDate(today = propertyToday()) {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addLocalDays(today, (PAYOUT_POLICY.payoutWeekday - weekday + 7) % 7);
}

/** Payment environment of the current gateway configuration: what "the next payout" means today. */
async function currentEnvironment(tx) {
  const [row] = await tx`SELECT environment FROM payment_gateway_config ORDER BY version DESC LIMIT 1`;
  return row?.environment === 'live' ? 'live' : 'test';
}

/**
 * Stays ready for a run (never in one already), with what was paid and refunded
 * per component. `asOf` is an instant; eligibility is checked against it.
 */
async function payableStays(tx, { environment, ownerId = null, asOf }) {
  return tx`
    SELECT b.id, b.reference, b.state, b.rentable_id, b.starts_at, r.client_id AS owner_id, r.title,
      b.slot_snapshot->>'checkIn' AS check_in, b.slot_snapshot->>'checkOut' AS check_out, b.local_day::text AS local_day,
      coalesce(hp.gst_registered, false) AS gst_registered, hp.gstin,
      rent.id AS rent_allocation_id, rent.actual_minor::text AS room_paid,
      tax.id AS tax_allocation_id, coalesce(tax.actual_minor, 0)::text AS tax_paid,
      (SELECT coalesce(sum(ra.expected_minor), 0) FROM refund_allocation ra JOIN refund f ON f.id = ra.refund_id
        WHERE ra.payment_allocation_id = rent.id AND f.state <> 'failed')::text AS room_refunded,
      (SELECT coalesce(sum(ra.expected_minor), 0) FROM refund_allocation ra JOIN refund f ON f.id = ra.refund_id
        WHERE ra.payment_allocation_id = tax.id AND f.state <> 'failed')::text AS tax_refunded,
      d.id AS destination_id, d.method, d.account_last4, d.ifsc, d.upi_id, d.state AS destination_state, d.version AS destination_version,
      (SELECT o.policy_snapshot->'pricing'->>'feeModel' FROM booking_order o WHERE o.id = b.order_id) AS fee_model
    FROM booking b
    JOIN rentable r ON r.id = b.rentable_id
    JOIN category c ON c.id = r.category_id AND c.vertical_code = 'hotel'
    JOIN payment_allocation rent ON rent.booking_id = b.id AND rent.component = 'rent'
    JOIN payment_transaction t ON t.id = rent.transaction_id AND t.kind = 'capture' AND t.outcome = 'succeeded'
      AND t.verified_at IS NOT NULL AND t.mode = 'real' AND t.environment::text = ${environment}
    LEFT JOIN payment_allocation tax ON tax.booking_id = b.id AND tax.component = 'tax' AND tax.transaction_id = rent.transaction_id
    LEFT JOIN hotel_profile hp ON hp.rentable_id = r.id
    LEFT JOIN LATERAL (SELECT * FROM payout_destination pd WHERE pd.client_id = r.client_id AND pd.state = 'verified'
      ORDER BY pd.version DESC LIMIT 1) d ON true
    WHERE b.slot = 'stay' AND b.starts_at <= ${asOf}
      AND (b.state IN ('handed_over', 'returned', 'completed', 'no_show')
        OR (b.state IN ('confirmed', 'cancelled') AND b.starts_at + interval '24 hours' <= ${asOf}))
      AND NOT EXISTS (SELECT 1 FROM payout p WHERE p.booking_id = b.id)
      AND (${!ownerId} OR r.client_id = ${ownerId}::uuid)
    ORDER BY r.client_id, b.starts_at, b.id`;
}

/** Statement for the stays payable now, grouped by owner; `held` lists stays waiting on a verified payout method. */
async function buildRun(tx, { environment, ownerId = null, now = null }) {
  const asOf = new Date(now ?? (await tx`SELECT clock_timestamp() AS now`)[0].now).toISOString();
  const rows = await payableStays(tx, { environment, ownerId, asOf });
  const lines = [];
  const held = [];
  for (const row of rows) {
    let rule;
    try {
      // Story 2.2: stays booked with the guest-paid service fee carry no owner commission.
      rule = row.fee_model === 'guest_service_fee'
        ? { rateBps: 0, ruleId: null }
        : await resolveCommission(tx, { rentableId: row.rentable_id, date: row.local_day });
    } catch (error) {
      if (error.code !== 'COMMISSION_UNCONFIGURED') throw error;
      // No rule for the stay date: never guess a rate. Finance adds the rule; the stay waits.
      held.push({ bookingId: row.id, reference: row.reference, state: row.state, ownerId: row.owner_id, hotel: row.title,
        checkIn: row.check_in ?? row.local_day, checkOut: row.check_out, reason: 'No commission rule covers this stay date' });
      continue;
    }
    const line = {
      bookingId: row.id, reference: row.reference, state: row.state, ownerId: row.owner_id, hotel: row.title,
      rentableId: row.rentable_id, checkIn: row.check_in ?? row.local_day, checkOut: row.check_out,
      gstRegistered: row.gst_registered, hotelGstin: row.gst_registered ? row.gstin : null,
      rateBps: rule.rateBps, ruleId: rule.ruleId,
      roomAllocationId: row.rent_allocation_id, taxAllocationId: row.tax_allocation_id,
      paidMinor: n(row.room_paid) + n(row.tax_paid), refundedMinor: n(row.room_refunded) + n(row.tax_refunded),
      ...stayLine({ roomPaidMinor: row.room_paid, taxPaidMinor: row.tax_paid, roomRefundedMinor: row.room_refunded,
        taxRefundedMinor: row.tax_refunded, rateBps: rule.rateBps, gstRegistered: row.gst_registered }),
    };
    if (line.roomMinor === 0 && line.gstMinor === 0) continue; // Fully refunded: nothing to pay or charge.
    if (!row.destination_id) held.push({ ...line, reason: 'Payout method not verified' });
    else lines.push({ ...line, destination: { id: row.destination_id, method: row.method, accountLast4: row.account_last4, ifsc: row.ifsc, upiId: row.upi_id } });
  }
  const totals = sumLines(lines);
  const owners = [...Map.groupBy(lines, (line) => line.ownerId)].map(([id, own]) => ({
    ownerId: id, hotels: [...new Set(own.map((line) => line.hotel))], destination: maskedDestination(own[0].destination),
    ...sumLines(own),
  }));
  const content = { environment, payoutDate: nextPayoutDate(), periodEnd: asOf.slice(0, 10), lines, totals };
  return { ...content, owners, held, previewHash: digest(content) };
}

function sumLines(lines) {
  const keys = ['paidMinor', 'refundedMinor', 'roomMinor', 'gstMinor', 'gstToHotelMinor', 'gstRentraOwesMinor', 'commissionMinor', 'commissionGstMinor', 'tcsMinor', 'tdsMinor', 'netMinor'];
  return { stays: lines.length, ...Object.fromEntries(keys.map((key) => [key, lines.reduce((sum, line) => sum + line[key], 0)])) };
}

async function requireAdmin(tx, adminId, write = false) {
  if (!uuid.safeParse(adminId).success) throw forbidden();
  const [admin] = write
    ? await tx`SELECT permissions FROM admin_user WHERE id = ${adminId} AND is_active FOR SHARE`
    : await tx`SELECT permissions FROM admin_user WHERE id = ${adminId} AND is_active`;
  const allowed = (cap) => admin && (admin.permissions == null || admin.permissions.includes(cap));
  if (!allowed(write ? 'admin.payments.write' : 'admin.payments.read')) throw forbidden();
}

const environmentSchema = z.object({ environment: z.enum(['live', 'test']).optional() }).passthrough();

/** Admin: the run that would be made now. */
/** `options.now` (tests only) evaluates eligibility at another instant; the API never passes it. */
export async function previewPayoutRun(database, adminId, input = {}, { now = null } = {}) {
  const { environment } = environmentSchema.parse(input);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    await requireAdmin(tx, adminId);
    return buildRun(tx, { environment: environment ?? (await currentEnvironment(tx)), now });
  });
}

/**
 * Admin: make the run exactly as previewed. One run at a time (advisory lock);
 * a changed preview is refused. Live lines become funded payout rows (room, and
 * GST for a registered hotel); test lines are recorded unfunded.
 */
export async function executePayoutRun(database, adminId, input, { now = null } = {}) {
  const value = z.object({ environment: z.enum(['live', 'test']), previewHash: z.string().length(64) }).strict().parse(input);
  return database.begin(async (tx) => {
    await requireAdmin(tx, adminId, true);
    await tx`SELECT pg_advisory_xact_lock(73421, 1)`;
    const run = await buildRun(tx, { environment: value.environment, now });
    if (run.previewHash !== value.previewHash) throw conflict('STALE_PREVIEW', 'Payable stays changed since the preview. Review the run again.');
    if (!run.lines.length) throw conflict('NO_PAYABLE_STAYS', 'No stays are ready for payout.');
    const [{ count }] = await tx`SELECT count(*)::int AS count FROM payout_run`;
    const periodStart = run.lines.reduce((min, line) => (line.checkIn < min ? line.checkIn : min), run.lines[0].checkIn);
    const [saved] = await tx`INSERT INTO payout_run (run_number, environment, period_start, period_end, payout_date, total_bookings,
        room_revenue_minor, gst_collected_minor, commission_minor, commission_gst_minor, tcs_minor, tds_minor, net_minor, snapshot, executed_at, executed_by)
      VALUES (${`P-${String(count + 1).padStart(4, '0')}`}, ${run.environment}, ${periodStart}, ${run.periodEnd}, ${run.payoutDate}, ${run.totals.stays},
        ${run.totals.roomMinor}, ${run.totals.gstMinor}, ${run.totals.commissionMinor}, ${run.totals.commissionGstMinor}, ${run.totals.tcsMinor},
        ${run.totals.tdsMinor}, ${run.totals.netMinor}, ${JSON.stringify({ lines: run.lines, totals: run.totals, policy: PAYOUT_POLICY })}::text::jsonb,
        now(), ${adminId}) RETURNING id, run_number`;
    const live = run.environment === 'live';
    for (const line of run.lines) {
      const row = (gross, commission, tds, tcs, net, allocation) => tx`INSERT INTO payout (payout_run_id, booking_id, client_id, gross_minor,
          commission_minor, tds_194o_minor, gst_tcs_minor, net_minor, actual_net_minor, funding_allocation_id, destination_id, status)
        VALUES (${saved.id}, ${line.bookingId}, ${line.ownerId}, ${gross}, ${commission}, ${tds}, ${tcs}, ${net},
          ${live ? net : 0}, ${live ? allocation : null}, ${line.destination.id}, 'pending')`;
      await row(line.roomMinor, line.commissionMinor + line.commissionGstMinor, line.tdsMinor, line.tcsMinor, line.roomNetMinor, line.roomAllocationId);
      if (line.gstToHotelMinor > 0) await row(line.gstToHotelMinor, 0, 0, 0, line.gstToHotelMinor, line.taxAllocationId);
    }
    await tx`INSERT INTO audit_log (actor_type, actor_id, entity, entity_id, action, "after")
      VALUES ('admin', ${adminId}, 'payout_run', ${saved.id}, 'payout_run_executed', ${JSON.stringify({ runNumber: saved.run_number, environment: run.environment, totals: run.totals })}::text::jsonb)`;
    return { ok: true, id: saved.id, runNumber: saved.run_number, ...run.totals };
  });
}

/** Admin: record the bank transfer (UTR) for a run; its payouts become paid. */
export async function settlePayoutRun(database, adminId, { runId, utr }) {
  uuid.parse(runId);
  const reference = String(utr ?? '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(reference)) throw badRequest('INVALID_UTR', 'Enter the bank transfer UTR (6–32 letters or digits).');
  return database.begin(async (tx) => {
    await requireAdmin(tx, adminId, true);
    const [run] = await tx`SELECT * FROM payout_run WHERE id = ${runId} FOR UPDATE`;
    if (!run) throw notFound();
    if (run.status === 'completed') throw conflict('ALREADY_SETTLED', 'This payout run is already settled.');
    await tx`UPDATE payout_run SET status = 'completed' WHERE id = ${runId}`;
    await tx`UPDATE payout SET status = 'paid', utr = ${reference}, settled_at = now() WHERE payout_run_id = ${runId}`;
    await tx`INSERT INTO audit_log (actor_type, actor_id, entity, entity_id, action, "after")
      VALUES ('admin', ${adminId}, 'payout_run', ${runId}, 'payout_run_settled', ${JSON.stringify({ utr: reference })}::text::jsonb)`;
    return { ok: true, id: runId, status: 'completed', utr: reference };
  });
}

/** Admin: recent runs. */
export async function listPayoutRuns(database, adminId) {
  return database.begin(async (tx) => {
    await requireAdmin(tx, adminId);
    const items = await tx`SELECT pr.id, pr.run_number AS "runNumber", pr.environment, pr.period_start::text AS "periodStart",
        pr.period_end::text AS "periodEnd", pr.payout_date::text AS "payoutDate", pr.total_bookings AS stays, pr.net_minor::text AS "netMinor",
        pr.commission_minor::text AS "commissionMinor", pr.status, pr.executed_at AS "executedAt", a.email AS "executedBy",
        (SELECT max(p.utr) FROM payout p WHERE p.payout_run_id = pr.id) AS utr
      FROM payout_run pr LEFT JOIN admin_user a ON a.id = pr.executed_by ORDER BY pr.created_at DESC LIMIT 52`;
    return { items: items.map((row) => ({ ...row, netMinor: n(row.netMinor), commissionMinor: n(row.commissionMinor) })) };
  });
}

async function requireOwner(tx, ownerId) {
  if (!uuid.safeParse(ownerId).success) throw forbidden();
  const [owner] = await tx`SELECT id, name, email FROM "user" WHERE id = ${ownerId} AND role = 'client' AND account_status = 'active'`;
  if (!owner) throw forbidden();
  return owner;
}

/** One owner's lines of a run, with totals; the statement and the invoice both read this. */
function ownerStatement(run, ownerId) {
  const lines = (run.snapshot.lines ?? []).filter((line) => line.ownerId === ownerId);
  return { id: run.id, runNumber: run.run_number, environment: run.environment, payoutDate: run.payout_date, status: run.status,
    utr: run.utr ?? null, lines, totals: sumLines(lines) };
}

/**
 * Owner: earnings for hotels — this month's stays, the next payout (as a
 * preview) and past payout statements. Amounts in paise.
 */
export async function getOwnerHotelEarnings(database, ownerId, { month } = {}) {
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '') ? month : propertyToday().slice(0, 7);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    await requireOwner(tx, ownerId);
    const environment = await currentEnvironment(tx);
    const [stats] = await tx`
      SELECT count(DISTINCT b.id)::int AS stays,
        count(DISTINCT b.id) FILTER (WHERE b.state = 'cancelled')::int AS cancelled,
        coalesce(sum(cardinality(ARRAY(SELECT night FROM jsonb_array_elements(br.nights) night WHERE (night->>'night')::date < coalesce(br.inventory_end,br.check_out)))) FILTER (WHERE br.state IN ('booked', 'stayed', 'no_show')), 0)::int AS room_nights
      FROM booking b JOIN rentable r ON r.id = b.rentable_id AND r.client_id = ${ownerId}
      LEFT JOIN booking_room br ON br.booking_id = b.id
      WHERE b.slot = 'stay' AND b.state <> 'requested' AND to_char(b.local_day, 'YYYY-MM') = ${period}`;
    const [money] = await tx`
      SELECT coalesce(sum(pa.actual_minor) FILTER (WHERE pa.component = 'rent'), 0)::text AS room,
        coalesce(sum(pa.actual_minor) FILTER (WHERE pa.component = 'tax'), 0)::text AS gst,
        coalesce(sum((SELECT coalesce(sum(ra.expected_minor), 0) FROM refund_allocation ra JOIN refund f ON f.id = ra.refund_id
          WHERE ra.payment_allocation_id = pa.id AND f.state <> 'failed')), 0)::text AS refunded
      FROM payment_allocation pa JOIN booking b ON b.id = pa.booking_id AND b.slot = 'stay'
      JOIN rentable r ON r.id = b.rentable_id AND r.client_id = ${ownerId}
      JOIN payment_transaction t ON t.id = pa.transaction_id AND t.environment::text = ${environment}
      -- Story 2.2: the guest service fee is Rentra's money, not the owner's revenue or refunds.
      WHERE to_char(b.local_day, 'YYYY-MM') = ${period} AND pa.component IN ('rent', 'tax')`;
    const next = await buildRun(tx, { environment, ownerId });
    const runs = await tx`SELECT pr.*, pr.payout_date::text AS payout_date, (SELECT max(p.utr) FROM payout p WHERE p.payout_run_id = pr.id AND p.client_id = ${ownerId}) AS utr
      FROM payout_run pr WHERE EXISTS (SELECT 1 FROM payout p WHERE p.payout_run_id = pr.id AND p.client_id = ${ownerId})
      ORDER BY pr.payout_date DESC, pr.created_at DESC LIMIT 26`;
    const [destination] = await tx`SELECT * FROM payout_destination WHERE client_id = ${ownerId} AND state = 'verified' ORDER BY version DESC LIMIT 1`;
    return {
      month: period, environment,
      summary: { stays: stats.stays, roomNights: stats.room_nights, cancelled: stats.cancelled,
        roomMinor: n(money.room), gstMinor: n(money.gst), refundedMinor: n(money.refunded) },
      nextPayout: { date: next.payoutDate, ...next.totals, held: next.held.length,
        destination: destination ? maskedDestination(destination) : null, lines: next.lines.concat(next.held) },
      payouts: runs.map((run) => ownerStatement(run, ownerId)).map(({ lines, ...run }) => ({ ...run, stays: lines.length })),
    };
  });
}

/** Owner: one payout statement (every stay line), the source of the CSV and the print view. */
export async function getOwnerPayoutStatement(database, ownerId, runId) {
  uuid.parse(runId);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    await requireOwner(tx, ownerId);
    const [run] = await tx`SELECT pr.*, pr.payout_date::text AS payout_date, (SELECT max(p.utr) FROM payout p WHERE p.payout_run_id = pr.id AND p.client_id = ${ownerId}) AS utr
      FROM payout_run pr WHERE pr.id = ${runId} AND EXISTS (SELECT 1 FROM payout p WHERE p.payout_run_id = pr.id AND p.client_id = ${ownerId})`;
    if (!run) throw notFound();
    return ownerStatement(run, ownerId);
  });
}

/**
 * Owner: Rentra's commission invoice for one payout run (commission + 18% GST,
 * split CGST/SGST for an intra-state supply). Rentra's legal details come from
 * configuration; until they are set the invoice is a draft, never a made-up GSTIN.
 */
export async function getCommissionInvoice(database, ownerId, runId, env = process.env) {
  const statement = await getOwnerPayoutStatement(database, ownerId, runId);
  const owner = await database`SELECT name, email FROM "user" WHERE id = ${ownerId}`;
  const issuer = { name: env.RENTRA_LEGAL_NAME || null, gstin: env.RENTRA_GSTIN || null, address: env.RENTRA_LEGAL_ADDRESS || null };
  const configured = Boolean(issuer.name && issuer.gstin && issuer.address);
  const { commissionMinor, commissionGstMinor } = statement.totals;
  return {
    invoiceNumber: configured ? `RC-${statement.runNumber}-${ownerId.slice(0, 6).toUpperCase()}` : null,
    draft: !configured || statement.environment !== 'live',
    date: statement.payoutDate, issuer,
    recipient: { name: owner[0]?.name ?? null, gstin: statement.lines.find((line) => line.hotelGstin)?.hotelGstin ?? null,
      hotels: [...new Set(statement.lines.map((line) => line.hotel))] },
    lines: [{ description: 'Marketplace facilitation commission on hotel stays', sac: '998552', stays: statement.lines.length,
      taxableMinor: commissionMinor, cgstMinor: Math.floor(commissionGstMinor / 2), sgstMinor: commissionGstMinor - Math.floor(commissionGstMinor / 2),
      totalMinor: commissionMinor + commissionGstMinor }],
    tcsMinor: statement.totals.tcsMinor, tdsMinor: statement.totals.tdsMinor,
  };
}
