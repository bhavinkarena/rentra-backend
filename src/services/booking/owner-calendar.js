import 'server-only';
import {calendarCells} from '../domain/owner-calendar.js';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  withListingInventory,
  getInventoryState,
  inventoryStateQuery,
  InventoryError,
} from './inventory.js';
import { addLocalDays, isLocalDate, propertyToday } from '../domain/booking-dates.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';

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

/** A ten-second, owner-bound token for replaying the inverse command; Undo still rechecks the window version. */
export function signUndo(value) {
  const undoUntil = Date.now() + 10000;
  const payload = Buffer.from(JSON.stringify({ ...value, expires: undoUntil })).toString('base64url');
  return { undoToken: payload + '.' + createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex'), undoUntil };
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
      if (command === 'unblock' && result?.changed && window)
        return { ok: true, result, ...signUndo({ ownerId, id: rentableId, command, rows: [{ blockId: values.blockId }], window,
          version: (await calendarSnapshot(tx, listing, window)).version }) };
      return { ok: true, result };
    });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.result;
    throw error;
  }
}

const contactVisible = (tx) => tx`(b.state IN ('confirmed','handed_over','returned','disputed') OR (b.state='completed' AND EXISTS(SELECT 1 FROM visit_evidence e WHERE e.booking_id=b.id AND e.kind='complete' AND e.occurred_at>now()-interval '7 days')))`;

/** One read-only snapshot and a fixed number of statements for the whole page, however many properties. */
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
  const window = { from: `${from}T00:00:00+05:30`, to: `${to}T00:00:00+05:30` };
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const listings = await tx`SELECT * FROM rentable WHERE client_id=${ownerId}
      AND (${query.property || null}::uuid IS NULL OR id=${query.property || null}::uuid)
      ORDER BY title,id LIMIT 11 OFFSET ${(page - 1) * 10}`;
    const hasMore = listings.length > 10;
    const ids = listings.slice(0, 10).map((l) => l.id);
    const result = { from, to, days, page, hasMore, slot: query.slot || '', property: query.property || '', items: [] };
    if (!ids.length) return result;
    const ref = { id: tx`r.id` };
    const [states, overrides, rates, reservations, resources] = await Promise.all([
      tx`SELECT r.id, row_to_json(inventory) AS inventory FROM rentable r
        CROSS JOIN LATERAL (${inventoryStateQuery(tx, ref, window)}) inventory WHERE r.id IN ${tx(ids)}`,
      tx`SELECT rentable_id,day::text,slot,rent_minor FROM booking_price_override WHERE rentable_id IN ${tx(ids)}
        AND day BETWEEN ${from}::date AND ${to}::date ORDER BY day,slot`,
      tx`SELECT rentable_id,slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id IN ${tx(ids)} ORDER BY slot`,
      tx`SELECT r.rentable_id,r.id,r.source,r.state,r.reason,r.kind,r.details,r.blocked_start_at,r.blocked_end_at,r.hold_expires_at,
        b.order_id,b.slot,b.starts_at,b.ends_at,b.reference,b.guests,b.state AS booking_state,b.amount_rent_minor AS rent_minor,b.slot_snapshot->>'includedGuests' AS included_guests,
        CASE WHEN ${contactVisible(tx)} THEN o.listing_snapshot->'contact'->>'name' END AS guest_name,
        CASE WHEN ${contactVisible(tx)} THEN o.listing_snapshot->'contact'->>'phone' END AS guest_phone,b.slot_snapshot->'activity'->>'name' AS activity,
        (b.starts_at AT TIME ZONE 'Asia/Kolkata')::date::text AS arrival_day,(b.ends_at AT TIME ZONE 'Asia/Kolkata')::date::text AS departure_day,
        r.resource_id,rs.name AS resource_name
        FROM inventory_reservation r LEFT JOIN booking b ON b.id=r.booking_id LEFT JOIN rentable_resource rs ON rs.id=r.resource_id LEFT JOIN booking_order o ON o.id=b.order_id
        WHERE r.rentable_id IN ${tx(ids)} AND (r.state='committed' OR (r.state='held' AND r.hold_expires_at>now()))
        AND r.blocked_start_at < (${to}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND r.blocked_end_at > (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        ORDER BY r.blocked_start_at,r.id`,
      // Time-booked venues: the courts, so the owner sees a day timeline per court.
      tx`SELECT rentable_id,id,name,sort_order AS "sortOrder",is_active AS "isActive" FROM rentable_resource WHERE rentable_id IN ${tx(ids)} ORDER BY sort_order,name,id`,
    ]);
    const own = (rows, id) => rows.filter((r) => r.rentable_id === id).map(({ rentable_id: _, ...r }) => r);
    for (const listing of listings.slice(0, 10)) {
      const state = states.find((s) => s.id === listing.id).inventory;
      const listingRates = own(rates, listing.id), listingOverrides = own(overrides, listing.id);
      // Same digest as calendarSnapshot for this window, so commands accept the page's version.
      const snapshot = { ...state, overrides: listingOverrides, version: digest([listing.booking_config, state, listingOverrides, listingRates]) };
      result.items.push({
        cells: listing.rental_unit==='hour'?[]:calendarCells(listing,snapshot,listingRates,from,days),
        config:listing.booking_config,
        id: listing.id,
        title: listing.title,
        photo: normalizePublicPhotos(listing.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME })[0] ?? null,
        rentalUnit: listing.rental_unit,
        resources: listing.rental_unit === 'hour' ? own(resources, listing.id) : [],
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
        overrides: listingOverrides.filter(
          (r) => r.day >= from && r.day < to && (!query.slot || r.slot === query.slot),
        ),
        intervals: own(reservations, listing.id).filter((r) => !query.slot || !r.slot || r.slot === query.slot),
      });
    }
    return result;
  });
}
