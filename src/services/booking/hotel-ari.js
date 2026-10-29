import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addLocalDays, isLocalDate, propertyToday } from '../domain/booking-dates.js';
import { conflict, forbidden, notFound, unprocessable } from '../../utils/apiError.js';
import { withListingInventory } from './inventory.js';
import { quoteDigest } from './quotes.js';
import { planNightRate } from '../domain/hotel.js';

/**
 * Hotel rates and rooms calendar (hotel plan, Phase 5): rooms open to Rentra,
 * base-rate price, stop-sell, closed-to-arrival and minimum nights per room type
 * per night. One set-based statement per change, so a 90-day × 4-room-type bulk
 * edit is a handful of statements, not 360 round trips. The database refuses a
 * night where rooms open would drop below rooms sold and held.
 *
 * Who may change what: owners and managers everything; front desk only opens
 * and closes rooms (stop-sell), the one thing they need at night.
 */
const uuid = z.string().uuid();
const day = z.string().refine(isLocalDate, 'Choose a valid date.');
const dayKey = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const MAX_ARI_DAYS = 366;
const FRONT_DESK_OPS = new Set(['close', 'open']);

/**
 * The caller's access to one hotel: 'owner', or the staff role on it.
 * `actor` is { kind: 'owner', id } or { kind: 'staff', id }.
 */
export async function hotelAccess(tx, actor, rentableId) {
  if (!uuid.safeParse(rentableId).success || !actor?.id) throw notFound();
  const [row] = await tx`SELECT r.client_id, r.rental_unit::text AS unit FROM rentable r WHERE r.id=${rentableId}`;
  if (!row) throw notFound();
  if (row.unit !== 'night') throw conflict('UNSUPPORTED_INVENTORY', 'Rates and rooms apply to hotels only.');
  if (actor.kind === 'owner') {
    if (row.client_id !== actor.id) throw notFound();
    return 'owner';
  }
  if (actor.kind === 'staff') {
    // A hotel role lives in the staff member's permissions: { hotelRole: 'manager' | 'front_desk' }.
    const [staff] = await tx`SELECT cs.permissions->>'hotelRole' AS hotel_role FROM client_staff cs
      JOIN staff_property sp ON sp.staff_id=cs.id
      WHERE cs.id=${actor.id} AND sp.rentable_id=${rentableId} AND cs.is_active AND cs.revoked_at IS NULL`;
    if (!['manager', 'front_desk'].includes(staff?.hotel_role)) throw notFound();
    return staff.hotel_role;
  }
  throw forbidden();
}

/** The grid: room types × nights, with the base rate's effective price and every restriction. */
export async function hotelAriGrid(database, actor, rentableId, { from, days = 14 } = {}) {
  const start = day.parse(from ?? propertyToday());
  const count = z.coerce.number().int().min(1).max(62).parse(days);
  const end = addLocalDays(start, count - 1);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const role = await hotelAccess(tx, actor, rentableId);
    const [profile] = await tx`SELECT weekend_nights FROM hotel_profile WHERE rentable_id=${rentableId}`;
    const weekend = (profile?.weekend_nights ?? [5, 6]).map(Number);
    const rooms = await tx`SELECT id, name, room_count, sort_order FROM room_type WHERE rentable_id=${rentableId} AND is_active ORDER BY sort_order, name, id`;
    const [nights, plans, overrides] = await Promise.all([
      tx`SELECT n.*, n.night::text AS d FROM room_night n JOIN room_type t ON t.id=n.room_type_id
        WHERE t.rentable_id=${rentableId} AND n.night BETWEEN ${start} AND ${end}`,
      tx`SELECT id, room_type_id, name, weekday_minor, weekend_minor, derived_from, derived_pct_bps, derived_per_guest_minor FROM rate_plan
        WHERE rentable_id=${rentableId} AND is_active ORDER BY sort_order, name, id`,
      tx`SELECT o.rate_plan_id, o.night::text AS d, o.rate_minor FROM rate_override o JOIN rate_plan p ON p.id=o.rate_plan_id
        WHERE p.rentable_id=${rentableId} AND o.night BETWEEN ${start} AND ${end}`,
    ]);
    const dates = Array.from({ length: count }, (_, i) => addLocalDays(start, i));
    const isWeekend = (d) => weekend.includes(new Date(`${d}T00:00:00Z`).getUTCDay());
    return {
      role,
      canEditPrices: role !== 'front_desk',
      from: start,
      days: count,
      today: propertyToday(),
      dates: dates.map((d) => ({ date: d, weekend: isWeekend(d) })),
      roomTypes: rooms.map((room) => {
        const base = plans.find((p) => p.room_type_id === room.id && !p.derived_from) ?? null;
        const baseOverrides = base ? Object.fromEntries(overrides.filter((o) => o.rate_plan_id === base.id).map((o) => [o.d, Number(o.rate_minor)])) : {};
        const basePlan = base && { id: base.id, weekdayMinor: Number(base.weekday_minor), weekendMinor: Number(base.weekend_minor) };
        return {
          id: room.id,
          name: room.name,
          roomCount: room.room_count,
          basePlan: base ? { id: base.id, name: base.name } : null,
          // Linked offers follow the base plan's effective rate (read-only), priced for base occupancy.
          derivedPlans: base
            ? plans.filter((p) => p.derived_from === base.id).map((p) => ({
                id: p.id,
                name: p.name,
                prices: dates.map((d) => planNightRate({
                  plan: { derivedFrom: p.derived_from, derivedPctBps: Number(p.derived_pct_bps), derivedPerGuestMinor: Number(p.derived_per_guest_minor ?? 0) },
                  basePlan, overrides: baseOverrides, night: d, weekendNights: weekend, chargedGuests: 0,
                }).rateMinor),
              }))
            : [],
          nights: dates.map((d) => {
            const n = nights.find((row) => row.room_type_id === room.id && row.d === d);
            const override = base && overrides.find((o) => o.rate_plan_id === base.id && o.d === d);
            const allotment = n?.allotment ?? room.room_count;
            const sold = n?.sold ?? 0;
            const held = n?.held ?? 0;
            return {
              date: d,
              allotment,
              open: Math.max(0, allotment - sold - held),
              sold,
              held,
              stopSell: n?.stop_sell ?? false,
              closedToArrival: n?.closed_to_arrival ?? false,
              minNights: n?.min_nights ?? null,
              priceMinor: base ? Number(override?.rate_minor ?? (isWeekend(d) ? base.weekend_minor : base.weekday_minor)) : null,
              customPrice: Boolean(override),
            };
          }),
        };
      }),
    };
  });
}

const changeSchema = z.object({
  from: day,
  to: day,
  weekdays: z.array(z.coerce.number().int().min(0).max(6)).min(1, 'Choose at least one night of the week.').max(7).default([0, 1, 2, 3, 4, 5, 6]),
  roomTypeIds: z.array(uuid).min(1, 'Choose at least one room type.').max(30),
  op: z.enum(['price', 'pricePct', 'resetPrice', 'rooms', 'close', 'open', 'minNights', 'closeArrival', 'openArrival']),
  value: z.coerce.number().optional(),
  preview: z.boolean().default(false),
  previewHash: z.string().length(64).optional(),
  expectedVersion: z.string().length(64).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.to < v.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end is before the start.' });
  const need = { price: [300, 200000], pricePct: [-50, 100], rooms: [0, 500], minNights: [1, 30] }[v.op];
  if (need && (v.value == null || !Number.isFinite(v.value) || v.value < need[0] || v.value > need[1] || (v.op !== 'pricePct' && !Number.isInteger(v.value)))) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `Enter a value from ${need[0]} to ${need[1]}.` });
  }
});

/**
 * One change over a date range, some nights of the week and some room types.
 * Preview returns the number of nights × room types it touches and a hash the save must echo.
 */
export async function changeHotelAri(database, actor, rentableId, input) {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) (fields[issue.path.join('.') || '_'] ??= []).push(issue.message);
    throw unprocessable(fields);
  }
  const v = parsed.data;
  const today = propertyToday();
  if (v.from < today) throw unprocessable({ from: ['Past nights cannot be changed.'] });
  if ((new Date(v.to) - new Date(v.from)) / 86400000 + 1 > MAX_ARI_DAYS) throw unprocessable({ to: [`Choose at most ${MAX_ARI_DAYS} nights.`] });
  return withListingInventory(database, rentableId, async (tx) => {
    const role = await hotelAccess(tx, actor, rentableId);
    if (role === 'front_desk' && !FRONT_DESK_OPS.has(v.op)) throw forbidden('ROLE_FORBIDDEN', 'Front desk can open and close rooms. Ask the owner or a manager to change prices or rules.');
    const rooms = await tx`SELECT id, room_count FROM room_type WHERE rentable_id=${rentableId} AND is_active AND id IN ${tx(v.roomTypeIds)}`;
    if (rooms.length !== new Set(v.roomTypeIds).size) throw notFound('ROOM_TYPE_NOT_FOUND', 'That room type is not on sale at this hotel.');
    const ids = rooms.map((r) => r.id).sort();
    // The selected nights, as one set the statements below join against.
    const nights = tx`SELECT d::date AS night FROM generate_series(${v.from}::date, ${v.to}::date, interval '1 day') d
      WHERE extract(dow FROM d)::int = ANY(${v.weekdays}::int[])`;
    const [{ count }] = await tx`SELECT count(*)::int AS count FROM (${nights}) n`;
    if (!count) throw unprocessable({ weekdays: ['No night in that range falls on the chosen days.'] });
    const summary = { rentableId, ...v, roomTypeIds: ids, preview: undefined, previewHash: undefined, expectedVersion: undefined, cells: count * ids.length };
    const previewHash = hash(summary);
    // Story 3.5: a digest of every row this change could touch. A save recomputes it under row locks,
    // so a second tab or any edit after the preview is refused instead of silently overwritten.
    const dataVersion = async (lock) => {
      const forUpdate = lock ? tx`FOR UPDATE` : tx``;
      const plans = await tx`SELECT id, weekday_minor, weekend_minor, derived_from, derived_pct_bps, derived_per_guest_minor, is_active
        FROM rate_plan WHERE room_type_id IN ${tx(ids)} ORDER BY id ${forUpdate}`;
      const rates = plans.length
        ? await tx`SELECT rate_plan_id, night::text AS night, rate_minor FROM rate_override
            WHERE rate_plan_id IN ${tx(plans.map((p) => p.id))} AND night IN (${nights}) ORDER BY rate_plan_id, night ${forUpdate}`
        : [];
      const rows = await tx`SELECT room_type_id, night::text AS night, allotment, stop_sell, min_nights, closed_to_arrival FROM room_night
        WHERE room_type_id IN ${tx(ids)} AND night IN (${nights}) ORDER BY room_type_id, night ${forUpdate}`;
      const [profile] = await tx`SELECT weekend_nights FROM hotel_profile WHERE rentable_id=${rentableId} ${forUpdate}`;
      return quoteDigest({ weekend: profile?.weekend_nights ?? null, plans: [...plans], rates: [...rates], rows: [...rows] });
    };
    const isPrice = ['price', 'pricePct', 'resetPrice'].includes(v.op);
    // A stale save is refused (409) before any value check can answer 422.
    if (!v.preview) {
      if (!v.expectedVersion) throw unprocessable({ expectedVersion: ['Preview the change before saving.'] });
      if (v.previewHash && v.previewHash !== previewHash) throw conflict('STALE_PREVIEW', 'The change moved. Preview again before saving.');
      if ((await dataVersion(true)) !== v.expectedVersion) throw conflict('CALENDAR_CHANGED', 'Prices changed since your preview — review again.');
    }
    let planIds = [];
    let weekend = [];
    let changes = [];
    if (isPrice) {
      const plans = await tx`SELECT id FROM rate_plan
        WHERE rentable_id=${rentableId} AND is_active AND derived_from IS NULL AND room_type_id IN ${tx(ids)}`;
      if (!plans.length) throw unprocessable({ roomTypeIds: ['These room types have no base rate yet. Add one in Rates first.'] });
      planIds = plans.map((p) => p.id);
      const [profile] = await tx`SELECT weekend_nights FROM hotel_profile WHERE rentable_id=${rentableId}`;
      weekend = (profile?.weekend_nights ?? [5, 6]).map(Number);
      // Before and after per room type × night. pricePct applies to the effective price (an existing override,
      // else weekday/weekend), rounded to whole rupees; reset returns to the weekday/weekend price.
      changes = (await tx`WITH target AS (
          SELECT p.room_type_id, n.night, CASE WHEN extract(dow FROM n.night)::int = ANY(${weekend}::int[]) THEN p.weekend_minor ELSE p.weekday_minor END AS standard,
            COALESCE(o.rate_minor, CASE WHEN extract(dow FROM n.night)::int = ANY(${weekend}::int[]) THEN p.weekend_minor ELSE p.weekday_minor END) AS current
          FROM rate_plan p CROSS JOIN (${nights}) n LEFT JOIN rate_override o ON o.rate_plan_id=p.id AND o.night=n.night
          WHERE p.id IN ${tx(planIds)})
        SELECT room_type_id, night::text AS night, current::bigint AS before,
          ${v.op === 'price' ? tx`${(v.value ?? 0) * 100}::bigint` : v.op === 'resetPrice' ? tx`standard::bigint` : tx`(round(current * (100 + ${v.value}::numeric) / 10000) * 100)::bigint`} AS after
        FROM target ORDER BY night, room_type_id`).map((r) => ({ roomTypeId: r.room_type_id, night: r.night, beforeMinor: Number(r.before), afterMinor: Number(r.after) }));
      if (v.op !== 'resetPrice' && changes.some((c) => c.afterMinor < 30000 || c.afterMinor > 20000000)) {
        throw unprocessable({ value: ['Some nights would fall outside ₹300–₹2,00,000. Use a smaller change.'] });
      }
    }
    if (v.preview) {
      return {
        preview: true, previewHash, version: await dataVersion(false), cells: count * ids.length, nights: count, roomTypes: ids.length,
        ...(isPrice && { changes: changes.slice(0, 60), changeCount: changes.length }),
      };
    }

    if (isPrice) {
      if (v.op === 'resetPrice') {
        await tx`DELETE FROM rate_override WHERE rate_plan_id IN ${tx(planIds)} AND night IN (${nights})`;
      } else {
        await tx`INSERT INTO rate_override (rate_plan_id, night, rate_minor)
          SELECT p.id, n.night, ${v.op === 'price' ? tx`${v.value * 100}::bigint` : tx`(round(COALESCE(o.rate_minor, CASE WHEN extract(dow FROM n.night)::int = ANY(${weekend}::int[]) THEN p.weekend_minor ELSE p.weekday_minor END) * (100 + ${v.value}::numeric) / 10000) * 100)::bigint`}
          FROM rate_plan p CROSS JOIN (${nights}) n LEFT JOIN rate_override o ON o.rate_plan_id=p.id AND o.night=n.night
          WHERE p.id IN ${tx(planIds)}
          ON CONFLICT (rate_plan_id, night) DO UPDATE SET rate_minor=EXCLUDED.rate_minor`;
      }
    } else {
      // Materialise the nights first (allotment = room count), then one UPDATE over all of them.
      await tx`INSERT INTO room_night (room_type_id, night, allotment)
        SELECT t.id, n.night, t.room_count FROM room_type t CROSS JOIN (${nights}) n WHERE t.id IN ${tx(ids)}
        ON CONFLICT DO NOTHING`;
      const set = {
        rooms: tx`allotment=${v.value}, allotment_overridden=true`,
        close: tx`stop_sell=true`,
        open: tx`stop_sell=false`,
        minNights: tx`min_nights=${v.value === 1 ? null : v.value}`,
        closeArrival: tx`closed_to_arrival=true`,
        openArrival: tx`closed_to_arrival=false`,
      }[v.op];
      if (v.op === 'rooms') {
        const tooMany = rooms.filter((r) => v.value > r.room_count);
        if (tooMany.length) throw unprocessable({ value: [`A room type has only ${Math.min(...tooMany.map((r) => r.room_count))} rooms. Raise its room count in Rooms first.`] });
        const below = await tx`SELECT t.name, n.night::text AS night, n.sold + n.held AS taken FROM room_night n JOIN room_type t ON t.id=n.room_type_id
          WHERE n.room_type_id IN ${tx(ids)} AND n.night IN (${nights}) AND n.sold + n.held > ${v.value} ORDER BY n.night LIMIT 3`;
        if (below.length) {
          throw conflict('ROOMS_BELOW_BOOKINGS', `Nothing changed. ${below.map((r) => `${r.name} on ${r.night} has ${r.taken} booked`).join('; ')}. Rooms open cannot go below rooms booked.`);
        }
      }
      await tx`UPDATE room_night SET ${set}, updated_at=now()
        WHERE room_type_id IN ${tx(ids)} AND night IN (${nights})`;
    }
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after")
      VALUES (${actor.kind === 'staff' ? 'staff' : 'client'},${actor.id},'rentable',${rentableId},'hotel_ari_changed',${JSON.stringify(summary)}::text::jsonb)`;
    return { ok: true, cells: count * ids.length };
  });
}

