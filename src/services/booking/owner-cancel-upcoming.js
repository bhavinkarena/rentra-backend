import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { withListingInventory, withListingSnapshot } from './inventory.js';
import { applyCancellation, allocateRefund, capturedAllocations, testSourcesOnly } from './cancellation.js';
import { lifecycle } from './checkout.js';
import { quoteDigest } from './quotes.js';
import { releaseHotelRooms } from './hotel-stays.js';

/**
 * Story 2.15 (FR-6): the owner pauses the property and cancels every upcoming
 * stay, without prior admin approval (user decisions 28 Oct 2026: always
 * pauses, all upcoming stays, reason required and shown to guests).
 *
 * Upcoming means a confirmed visit whose booked check-in instant (derived from
 * the property timezone) is strictly in the future; stays at or past check-in
 * are excluded. Each guest gets back everything still unrefunded from what was
 * actually paid (rent, Rentra fee, tax, extras): earlier and reserved refunds
 * count toward it. Unpaid requests and holds are released without a refund.
 * Every order is cancelled in its own transaction so each booking reports its
 * own outcome; one failure never undoes another booking's cancellation.
 */

const sum = (rows, pick) => rows.reduce((total, row) => total + Number(pick(row)), 0);

/** Everything paid, per component: the owner-cancellation entitlement (FR-6/FR-7). */
function fullPaidEntitlement(sources) {
  const by = (component) => sum(sources.filter((a) => a.component === component), (a) => a.actual_minor);
  return { rent: by('rent'), fee: by('fee'), tax: by('tax'), deposit: by('deposit') };
}

async function orderPlan(tx, orderId, visitIds, hoursKnown) {
  const sources = await capturedAllocations(tx, visitIds);
  const payouts = await tx`SELECT p.status::text AS status FROM payout p WHERE p.booking_id IN ${tx(visitIds)}`;
  const transfers = await tx`SELECT f.state FROM payout_transfer_fixture f JOIN payment_allocation a ON a.id=f.source_id
    WHERE a.booking_id IN ${tx(visitIds)}`;
  let blocked = null;
  if (!hoursKnown) blocked = 'HOURS_UNKNOWN';
  else if (!sources.length) blocked = 'PAYMENT_UNVERIFIED';
  else if (!testSourcesOnly(sources)) blocked = 'PAYMENT_UNSUPPORTED';
  const bookingOf = new Map(sources.map((a) => [a.id, a.booking_id]));
  const refunds = (blocked ? [] : allocateRefund(sources, fullPaidEntitlement(sources)))
    .map((r) => ({ ...r, bookingId: bookingOf.get(r.allocationId) }));
  return {
    orderId,
    visitIds,
    paidMinor: sum(sources, (a) => a.actual_minor),
    alreadyRefundedMinor: sum(sources, (a) => a.reserved),
    refundMinor: sum(refunds, (a) => a.amount),
    // Owner proceeds already moving: the guest is still refunded in full; recovery is FR-14.
    ownerPaidOut: payouts.some((p) => ['processing', 'paid'].includes(p.status))
      || transfers.some((t) => t.state !== 'reserved'),
    blocked,
    refunds,
  };
}

async function readPlan(tx, ownerId, rentableId) {
  const [listing] = await tx`SELECT id, client_id, status::text AS status, lifecycle_version FROM rentable WHERE id=${rentableId}`;
  if (!listing || listing.client_id !== ownerId) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
  const visits = await tx`SELECT b.id, b.order_id, o.reference, b.starts_at, b.hours_known, b.lifecycle_version
    FROM booking b JOIN booking_order o ON o.id=b.order_id
    WHERE b.rentable_id=${rentableId} AND b.state='confirmed' AND b.starts_at > clock_timestamp()
    ORDER BY b.starts_at, b.id`;
  const [{ started }] = await tx`SELECT count(*)::int AS started FROM booking
    WHERE rentable_id=${rentableId} AND state IN ('confirmed','handed_over') AND starts_at <= clock_timestamp() AND ends_at > clock_timestamp()`;
  // A request with no owner answer yet is declined; an instant or approved hold is cancelled. A hold
  // whose payment was already sent to the provider may still be captured, so Rentra handles it.
  const unpaid = await tx`SELECT o.id, o.reference, o.hold_expires_at,
      EXISTS(SELECT 1 FROM booking_lifecycle_event e WHERE e.order_id=o.id AND e.kind='approval_requested')
        AND NOT EXISTS(SELECT 1 FROM booking_lifecycle_event e WHERE e.order_id=o.id
          AND e.kind IN ('owner_approved','owner_declined')) AS awaiting_owner,
      EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution x ON x.payment_order_id=p.id
        WHERE p.booking_order_id=o.id AND x.state<>'ready') AS payment_in_flight
    FROM booking_order o
    WHERE o.rentable_id=${rentableId} AND o.state='held' AND o.hold_expires_at > clock_timestamp() ORDER BY o.hold_expires_at, o.id`;
  const byOrder = Map.groupBy(visits, (v) => v.order_id);
  const stays = [];
  for (const [orderId, rows] of byOrder) {
    const plan = await orderPlan(tx, orderId, rows.map((r) => r.id), rows.every((r) => r.hours_known));
    stays.push({
      ...plan,
      reference: rows[0].reference,
      startsAt: new Date(rows[0].starts_at).toISOString(),
      versions: rows.map((r) => r.lifecycle_version),
    });
  }
  const unpaidHolds = unpaid.map((o) => ({
    orderId: o.id,
    reference: o.reference,
    holdExpiresAt: new Date(o.hold_expires_at).toISOString(),
    awaitingOwner: o.awaiting_owner,
    paymentInFlight: o.payment_in_flight,
  }));
  const binding = {
    ownerId,
    rentableId,
    version: listing.lifecycle_version,
    stays: stays.map((s) => [s.orderId, s.visitIds, s.versions, s.refundMinor, s.blocked]),
    unpaid: unpaidHolds.map((u) => [u.orderId, u.paymentInFlight]),
  };
  return { listing, stays, unpaidHolds, startedExcluded: started, hash: quoteDigest(binding) };
}

const publicStay = ({ refunds: _refunds, versions: _versions, ...stay }) => stay;

/** Read-only preview of the cancel-upcoming choice. */
export async function previewOwnerCancelUpcoming(database, ownerId, rentableId) {
  z.string().uuid().parse(rentableId);
  return withListingSnapshot(database, rentableId, async (tx) => {
    const plan = await readPlan(tx, ownerId, rentableId);
    return {
      version: plan.listing.lifecycle_version,
      status: plan.listing.status,
      stays: plan.stays.map(publicStay),
      refundTotalMinor: sum(plan.stays.filter((s) => !s.blocked), (s) => s.refundMinor),
      unpaidHolds: plan.unpaidHolds,
      startedExcluded: plan.startedExcluded,
      hash: plan.hash,
    };
  });
}

const commandSchema = z.object({
  rentableId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVersion: z.coerce.number().int(),
  requestKey: z.string().uuid(),
  reason: z.string().trim().min(10, 'Tell guests why, in at least 10 characters.').max(500),
});

const fundsCap = (error) => /exceed available funds/i.test(error?.message ?? '');
// Serialization, deadlock and connection failures leave the booking unrecorded: a repeat of the same
// request finishes it. Every other failure is recorded as the booking's outcome.
const transient = (error) => /^(40001|40P01|08|57P|ECONN|ETIMEDOUT|CONNECT)/.test(String(error?.code ?? ''));

/**
 * One booking's change and its recorded outcome commit together, under the command row lock, so a
 * crash or a concurrent repeat never acts twice on a booking. Null when the outcome is already there.
 */
function step(database, command, item, run) {
  return withListingInventory(database, command.rentable_id, async (tx) => {
    const [row] = await tx`SELECT results FROM owner_cancel_upcoming WHERE id=${command.id} FOR UPDATE`;
    if (row.results.some((r) => r.orderId === item.orderId)) return null;
    const { awaitingOwner: _a, visitIds: _v, blocked: _b, ...base } = item;
    const result = { ...base, ...(await run(tx)) };
    await tx`UPDATE owner_cancel_upcoming SET results=results || ${JSON.stringify([result])}::text::jsonb WHERE id=${command.id}`;
    return result;
  });
}

/** Unpaid requests and holds: released, never refunded (no money was captured). */
async function releaseHold(tx, command, item) {
  const [order] = await tx`SELECT state::text AS state FROM booking_order WHERE id=${item.orderId}`;
  if (order?.state !== 'held') return { outcome: 'changed', refundMinor: 0 };
  const [inFlight] = await tx`SELECT 1 FROM payment_order p JOIN payment_execution x ON x.payment_order_id=p.id
    WHERE p.booking_order_id=${item.orderId} AND x.state<>'ready'`;
  if (inFlight) return { outcome: 'needs_rentra', code: 'PAYMENT_IN_FLIGHT', refundMinor: 0 };
  await tx`UPDATE booking_order SET state='expired', updated_at=clock_timestamp() WHERE id=${item.orderId}`;
  await tx`UPDATE inventory_reservation r SET state='expired', released_at=clock_timestamp() FROM booking b
    WHERE r.booking_id=b.id AND b.order_id=${item.orderId} AND r.state='held'`;
  const bookings = await tx`UPDATE booking SET state='cancelled', cancelled_at=clock_timestamp(), cancelled_by_kind='client',
      cancellation_reason=${command.reason}, lifecycle_version=lifecycle_version+1, updated_at=clock_timestamp()
    WHERE order_id=${item.orderId} AND state='requested' RETURNING id, slot::text AS slot`;
  for (const booking of bookings) if (booking.slot === 'stay') await releaseHotelRooms(tx, booking.id);
  // A pending request is declined ("Owner declined your request"); an instant or approved hold the guest
  // was about to pay gets the cancellation notice instead.
  const kind = item.awaitingOwner ? 'owner_declined' : 'cancel_' + randomUUID().replaceAll('-', '');
  await lifecycle(tx, item.orderId, kind, {
    reason: command.reason,
    ownerCancelUpcoming: command.id,
    visitIds: bookings.map((b) => b.id),
    refundIds: [],
  });
  return { outcome: 'released', refundMinor: 0 };
}

async function cancelStay(tx, command, item, requestHash) {
  if (item.blocked) return { outcome: 'needs_rentra', code: item.blocked, refundMinor: 0 };
  const [order] = await tx`SELECT * FROM booking_order WHERE id=${item.orderId}`;
  const live = await tx`SELECT id FROM booking WHERE id IN ${tx(item.visitIds)} AND state='confirmed' AND starts_at > clock_timestamp()`;
  if (live.length !== item.visitIds.length) return { outcome: 'changed', refundMinor: 0 };
  // Recomputed under the lock: a refund that landed since the preview reduces the amount, never duplicates it.
  const fresh = await orderPlan(tx, item.orderId, item.visitIds, true);
  if (fresh.blocked) return { outcome: 'needs_rentra', code: fresh.blocked, refundMinor: 0 };
  const preview = {
    orderId: item.orderId,
    visits: item.visitIds.map((id) => ({ id, refunds: fresh.refunds.filter((r) => r.bookingId === id) })),
    refundMinor: fresh.refundMinor,
    actualBankRefundMinor: 0,
  };
  const snapshot = await applyCancellation(tx, order, preview, { visitIds: item.visitIds }, {
    actorKind: 'client',
    reason: command.reason,
    refundReason: 'Owner cancelled upcoming stay',
    idempotencyKey: randomUUID(),
    requestHash,
    customerId: order.customer_id,
  });
  return { outcome: 'cancelled', refundMinor: fresh.refundMinor, refundIds: snapshot.refundIds };
}

/** Pause the property and cancel every upcoming stay, one order at a time. */
export async function ownerCancelUpcoming(database, ownerId, input) {
  const parsed = commandSchema.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(Object.fromEntries(parsed.error.issues.map((i) => [i.path[0] ?? '_', i.message])));
  const d = parsed.data;
  const requestHash = quoteDigest({ ownerId, rentableId: d.rentableId, hash: d.hash, reason: d.reason });

  // Claim the request and pause first. A repeat with the same key resumes the recorded command; any
  // request also finishes an unfinished earlier command first (its key may be lost with a reload).
  const command = await withListingInventory(database, d.rentableId, async (tx) => {
    const [previous] = await tx`SELECT id, rentable_id, request_hash, reason, planned FROM owner_cancel_upcoming
      WHERE owner_id=${ownerId} AND request_key=${d.requestKey}`;
    if (previous) {
      if (previous.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'This request key was used for a different request.');
      return { ...previous, replayed: true };
    }
    const plan = await readPlan(tx, ownerId, d.rentableId);
    const [unfinished] = await tx`SELECT id, rentable_id, request_hash, reason, planned FROM owner_cancel_upcoming
      WHERE rentable_id=${d.rentableId} AND completed_at IS NULL ORDER BY created_at LIMIT 1`;
    if (unfinished) return { ...unfinished, replayed: true };
    if (plan.listing.status !== 'live' && plan.listing.status !== 'paused')
      throw conflict('LISTING_UNAVAILABLE', 'This property cannot be changed by the owner right now.');
    if (plan.hash !== d.hash || plan.listing.lifecycle_version !== d.expectedVersion)
      throw conflict('CANCELLATION_CHANGED', 'Your bookings changed since this list was shown. Review the updated list and confirm again.');
    const [account] = await tx`SELECT 1 FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`;
    if (!account) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
    if (plan.listing.status === 'live') {
      await tx`UPDATE rentable SET status='paused', prior_status='live', paused_until=NULL, updated_at=now() WHERE id=${d.rentableId}`;
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
        VALUES ('client',${ownerId},'rentable',${d.rentableId},'listing_paused','{"status":"live"}'::jsonb,
          ${JSON.stringify({ status: 'paused', mode: 'cancel_upcoming' })}::text::jsonb)`;
    } else {
      // Cancelling stays pauses until the owner resumes: an earlier end date no longer applies.
      await tx`UPDATE rentable SET paused_until=NULL, updated_at=now() WHERE id=${d.rentableId} AND paused_until IS NOT NULL`;
    }
    const planned = [
      ...plan.unpaidHolds.map((h) => ({ orderId: h.orderId, reference: h.reference, kind: 'unpaid', awaitingOwner: h.awaitingOwner })),
      ...plan.stays.map((s) => ({
        orderId: s.orderId,
        reference: s.reference,
        kind: 'stay',
        visitIds: s.visitIds,
        blocked: s.blocked,
        ownerPaidOut: s.ownerPaidOut,
      })),
    ];
    const [row] = await tx`INSERT INTO owner_cancel_upcoming(owner_id,rentable_id,request_key,request_hash,reason,planned)
      VALUES (${ownerId},${d.rentableId},${d.requestKey},${requestHash},${d.reason},${JSON.stringify(planned)}::text::jsonb)
      RETURNING id, rentable_id, request_hash, reason, planned`;
    return row;
  });

  for (const item of command.planned) {
    const run = (tx) => (item.kind === 'unpaid' ? releaseHold(tx, command, item) : cancelStay(tx, command, item, command.request_hash));
    try {
      await step(database, command, item, run);
    } catch (error) {
      if (transient(error)) throw error;
      // The booking is untouched. Owner proceeds already funded from this payment make the database
      // refuse an over-refund; that stay goes to Rentra (recovery is FR-14), never silently half-done.
      const code = fundsCap(error) ? 'FUNDS_ALREADY_PAID_OUT' : error.code ?? 'CANCELLATION_FAILED';
      await step(database, command, item, async () =>
        code === 'CANCELLATION_CHANGED' ? { outcome: 'changed', refundMinor: 0 } : { outcome: 'needs_rentra', code, refundMinor: 0 });
    }
  }

  // The audit entry is written once, by whichever call records the last booking.
  return database.begin(async (tx) => {
    const [row] = await tx`SELECT results, completed_at FROM owner_cancel_upcoming WHERE id=${command.id} FOR UPDATE`;
    const results = command.planned.map((p) => row.results.find((r) => r.orderId === p.orderId));
    if (!row.completed_at) {
      await tx`UPDATE owner_cancel_upcoming SET completed_at=now() WHERE id=${command.id}`;
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after",reason)
        VALUES ('client',${ownerId},'rentable',${command.rentable_id},'owner_cancel_upcoming',
          ${JSON.stringify({ commandId: command.id, results: results.map(({ orderId, outcome, code, refundMinor }) => ({ orderId, outcome, code, refundMinor })) })}::text::jsonb,
          ${command.reason})`;
    }
    return { replayed: Boolean(command.replayed), results };
  });
}
