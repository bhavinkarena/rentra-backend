import 'server-only';
import {calendarCells} from '../domain/owner-calendar.js';
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

export async function calendarSnapshot(tx, listing, window=null) {
  const state = await getInventoryState(tx, listing,window);
  const overrides =
    await tx`SELECT day::text,slot,rent_minor FROM booking_price_override WHERE rentable_id=${listing.id} AND (${window?.from||null}::timestamptz IS NULL OR day BETWEEN (${window?.from||null}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date AND (${window?.to||null}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date) ORDER BY day,slot`;
  const rates=await tx`SELECT slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${listing.id} ORDER BY slot`;
  return {
    ...state,
    overrides,
    version: digest([listing.booking_config, state, overrides,rates]),
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
      const [block]=command==='unblock'?await tx`SELECT blocked_start_at,blocked_end_at FROM inventory_reservation WHERE id=${values.blockId} AND rentable_id=${rentableId} AND source='owner_block'`:[];
      const dates=values.cells ? JSON.parse(values.cells).map(c=>c.date).sort() : [values.from||values.day||(values.blockedStartAt?propertyToday(values.blockedStartAt):block?propertyToday(block.blocked_start_at):null),values.to||values.day||(values.blockedEndAt?propertyToday(values.blockedEndAt):block?propertyToday(block.blocked_end_at):null)].filter(Boolean);
      const window=dates.length?{from:`${dates[0]}T00:00:00+05:30`,to:`${addLocalDays(dates.at(-1),2)}T00:00:00+05:30`}:null;
      const before = await calendarSnapshot(tx, listing,window);
      if (!expectedCalendarVersion) {
        throw new InventoryError(
          'CALENDAR_CHANGED',
          'The calendar changed. Reload it and preview again.',
        );
      }
      const changeHash=digest([command,values]);
      const signature = createHmac('sha256', process.env.SESSION_SECRET)
        .update(JSON.stringify([ownerId, rentableId, before.version, command, values]))
        .digest('hex');
      const token=`${changeHash}.${before.version}.${signature}`;
      if(!preview && previewToken?.split('.')[0]===changeHash && previewToken?.split('.')[1]!==before.version)throw new InventoryError('CALENDAR_CHANGED','These dates changed. Preview the latest changes before confirming.');
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
                (r.state === 'committed' || new Date(r.hold_expires_at) > new Date()) && (!values.resourceId || !r.resource_id || r.resource_id===values.resourceId),
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
    ![1,7,14,30,31,42].includes(days) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 10000 ||
    (query.slot && !['day', 'night', 'full_day', 'hourly'].includes(query.slot))
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
      const snapshot = await calendarSnapshot(tx, listing,{from:`${from}T00:00:00+05:30`,to:`${to}T00:00:00+05:30`});
      const reservations =
        await tx`SELECT r.id,r.source,r.state,r.reason,r.kind,r.details,r.blocked_start_at,r.blocked_end_at,r.hold_expires_at,
        b.order_id,b.slot,b.starts_at,b.ends_at,b.reference,b.guests,b.state AS booking_state,b.amount_rent_minor AS rent_minor,b.slot_snapshot->>'includedGuests' AS included_guests,CASE WHEN b.state IN ('confirmed','handed_over','returned','disputed') OR (b.state='completed' AND EXISTS(SELECT 1 FROM visit_evidence e WHERE e.booking_id=b.id AND e.kind='complete' AND e.occurred_at>now()-interval '7 days')) THEN o.listing_snapshot->'contact'->>'name' END AS guest_name,CASE WHEN b.state IN ('confirmed','handed_over','returned','disputed') OR (b.state='completed' AND EXISTS(SELECT 1 FROM visit_evidence e WHERE e.booking_id=b.id AND e.kind='complete' AND e.occurred_at>now()-interval '7 days')) THEN o.listing_snapshot->'contact'->>'phone' END AS guest_phone,b.slot_snapshot->'activity'->>'name' AS activity,
        r.resource_id,rs.name AS resource_name
        FROM inventory_reservation r LEFT JOIN booking b ON b.id=r.booking_id LEFT JOIN rentable_resource rs ON rs.id=r.resource_id LEFT JOIN booking_order o ON o.id=b.order_id
        WHERE r.rentable_id=${listing.id} AND (r.state='committed' OR (r.state='held' AND r.hold_expires_at>now()))
        AND r.blocked_start_at < (${to}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND r.blocked_end_at > (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        ORDER BY r.blocked_start_at,r.id`;
      // Time-booked venues: the courts, so the owner sees a day timeline per court.
      const resources = listing.rental_unit === 'hour'
        ? await tx`SELECT id,name,sort_order AS "sortOrder",is_active AS "isActive" FROM rentable_resource WHERE rentable_id=${listing.id} ORDER BY sort_order,name,id`
        : [];
      const rates=await tx`SELECT slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${listing.id}`;
      return {
        cells: listing.rental_unit==='hour'?[]:calendarCells(listing,snapshot,rates,from,days),
        config:listing.booking_config,
        id: listing.id,
        title: listing.title,
        rentalUnit: listing.rental_unit,
        resources,
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
