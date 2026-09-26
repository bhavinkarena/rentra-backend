import 'server-only';

import { addLocalDays, intervalsOverlap, isLocalDate, propertyToday, visitInterval } from '../domain/booking-dates.js';

const lockContexts = new WeakMap();
const ACTIVE_BOOKINGS = ['requested', 'confirmed', 'handed_over', 'returned', 'disputed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InventoryError extends Error {
  constructor(code, message, conflicts = []) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.conflicts = conflicts;
  }
}

function assertId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InventoryError('INVALID_INPUT', 'Invalid inventory reference.');
}

function contextFor(tx, rentableId) {
  const context = lockContexts.get(tx);
  if (!context || context.rentableId !== rentableId) {
    throw new InventoryError('INVENTORY_LOCK_REQUIRED', 'Inventory must be accessed under its listing lock.');
  }
  return context;
}

function instant(value) {
  const result = new Date(value);
  if (value == null || !Number.isFinite(result.getTime())) throw new InventoryError('INVALID_INPUT', 'Invalid inventory time.');
  return result;
}

function sameInstant(left, right) {
  return left != null && right != null && new Date(left).getTime() === new Date(right).getTime();
}

function occupied(row) {
  return { blockedStartAt: row.blocked_start_at, blockedEndAt: row.blocked_end_at };
}

/**
 * Every inventory writer starts here. The no-op UPDATE takes the listing mutex
 * and changes its row version: repeatable-read callers cannot proceed with a
 * snapshot from before a concurrent writer. Retry the entire transaction on
 * SQLSTATE 40001/40P01. Never perform provider calls inside this callback.
 *
 * Locks: listing -> orders sorted by ID -> visits -> reservations sorted by ID.
 * Locking all current rows for this one exclusive property keeps expiry of
 * other orders in the same order as cancellation and future confirmation.
 */
export async function withListingInventory(database, rentableId, run) {
  assertId(rentableId);
  // A calendar preview/confirmation already owns this mutex and transaction.
  // Reuse it without an inner retry loop: serialization retries belong to the
  // outer transaction, never to an already-aborted PostgreSQL transaction.
  if (database.inventoryTransaction) {
    const { transaction, listing } = database.inventoryTransaction;
    contextFor(transaction, rentableId);
    if (listing.id !== rentableId) throw new InventoryError('INVENTORY_LOCK_REQUIRED', 'Inventory scope mismatch.');
    return run(transaction, listing);
  }
  for (let attempt = 0; ; attempt += 1) {
    try { return await database.begin(async (tx) => {
    const [listing] = await tx`UPDATE rentable SET updated_at = updated_at WHERE id = ${rentableId} RETURNING *`;
    if (!listing) throw new InventoryError('NOT_FOUND', 'Listing unavailable.');
    await tx`SELECT id FROM booking_order WHERE rentable_id = ${rentableId} ORDER BY id FOR UPDATE`;
    await tx`SELECT id FROM booking WHERE rentable_id = ${rentableId} ORDER BY id FOR UPDATE`;
    await tx`SELECT id FROM inventory_reservation WHERE rentable_id = ${rentableId} ORDER BY id FOR UPDATE`;
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    lockContexts.set(tx, { rentableId, now: instant(now) });
    try {
      return await run(tx, listing);
    } finally {
      lockContexts.delete(tx);
    }
    }); } catch (error) {
      if (!['40001', '40P01'].includes(error.code) || attempt >= 2) throw error;
    }
  }
}

/**
 * Public calendar reads only. A read-only repeatable-read snapshot: no listing
 * mutex, no row locks and no writes, so browsing never queues behind checkout
 * or other viewers. Expired holds are treated as free instead of being expired
 * here; writers still expire them under withListingInventory.
 */
export async function withListingSnapshot(database, rentableId, run) {
  assertId(rentableId);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const [row] = await tx`SELECT *, clock_timestamp() AS inventory_now FROM rentable WHERE id = ${rentableId}`;
    if (!row) throw new InventoryError('NOT_FOUND', 'Listing unavailable.');
    const { inventory_now: now, ...listing } = row;
    lockContexts.set(tx, { rentableId, now: instant(now), readOnly: true });
    try {
      return await run(tx, listing);
    } finally {
      lockContexts.delete(tx);
    }
  });
}

/** What expireInventoryHolds would release, applied to a read-only snapshot. */
function withoutExpiredHolds(state, now) {
  const expired = (at) => at != null && instant(at) <= now;
  const bookings = state.bookings.filter(
    (booking) => !(booking.state === 'requested' && booking.order_state === 'held' && expired(booking.order_hold_expires_at)),
  );
  const reservations = state.reservations.filter(
    (row) => !(row.source === 'booking' && row.state === 'held' && !bookings.some((booking) => booking.id === row.booking_id)),
  );
  return { ...state, bookings, reservations };
}

/** Release expired holds once; payment settlement/reconciliation is independent. */
export async function expireInventoryHolds(tx, rentableId, now) {
  const context = contextFor(tx, rentableId);
  const clock = instant(now ?? context.now);
  const stale = await tx`SELECT id FROM booking_order WHERE rentable_id = ${rentableId}
    AND state = 'held' AND hold_expires_at <= ${clock.toISOString()} ORDER BY id`;
  if (!stale.length) return { ordersExpired: 0, reservationsExpired: 0 };
  const ids = stale.map((order) => order.id);
  const incompatible = await tx`SELECT id FROM booking WHERE order_id IN ${tx(ids)}
    AND state NOT IN ('requested', 'cancelled') LIMIT 1`;
  if (incompatible.length) throw new InventoryError('INVENTORY_REMEDIATION_REQUIRED', 'An expired hold has an inconsistent visit state.');
  const orders = await tx`UPDATE booking_order SET state = 'expired', updated_at = ${clock.toISOString()}
    WHERE id IN ${tx(ids)} AND state = 'held' AND hold_expires_at <= ${clock.toISOString()} RETURNING id`;
  const expiredIds = orders.map((order) => order.id);
  if (!expiredIds.length) return { ordersExpired: 0, reservationsExpired: 0 };
  const reservations = await tx`UPDATE inventory_reservation r SET state = 'expired', released_at = ${clock.toISOString()}
    FROM booking b WHERE r.booking_id = b.id AND b.order_id IN ${tx(expiredIds)}
    AND r.rentable_id = ${rentableId} AND r.source = 'booking' AND r.state = 'held'
    RETURNING r.id`;
  await tx`UPDATE booking SET state = 'cancelled', cancelled_at = ${clock.toISOString()},
    cancellation_reason = 'Inventory hold expired', lifecycle_version = lifecycle_version + 1, updated_at = ${clock.toISOString()}
    WHERE order_id IN ${tx(expiredIds)} AND state = 'requested'`;
  await tx`INSERT INTO booking_lifecycle_event(order_id,kind,payload)
    SELECT b.id,'expired','{"environment":"test"}'::jsonb FROM booking_order b
    WHERE b.id IN ${tx(expiredIds)} AND EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=b.id)
    ON CONFLICT(order_id,kind) DO NOTHING`;
  // Do not infer refunds, successful payments or actual collection from expiry.
  return { ordersExpired: orders.length, reservationsExpired: reservations.length };
}

/** Internal-only rows; never serialize this state into public API responses. */
export async function getInventoryState(tx, listing) {
  contextFor(tx, listing.id);
  // Completion retains the paid interval. Include its visit while that ledger
  // entry remains active, without requiring inventory for old completed history.
  const [state] = await tx`SELECT
    COALESCE((SELECT json_agg(b ORDER BY b.id) FROM (
      SELECT b.id, b.order_id, b.state, b.hours_known, b.units_booked,
        b.starts_at, b.ends_at, b.blocked_start_at, b.blocked_end_at,
        o.state AS order_state, o.hold_expires_at AS order_hold_expires_at
      FROM booking b LEFT JOIN booking_order o ON o.id = b.order_id
      WHERE b.rentable_id = ${listing.id} AND (b.state IN ${tx(ACTIVE_BOOKINGS)}
        OR (b.state='completed' AND EXISTS(SELECT 1 FROM inventory_reservation r
          WHERE r.booking_id=b.id AND r.source='booking' AND r.state IN ('held','committed'))))
    ) b), '[]'::json) AS bookings,
    COALESCE((SELECT json_agg(r ORDER BY r.id) FROM (
      SELECT * FROM inventory_reservation WHERE rentable_id = ${listing.id}
        AND state IN ('held', 'committed')
    ) r), '[]'::json) AS reservations,
    COALESCE((SELECT json_agg(a ORDER BY a.day,a.slot) FROM (
      SELECT day::text AS day, slot, units_available, blocked_by_client, price_override
      FROM availability WHERE rentable_id = ${listing.id}
    ) a), '[]'::json) AS availability`;
  return state;
}

function legacyOwnerIntervals(listing, rows, now) {
  const intervals = [];
  const today = propertyToday(now);
  for (const row of rows) {
    if (!row.blocked_by_client && row.units_available > 0) continue;
    const schedule = listing.booking_config?.slots?.[row.slot];
    try {
      // Disabling sales of a configured slot does not erase its owner block.
      const interval = visitInterval({ date: row.day, slot: row.slot, schedule: schedule && { ...schedule, enabled: true } });
      if (instant(interval.blockedEndAt) > now) intervals.push({ ...interval, ownerBlocked: row.blocked_by_client });
    } catch {
      // An old, undated-in-hours owner row is not a permanent global block.
      // Keep a conservative two-day tail for overnight access/turnover; current
      // and future unknown windows still require explicit remediation.
      if (row.day >= addLocalDays(today, -2)) {
        throw new InventoryError('INVENTORY_REMEDIATION_REQUIRED', 'An owner block needs explicit slot hours.');
      }
    }
  }
  return intervals;
}

/** Can run before inventoryReady is enabled; no missing history is inferred away. */
export async function auditInventoryReadiness(tx, listing, state) {
  const context = contextFor(tx, listing.id);
  if (listing.total_units !== 1) throw new InventoryError('UNSUPPORTED_INVENTORY', 'Only exclusive single-property inventory is supported.');
  const current = state ?? await getInventoryState(tx, listing);
  for (const booking of current.bookings) {
    const matching = current.reservations.filter((row) => row.booking_id === booking.id && row.source === 'booking');
    const reservation = matching[0];
    if (!booking.hours_known || booking.units_booked !== 1 || matching.length !== 1
      || !sameInstant(booking.blocked_start_at, reservation?.blocked_start_at)
      || !sameInstant(booking.blocked_end_at, reservation?.blocked_end_at)
      || (reservation?.state === 'committed' && booking.state === 'requested')
      || (reservation?.state === 'held' && (!booking.order_id || booking.order_state !== 'held'
        || booking.state !== 'requested' || !sameInstant(reservation.hold_expires_at, booking.order_hold_expires_at)))) {
      throw new InventoryError('INVENTORY_REMEDIATION_REQUIRED', 'Active booking inventory needs reconciliation.');
    }
  }
  for (const reservation of current.reservations) {
    if (reservation.source === 'booking' && !current.bookings.some((booking) => booking.id === reservation.booking_id)) {
      throw new InventoryError('INVENTORY_REMEDIATION_REQUIRED', 'A reservation needs reconciliation with its visit.');
    }
    if (reservation.source === 'owner_block' && reservation.state !== 'committed') {
      throw new InventoryError('INVENTORY_REMEDIATION_REQUIRED', 'An owner block has an invalid state.');
    }
  }
  legacyOwnerIntervals(listing, current.availability, context.now);
  return { ready: true };
}

function validateVisits(visits) {
  if (!Array.isArray(visits) || !visits.length || visits.length > 10) throw new InventoryError('INVALID_INPUT', 'Choose 1–10 visits.');
  for (const visit of visits) {
    if (!isLocalDate(visit.date) || !['day', 'night', 'full_day'].includes(visit.slot)) {
      throw new InventoryError('INVALID_INPUT', 'Invalid visit selection.');
    }
    const start = instant(visit.startsAt);
    const end = instant(visit.endsAt);
    const blockedStart = instant(visit.blockedStartAt);
    const blockedEnd = instant(visit.blockedEndAt);
    if (start >= end || blockedStart > start || blockedEnd < end) throw new InventoryError('INVALID_INPUT', 'Invalid visit interval.');
  }
}

/** Advisory until a writer inserts every reservation in this same transaction. */
export async function findInventoryConflicts(tx, listing, visits) {
  const check = await prepareInventoryCheck(tx, listing);
  return check(visits);
}

/** Load once for an entire calendar; the snapshot stays protected by the mutex. */
export async function prepareInventoryCheck(tx, listing) {
  const context = contextFor(tx, listing.id);
  if (listing.booking_config?.inventoryReady !== true) {
    throw new InventoryError('INVENTORY_NOT_READY', 'This listing is awaiting inventory setup.');
  }
  let state;
  if (context.readOnly) {
    state = withoutExpiredHolds(await getInventoryState(tx, listing), context.now);
  } else {
    await expireInventoryHolds(tx, listing.id);
    state = await getInventoryState(tx, listing);
  }
  await auditInventoryReadiness(tx, listing, state);
  const ownerIntervals = legacyOwnerIntervals(listing, state.availability, context.now);
  return (visits) => {
  contextFor(tx, listing.id);
  validateVisits(visits);
  const conflicts = [];
  for (let index = 0; index < visits.length; index += 1) {
    const visit = visits[index];
    let code;
    const halves = visit.slot === 'full_day' ? ['day', 'night'] : [visit.slot];
    const rows = halves.map((slot) => state.availability.find((row) => row.day === visit.date && row.slot === slot));
    if (rows.some((row) => !row)) code = 'INVENTORY_MISSING';
    else if (rows.some((row) => row.units_available <= 0)) code = 'INVENTORY_UNAVAILABLE';
    if (ownerIntervals.some((interval) => !interval.ownerBlocked && intervalsOverlap(visit, interval))) code = 'INVENTORY_UNAVAILABLE';
    if (ownerIntervals.some((interval) => interval.ownerBlocked && intervalsOverlap(visit, interval))
      || state.reservations.some((row) => row.source === 'owner_block' && intervalsOverlap(visit, occupied(row)))) code = 'OWNER_BLOCKED';
    else if (state.reservations.some((row) => row.source === 'booking' && intervalsOverlap(visit, occupied(row)))) code = 'INVENTORY_UNAVAILABLE';
    if (visits.some((other, otherIndex) => otherIndex !== index && intervalsOverlap(visit, other))) code = 'VISITS_OVERLAP';
    if (code) conflicts.push({ date: visit.date, slot: visit.slot, code });
  }
  return conflicts;
  };
}

async function requireListingOwner(tx, listing, ownerId) {
  assertId(ownerId);
  const [owner] = await tx`SELECT id FROM "user" WHERE id = ${ownerId} AND role = 'client' AND account_status = 'active' FOR SHARE`;
  if (!owner || listing.client_id !== ownerId) throw new InventoryError('FORBIDDEN', 'Listing access unavailable.');
}

/** Owner blocks share the ledger/exclusion constraint with customer bookings. */
export async function createOwnerBlock(database, ownerId, { rentableId, blockedStartAt, blockedEndAt, reason }) {
  const start = instant(blockedStartAt);
  const end = instant(blockedEndAt);
  if (start >= end || typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    throw new InventoryError('INVALID_INPUT', 'Choose a valid interval and a reason of 3–500 characters.');
  }
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await requireListingOwner(tx, listing, ownerId);
    await expireInventoryHolds(tx, listing.id);
    const state = await getInventoryState(tx, listing);
    await auditInventoryReadiness(tx, listing, state);
    const interval = { blockedStartAt: start, blockedEndAt: end };
    if (state.reservations.some((row) => intervalsOverlap(interval, occupied(row)))) {
      throw new InventoryError('INVENTORY_CONFLICT', 'That interval already has a reservation or owner block.');
    }
    const [block] = await tx`INSERT INTO inventory_reservation
      (rentable_id, source, blocked_start_at, blocked_end_at, state, created_by, reason)
      VALUES (${rentableId}, 'owner_block', ${start.toISOString()}, ${end.toISOString()}, 'committed', ${ownerId}, ${reason.trim()}) RETURNING *`;
    await tx`INSERT INTO audit_log (actor_type, actor_id, entity, entity_id, action, "after", reason)
      VALUES ('client', ${ownerId}, 'inventory_reservation', ${block.id}, 'owner_block_created',
        ${JSON.stringify({ rentableId, blockedStartAt: start.toISOString(), blockedEndAt: end.toISOString() })}::jsonb, ${reason.trim()})`;
    return { id: block.id, blockedStartAt: start.toISOString(), blockedEndAt: end.toISOString(), state: block.state };
  });
}

export async function releaseOwnerBlock(database, ownerId, { rentableId, blockId }) {
  assertId(blockId);
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await requireListingOwner(tx, listing, ownerId);
    const [block] = await tx`SELECT * FROM inventory_reservation WHERE id = ${blockId}
      AND rentable_id = ${rentableId} AND source = 'owner_block'`;
    if (!block) throw new InventoryError('NOT_FOUND', 'Owner block unavailable.');
    if (block.state === 'released') return { id: block.id, state: 'released', changed: false };
    if (block.state !== 'committed') throw new InventoryError('INVENTORY_REMEDIATION_REQUIRED', 'Owner block needs reconciliation.');
    const { now } = contextFor(tx, rentableId);
    await tx`UPDATE inventory_reservation SET state = 'released', released_at = ${now.toISOString()}
      WHERE id = ${blockId} AND state = 'committed'`;
    await tx`INSERT INTO audit_log (actor_type, actor_id, entity, entity_id, action)
      VALUES ('client', ${ownerId}, 'inventory_reservation', ${blockId}, 'owner_block_released')`;
    return { id: block.id, state: 'released', changed: true };
  });
}
