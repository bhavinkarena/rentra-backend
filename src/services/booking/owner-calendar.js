import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  withListingInventory,
  withListingSnapshot,
  getInventoryState,
  InventoryError,
} from './inventory.js';
import { addLocalDays, isLocalDate, propertyToday } from '../domain/booking-dates.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function calendarSnapshot(tx, listing) {
  const state = await getInventoryState(tx, listing);
  const overrides =
    await tx`SELECT day::text,slot,rent_minor FROM booking_price_override WHERE rentable_id=${listing.id} ORDER BY day,slot`;
  for (const row of state.availability) {
    if (
      row.price_override != null &&
      !overrides.some((o) => o.day === row.day && o.slot === row.slot)
    )
      overrides.push({
        day: row.day,
        slot: row.slot,
        rent_minor: Math.round(Number(row.price_override) * 100),
      });
  }
  return {
    ...state,
    overrides,
    version: digest([listing.booking_config_version, listing.content_version, state, overrides]),
  };
}

class PreviewRollback extends Error {
  constructor(result) {
    super('Calendar preview rollback');
    this.result = result;
  }
}

/** Run the SAME inventory command for preview, rolling back every write, including audits.
 * Confirmation rechecks the snapshot and exact input under the inventory mutex.
 * The adapter keeps the existing command's transaction inside this outer transaction.
 */
export async function calendarCommand(database, ownerId, input, run) {
  const { rentableId, expectedCalendarVersion, previewToken, preview, command, values } = input;
  try {
    return await withListingInventory(database, rentableId, async (tx, listing) => {
      if (listing.client_id !== ownerId)
        throw new InventoryError('NOT_FOUND', 'Property unavailable.');
      const before = await calendarSnapshot(tx, listing);
      if (!expectedCalendarVersion || expectedCalendarVersion !== before.version) {
        throw new InventoryError(
          'CALENDAR_CHANGED',
          'The calendar changed. Reload it and preview again.',
        );
      }
      const token = createHmac('sha256', process.env.SESSION_SECRET)
        .update(JSON.stringify([ownerId, rentableId, before.version, command, values]))
        .digest('hex');
      if (!preview && token !== previewToken)
        throw new InventoryError(
          'PREVIEW_REQUIRED',
          'Preview these exact changes before applying them.',
        );
      const affected = [];
      if (command === 'open') {
        for (let date = values.from; date <= values.to; date = addLocalDays(date, 1)) {
          for (const slot of ['day', 'night']) {
            const row = before.availability.find((r) => r.day === date && r.slot === slot);
            affected.push({
              date,
              slot,
              effect: row ? 'Preserved (already exists)' : 'Add open date',
            });
          }
        }
      }
      // Inner inventory command owns authorization, conflict checks and all domain writes.
      let result;
      try {
        result = await run({ inventoryTransaction: { transaction: tx, listing } });
      } catch (error) {
        if (error.code === 'INVENTORY_CONFLICT' && command === 'block') {
          const start = new Date(`${values.from}T${values.startTime}:00+05:30`);
          const end = new Date(`${values.to}T${values.endTime}:00+05:30`);
          error.conflicts = before.reservations
            .filter(
              (r) =>
                new Date(r.blocked_start_at) < end &&
                new Date(r.blocked_end_at) > start &&
                (r.state === 'committed' || new Date(r.hold_expires_at) > new Date()),
            )
            .map((r) => ({ source: r.source, from: r.blocked_start_at, to: r.blocked_end_at }));
        }
        throw error;
      }
      if (preview)
        throw new PreviewRollback({
          preview: {
            token,
            command,
            values,
            affected,
            result,
            semantics:
              'All changes apply together or none apply. Existing reservations are preserved.',
          },
        });
      return { ok: true, result };
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.result;
    throw error;
  }
}

export async function ownerPortfolioCalendar(database, ownerId, query = {}) {
  const from = query.from || propertyToday();
  const days = Number(query.days || 7);
  const page = Number(query.page || 1);
  if (
    !isLocalDate(from) ||
    ![7, 31].includes(days) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    (query.slot && !['day', 'night', 'full_day'].includes(query.slot))
  )
    throw new RangeError('Choose a valid date, view and slot.');
  if (query.property) z.string().uuid().parse(query.property);
  const to = addLocalDays(from, days);
  const properties = await database`SELECT id,title FROM rentable WHERE client_id=${ownerId}
    AND (${query.property || null}::uuid IS NULL OR id=${query.property || null}::uuid)
    ORDER BY title,id LIMIT 11 OFFSET ${(page - 1) * 10}`;
  const hasMore = properties.length > 10;
  const items = [];
  for (const property of properties.slice(0, 10)) {
    const item = await withListingSnapshot(database, property.id, async (tx, listing) => {
      if (listing.client_id !== ownerId) return null;
      const snapshot = await calendarSnapshot(tx, listing);
      const reservations =
        await tx`SELECT r.id,r.source,r.state,r.reason,r.blocked_start_at,r.blocked_end_at,r.hold_expires_at,
        b.order_id,b.slot,b.starts_at,b.ends_at
        FROM inventory_reservation r LEFT JOIN booking b ON b.id=r.booking_id
        WHERE r.rentable_id=${listing.id} AND (r.state='committed' OR (r.state='held' AND r.hold_expires_at>now()))
        AND r.blocked_start_at < (${to}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND r.blocked_end_at > (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        ORDER BY r.blocked_start_at,r.id`;
      return {
        id: listing.id,
        title: listing.title,
        version: snapshot.version,
        scheduleReady: listing.booking_config?.inventoryReady === true,
        unresolvedVisits: snapshot.bookings
          .filter((b) => !snapshot.reservations.some((r) => r.booking_id === b.id))
          .map((b) => ({ id: b.id, orderId: b.order_id, state: b.state })),
        availability: snapshot.availability.filter(
          (r) =>
            r.day >= from &&
            r.day < to &&
            (!query.slot || query.slot === 'full_day' || r.slot === query.slot),
        ),
        overrides: snapshot.overrides.filter(
          (r) => r.day >= from && r.day < to && (!query.slot || r.slot === query.slot),
        ),
        intervals: reservations.filter((r) => !query.slot || !r.slot || r.slot === query.slot),
      };
    });
    if (item) items.push(item);
  }
  return {
    from,
    to,
    days,
    page,
    hasMore,
    slot: query.slot || '',
    property: query.property || '',
    items,
  };
}
