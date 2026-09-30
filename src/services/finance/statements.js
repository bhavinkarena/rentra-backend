import 'server-only';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '@/utils/apiError.js';
import { maskedDestination } from '../domain/payout-destinations.js';

const uuid = z.string().uuid();
const amount = (v) => BigInt(v ?? 0);
const iso = (v) => (v ? new Date(v).toISOString() : null);
export function statementFilters(query = {}) {
  const parsed = z
    .object({
      period: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .default(new Date().toISOString().slice(0, 7)),
      environment: z.enum(['live', 'test', 'simulated', 'legacy_unknown']).default('live'),
      propertyId: uuid.or(z.literal('')).default(''),
      ownerId: uuid.or(z.literal('')).default(''),
      page: z.coerce.number().int().min(1).max(10000).default(1),
    })
    .safeParse(query);
  if (
    !parsed.success ||
    Number(parsed.data.period.slice(0, 4)) < 2000 ||
    Number(parsed.data.period.slice(0, 4)) > 2100
  )
    throw badRequest('INVALID_FILTER', 'Choose a valid period, environment and property.');
  return parsed.data;
}
async function authorize(tx, actor) {
  if (!uuid.safeParse(actor?.id).success) throw forbidden();
  const rows =
    actor.kind === 'owner'
      ? await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active'`
      : actor.kind === 'admin'
        ? await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active AND (permissions IS NULL OR permissions @> '["admin.payments.read"]'::jsonb)`
        : [];
  if (!rows.length) throw forbidden();
}
// Attribution comes only from immutable booking evidence or a funded, pinned payout.
// Never use the property's current owner for historical financial access.
function ledger(tx) {
  return tx`SELECT pa.id,pa.booking_id,pa.component,pa.actual_minor::text,pa.simulated_minor::text,pa.created_at,
    b.order_id,b.reference,b.rentable_id,b.state booking_state,b.amount_rent_minor::text quote_rent_minor,
    bo.listing_snapshot->>'title' title, r.client_id current_owner_id,
    CASE WHEN p.client_id IS NOT NULL AND bo.listing_snapshot->>'ownerId' IS NOT NULL AND p.client_id::text<>bo.listing_snapshot->>'ownerId' THEN NULL
      ELSE coalesce(bo.listing_snapshot->>'ownerId',p.client_id::text) END owner_id,
    CASE WHEN t.kind='simulated' AND t.mode='simulated' THEN 'simulated'
      WHEN t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL AND t.mode='real' AND t.environment='test' THEN 'test'
      WHEN live.id IS NOT NULL THEN 'live' ELSE 'legacy_unknown' END environment,
    po.id payment_order_id, t.reference transaction_reference,
    coalesce(ref.refunded,0)::text refunded_minor,coalesce(ref.pending,0)::text refund_pending_minor,
    coalesce(ref.history,'[]'::jsonb) refunds,
    p.id payout_id,p.client_id payout_owner_id,p.status payout_status,p.actual_net_minor::text payout_minor,p.destination_id,
    p.utr,p.settled_at,p.created_at payout_created_at,
    d.version destination_version,d.state destination_state,d.method,d.account_last4,d.ifsc,d.upi_id,
    current_d.state current_destination_state, EXISTS(SELECT 1 FROM "user" u WHERE u.id::text=coalesce(bo.listing_snapshot->>'ownerId',p.client_id::text) AND u.role='client' AND u.account_status='active') owner_active
  FROM payment_allocation pa JOIN payment_transaction t ON t.id=pa.transaction_id
    JOIN payment_attempt at ON at.id=t.attempt_id JOIN payment_order po ON po.id=at.payment_order_id
    JOIN booking b ON b.id=pa.booking_id JOIN booking_order bo ON bo.id=b.order_id
    JOIN rentable r ON r.id=b.rentable_id
    LEFT JOIN captured_payment_allocation live ON live.id=pa.id
    LEFT JOIN payout p ON p.funding_allocation_id=pa.id
    LEFT JOIN payout_destination d ON d.id=p.destination_id
    LEFT JOIN LATERAL (SELECT state FROM payout_destination WHERE client_id::text=coalesce(bo.listing_snapshot->>'ownerId',p.client_id::text)
      AND state IN ('submitted','verified') ORDER BY version DESC LIMIT 1) current_d ON true
    LEFT JOIN LATERAL (SELECT sum(ra.actual_minor) FILTER(WHERE rf.state='succeeded') refunded,
      sum(ra.expected_minor) FILTER(WHERE rf.state IN ('requested','processing','unknown')) pending,
      jsonb_agg(jsonb_build_object('id',rf.id,'state',rf.state,'expectedMinor',ra.expected_minor::text,'actualMinor',ra.actual_minor::text,'createdAt',rf.created_at) ORDER BY rf.created_at,rf.id) history
      FROM refund_allocation ra JOIN refund rf ON rf.id=ra.refund_id WHERE ra.payment_allocation_id=pa.id) ref ON true`;
}
const keys = [
  'quotedRentMinor',
  'collectedMinor',
  'simulatedMinor',
  'refundedMinor',
  'rentNetMinor',
  'refundPendingMinor',
  'pendingMinor',
  'eligibleMinor',
  'heldMinor',
  'settledMinor',
];
function allocation(row, actor) {
  const cash = amount(row.actual_minor),
    refund = amount(row.refunded_minor),
    refundPending = amount(row.refund_pending_minor);
  const funded = amount(row.payout_minor),
    reserved = row.payout_status && row.payout_status !== 'failed' ? funded : 0n;
  const liveRent = row.environment === 'live' && row.component === 'rent';
  const residual = cash - refund - refundPending - reserved;
  const remaining = residual > 0n ? residual : 0n;
  let pending = 0n,
    eligible = 0n,
    held = 0n,
    settled = 0n;
  const reasons = [];
  if (liveRent) {
    if (row.payout_status === 'paid') settled = funded;
    else if (
      row.payout_status === 'frozen' ||
      (['pending', 'processing'].includes(row.payout_status) &&
        row.destination_state !== 'verified')
    )
      held += funded;
    else if (['pending', 'processing'].includes(row.payout_status)) pending += funded;
    if (row.booking_state !== 'completed') {
      pending += remaining;
      if (remaining) reasons.push('Visit not completed; no payout eligibility.');
    } else if (!row.owner_id || !row.owner_active || row.current_destination_state !== 'verified') {
      held += remaining;
      if (remaining)
        reasons.push('Historical owner attribution or verified destination is unavailable.');
    } else eligible = remaining;
    if (refundPending) reasons.push('An outstanding refund reserves funds.');
    if (row.payout_status === 'frozen') reasons.push('The recorded payout is frozen.');
    if (row.payout_status === 'failed')
      reasons.push('The recorded payout failed; no automatic retry is available.');
  } else reasons.push('This allocation does not establish live owner payout eligibility.');
  if (row.payout_id && row.destination_state !== 'verified')
    reasons.push(
      'The pinned destination is not currently verified; a newer destination does not redirect this obligation.',
    );
  return {
    id: row.id,
    bookingId: row.booking_id,
    orderId: row.order_id,
    reference: row.reference,
    propertyId: row.rentable_id,
    title: row.title || 'Booked property',
    ownerId: row.owner_id,
    attribution: row.owner_id ? 'recorded' : 'unresolved',
    environment: row.environment,
    component: row.component,
    bookingState: row.booking_state,
    createdAt: iso(row.created_at),
    paymentOrderId: actor.kind === 'admin' ? row.payment_order_id : null,
    bookingLinkAvailable: actor.kind === 'admin' || row.current_owner_id === actor.id,
    quoteRentMinor: row.quote_rent_minor,
    collectedMinor: row.actual_minor,
    simulatedMinor: row.simulated_minor,
    refundedMinor: row.refunded_minor,
    rentNetMinor: (liveRent ? cash - refund : 0n).toString(),
    refundPendingMinor: (liveRent ? refundPending : 0n).toString(),
    pendingMinor: pending.toString(),
    eligibleMinor: eligible.toString(),
    heldMinor: held.toString(),
    settledMinor: settled.toString(),
    refunds: row.refunds,
    reasons,
    payout: row.payout_id
      ? {
          id: row.payout_id,
          status: row.payout_status,
          amountMinor: row.payout_minor,
          destination: row.destination_id
            ? {
                id: row.destination_id,
                version: row.destination_version,
                state: row.destination_state,
                masked: maskedDestination(row),
              }
            : null,
          utr: row.utr,
          settledAt: iso(row.settled_at),
        }
      : null,
  };
}
async function readStatement(tx, actor, filters) {
  await authorize(tx, actor);
  if (actor.kind === 'owner' && filters.ownerId && filters.ownerId !== actor.id) throw notFound();
  const owner = actor.kind === 'owner' ? actor.id : filters.ownerId;
  const start = `${filters.period}-01T00:00:00Z`;
  const rows =
    await tx`SELECT l.* FROM (${ledger(tx)}) l WHERE l.created_at>=${start}::timestamptz AND l.created_at<${start}::timestamptz+interval '1 month'
    AND l.environment=${filters.environment} AND (${owner}='' OR l.owner_id=${owner})
    AND (${filters.propertyId}='' OR l.rentable_id::text=${filters.propertyId}) ORDER BY l.created_at DESC,l.id LIMIT 1001`;
  if (rows.length > 1000)
    throw badRequest(
      'STATEMENT_TOO_LARGE',
      'Choose one property or owner; this statement exceeds 1,000 allocations.',
    );
  const properties =
    await tx`SELECT DISTINCT l.rentable_id id,l.title FROM (${ledger(tx)}) l WHERE l.created_at>=${start}::timestamptz AND l.created_at<${start}::timestamptz+interval '1 month' AND l.environment=${filters.environment} AND (${owner}='' OR l.owner_id=${owner}) ORDER BY l.title,l.rentable_id LIMIT 1000`;
  const items = rows.map((r) => allocation(r, actor));
  const totals = Object.fromEntries(keys.map((k) => [k, 0n]));
  const visits = new Set();
  for (const item of items) {
    for (const k of keys) if (k !== 'quotedRentMinor') totals[k] += amount(item[k]);
    if (!visits.has(item.bookingId)) {
      totals.quotedRentMinor += amount(item.quoteRentMinor);
      visits.add(item.bookingId);
    }
  }
  return {
    filters,
    properties,
    asOf: new Date().toISOString(),
    currency: 'INR',
    basis:
      'Allocations received in this UTC month, with their current refund and payout outcomes. This is a current receipt-cohort statement, not a historical cash-flow or tax statement.',
    disbursementAvailable: false,
    settlementNotice:
      'Live payout execution and bank verification are unavailable. Accounting eligibility does not initiate a transfer.',
    attributionNotice:
      'Historical records without an immutable owner snapshot or funded payout owner are visible only to finance administrators. Current property ownership is never used to assign past receipts.',
    adjustmentNotice:
      'Refund allocations are the supported adjustments. No manual adjustment ledger or tax calculation is available.',
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])),
    count: items.length,
    items,
  };
}
export async function financeStatement(database, actor, query = {}) {
  const filters = statementFilters(query);
  return database.begin('isolation level repeatable read read only', (tx) =>
    readStatement(tx, actor, filters),
  );
}
export async function financeAllocation(database, actor, id) {
  if (!uuid.safeParse(id).success) throw notFound();
  return database.begin('isolation level repeatable read read only', async (tx) => {
    await authorize(tx, actor);
    const [row] =
      await tx`SELECT l.* FROM (${ledger(tx)}) l WHERE l.id=${id} AND (${actor.kind === 'admin'} OR l.owner_id=${actor.id})`;
    if (!row) throw notFound();
    return allocation(row, actor);
  });
}
export async function financePayouts(database, actor, query = {}) {
  const filters = statementFilters(query);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    await authorize(tx, actor);
    if (actor.kind === 'owner' && filters.ownerId && filters.ownerId !== actor.id) throw notFound();
    const owner = actor.kind === 'owner' ? actor.id : filters.ownerId;
    const start = `${filters.period}-01T00:00:00Z`;
    const rows = await tx`SELECT p.id FROM payout p JOIN booking b ON b.id=p.booking_id
      WHERE (${owner}='' OR p.client_id::text=${owner}) AND (${filters.propertyId}='' OR b.rentable_id::text=${filters.propertyId})
      AND p.created_at>=${start}::timestamptz AND p.created_at<${start}::timestamptz+interval '1 month'
      AND (${filters.environment}='legacy_unknown' AND NOT EXISTS(SELECT 1 FROM captured_payment_allocation c WHERE c.id=p.funding_allocation_id) OR ${filters.environment}='live' AND EXISTS(SELECT 1 FROM captured_payment_allocation c WHERE c.id=p.funding_allocation_id))
      ORDER BY p.created_at DESC,p.id LIMIT 1001`;
    if (rows.length > 1000)
      throw badRequest(
        'STATEMENT_TOO_LARGE',
        'Choose one property or owner; more than 1,000 payouts match.',
      );
    const items = await payoutDetails(
      tx,
      actor,
      rows.map((row) => row.id),
    );
    const properties =
      await tx`SELECT DISTINCT b.rentable_id id, coalesce(bo.listing_snapshot->>'title','Historical property') title FROM payout p JOIN booking b ON b.id=p.booking_id JOIN booking_order bo ON bo.id=b.order_id WHERE (${owner}='' OR p.client_id::text=${owner}) ORDER BY title,id LIMIT 1000`;
    return {
      filters,
      properties,
      count: items.length,
      items,
      totalMinor: items.reduce((sum, p) => sum + amount(p.amountMinor), 0n).toString(),
      disbursementAvailable: false,
    };
  });
}
async function payoutDetails(tx, actor, ids) {
  if (!ids.length) return [];
  const rows =
    await tx`SELECT p.*,b.order_id,b.reference,r.client_id current_owner_id,coalesce(bo.listing_snapshot->>'title','Historical property') title,
    d.version destination_version,d.state destination_state,d.method,d.account_last4,d.ifsc,d.upi_id,
    EXISTS(SELECT 1 FROM captured_payment_allocation c WHERE c.id=p.funding_allocation_id) live
    FROM payout p JOIN booking b ON b.id=p.booking_id LEFT JOIN booking_order bo ON bo.id=b.order_id JOIN rentable r ON r.id=b.rentable_id
    LEFT JOIN payout_destination d ON d.id=p.destination_id WHERE p.id=ANY(${ids}::uuid[]) AND (${actor.kind === 'admin'} OR p.client_id=${actor.id}) ORDER BY p.created_at DESC,p.id`;
  return rows.map((p) => ({
    id: p.id,
    ownerId: p.client_id,
    orderId: p.order_id,
    bookingId: p.booking_id,
    reference: p.reference,
    title: p.title || 'Booked property',
    bookingLinkAvailable:
      Boolean(p.order_id) && (actor.kind === 'admin' || p.current_owner_id === actor.id),
    allocationId: p.funding_allocation_id,
    environment: p.live ? 'live' : 'legacy_unknown',
    status: p.status,
    amountMinor: p.live ? String(p.actual_net_minor) : '0',
    legacyQuote: {
      grossRupees: Number(p.gross_minor) / 100,
      commissionRupees: Number(p.commission_minor) / 100,
      tdsRupees: Number(p.tds_194o_minor) / 100,
      gstTcsRupees: Number(p.gst_tcs_minor) / 100,
      netRupees: Number(p.net_minor) / 100,
    },
    deductionNotice:
      'Legacy gross, commission and tax fields are quoted rupee values; they are not proof of collection or verified deductions from the funded amount.',
    destination: p.destination_id
      ? {
          id: p.destination_id,
          version: p.destination_version,
          state: p.destination_state,
          masked: maskedDestination(p),
        }
      : null,
    utr: p.utr,
    settledAt: iso(p.settled_at),
    createdAt: iso(p.created_at),
    disbursementAvailable: false,
    recovery:
      p.status === 'failed'
        ? 'Finance review required; no automatic retry is available.'
        : p.status === 'frozen'
          ? 'Finance review required for this recorded hold.'
          : null,
  }));
}
export async function financePayout(database, actor, id) {
  if (!uuid.safeParse(id).success) throw notFound();
  return database.begin('isolation level repeatable read read only', async (tx) => {
    await authorize(tx, actor);
    const [payout] = await payoutDetails(tx, actor, [id]);
    if (!payout) throw notFound();
    return payout;
  });
}
export async function financeCsv(database, actor, query) {
  const filters = statementFilters(query);
  return database.begin('isolation level repeatable read', async (tx) => {
    const s = await readStatement(tx, actor, filters);
    const fields = [
      'id',
      'bookingId',
      'reference',
      'propertyId',
      'ownerId',
      'environment',
      'component',
      'createdAt',
      ...keys.filter((k) => k !== 'quotedRentMinor'),
    ];
    const cell = (v) =>
      '"' +
      String(v ?? '')
        .replace(/^(?:\s*[=+@-]|[\t\r\n])/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const csv =
      [
        ['Statement period', filters.period],
        ['As of', s.asOf],
        ['Basis', s.basis],
        ['Currency', 'INR'],
        ['Settlement', s.settlementNotice],
        ['Totals', ...keys],
        ['', ...keys.map((k) => s.totals[k])],
        fields,
        ...s.items.map((r) => fields.map((k) => r[k])),
      ]
        .map((row) => row.map(cell).join(','))
        .join('\r\n') + '\r\n';
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES (${actor.kind === 'admin' ? 'admin' : 'client'},${actor.id},'finance_statement',${filters.period},'finance_statement_downloaded',${JSON.stringify({ filters, count: s.count })}::text::jsonb)`;
    return csv;
  });
}
