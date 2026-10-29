import 'server-only';
import { freeCancelHoursOf, policyFromHotelPlan } from '../domain/cancellation-policy.js';

import {
  HOTEL_POLICY, HotelError, cancellationTerms, hotelRefund, priceRoomStay, roomTypeAvailability, stayInstants, stayNights,
} from '../domain/hotel.js';
import { resolveInclusions } from '../domain/hotel-rooms.js';
import { effectiveChildPolicy } from '../domain/child-policy.js';
import { quoteDigest } from './quotes.js';
import { expireInventoryHolds, withListingSnapshot } from './inventory.js';

/**
 * Hotel inventory engine (hotel plan, Phase 2). Reads use a read-only snapshot;
 * writes run inside withListingInventory (the caller's transaction, under the
 * hotel's mutex). booking_room triggers keep room_night counts, and the
 * database refuses sold + held > allotment even for a writer that skips the mutex.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const int = (value) => (value == null ? null : Number(value));

// Story 3.6: `childPolicy` is the effective { version, source, policy } this room quotes with.
const roomTypeOf = (row, profile = null) => ({
  id: row.id, name: row.name, maxAdults: row.max_adults, maxChildren: row.max_children, maxOccupancy: row.max_occupancy,
  baseOccupancy: row.base_occupancy, roomCount: row.room_count,
  extraAdultMinor: int(row.extra_adult_minor), extraChildMinor: int(row.extra_child_minor),
  beds: row.beds, extraPlaces: row.extra_places ?? [], extraAdultIncludesBedding: row.extra_adult_includes_bedding ?? false, sizeSqm: row.size_sqm, view: row.view, amenities: row.amenities ?? [],
  cots: row.cots ?? { count: 0 },
  childPolicy: profile && {
    version: profile.child_policy_version ?? 1,
    ...effectiveChildPolicy({ childPolicy: profile.child_policy, childFreeAge: profile.child_free_age },
      { childPolicy: row.child_policy, extraChildMinor: int(row.extra_child_minor) }),
  },
});
// Story 2.6: a plan uses the hotel default unless the owner chose its own policy.
const planOf = (row, hotelPolicy) => {
  const cancellationPolicy = row.cancellation_policy ?? hotelPolicy ?? policyFromHotelPlan({ freeCancelHours: row.free_cancel_hours });
  return {
    ...planColumns(row),
    cancellationPolicy,
    inheritsCancellation: row.cancellation_policy == null,
    freeCancelHours: freeCancelHoursOf(cancellationPolicy),
  };
};
const planColumns = (row) => ({
  id: row.id, roomTypeId: row.room_type_id, name: row.name, mealPlan: row.meal_plan, isActive: row.is_active,
  weekdayMinor: int(row.weekday_minor), weekendMinor: int(row.weekend_minor), derivedFrom: row.derived_from,
  derivedPctBps: row.derived_pct_bps, derivedPerGuestMinor: int(row.derived_per_guest_minor),
  freeCancelHours: row.free_cancel_hours, lateCharge: row.late_charge, noShow: row.no_show,
  minNights: row.min_nights, maxNights: row.max_nights, inclusions: resolveInclusions(row.meal_plan, row.inclusions),
});

/**
 * Everything pricing and availability need for [checkIn, checkOut), for one or
 * many hotels, in one consistent read: a fixed number of queries whatever the
 * number of hotels (search prices hundreds at once). Map rentable id → data.
 */
async function loadHotels(tx, listings, checkIn, checkOut, now) {
  const ids = listings.map((l) => l.id);
  if (!ids.length) return new Map();
  const [profiles, rooms, plans, overrides, nightRows, staleHolds, slabs] = await Promise.all([
    tx`SELECT p.rentable_id, p.check_in_minute, p.check_out_minute, p.child_free_age, p.weekend_nights, p.child_policy, p.child_policy_version,
        r.cancellation_policy AS hotel_policy
      FROM hotel_profile p JOIN rentable r ON r.id = p.rentable_id JOIN category c ON c.id = r.category_id
      WHERE p.rentable_id IN ${tx(ids)} AND c.vertical_code = 'hotel'`,
    tx`SELECT * FROM room_type WHERE rentable_id IN ${tx(ids)} AND is_active ORDER BY sort_order, name, id`,
    tx`SELECT * FROM rate_plan WHERE rentable_id IN ${tx(ids)} ORDER BY sort_order, name, id`,
    tx`SELECT o.rate_plan_id, o.night, o.rate_minor FROM rate_override o JOIN rate_plan p ON p.id = o.rate_plan_id
      WHERE p.rentable_id IN ${tx(ids)} AND o.night >= ${checkIn} AND o.night < ${checkOut}`,
    tx`SELECT n.* FROM room_night n JOIN room_type t ON t.id = n.room_type_id
      WHERE t.rentable_id IN ${tx(ids)} AND n.night >= ${checkIn} AND n.night < ${checkOut}`,
    // Holds whose order has expired but not yet been swept count as free, as they do for farmhouses.
    tx`SELECT br.room_type_id, d::date AS night, count(*)::int AS rooms
      FROM booking_room br JOIN booking b ON b.id = br.booking_id JOIN booking_order o ON o.id = b.order_id,
        generate_series(br.check_in, br.check_out - 1, interval '1 day') d
      WHERE br.rentable_id IN ${tx(ids)} AND br.state = 'held' AND o.state = 'held' AND o.hold_expires_at <= ${now.toISOString()}
        AND br.check_in < ${checkOut} AND br.check_out > ${checkIn}
      GROUP BY 1, 2`,
    tx`SELECT min_rate_minor, max_rate_minor, tax_bps, effective_from, effective_to FROM tax_slab
      WHERE vertical_code = 'hotel' AND effective_from < ${checkOut} AND (effective_to IS NULL OR effective_to >= ${checkIn})`,
  ]);
  const stale = new Map(staleHolds.map((row) => [`${row.room_type_id}|${day(row.night)}`, row.rooms]));
  const taxSlabs = slabs.map((row) => ({
    minRateMinor: int(row.min_rate_minor), maxRateMinor: int(row.max_rate_minor), taxBps: row.tax_bps,
    effectiveFrom: day(row.effective_from), effectiveTo: day(row.effective_to),
  }));
  const roomsByHotel = Map.groupBy(rooms, (row) => row.rentable_id);
  const plansByHotel = Map.groupBy(plans, (row) => row.rentable_id);
  const planHotel = new Map(plans.map((row) => [row.id, row.rentable_id]));
  const overridesByHotel = new Map();
  for (const row of overrides) {
    const own = overridesByHotel.get(planHotel.get(row.rate_plan_id)) ?? {};
    (own[row.rate_plan_id] ??= {})[day(row.night)] = int(row.rate_minor);
    overridesByHotel.set(planHotel.get(row.rate_plan_id), own);
  }
  const nights = nightRows.map((row) => {
    const night = day(row.night);
    return {
      roomTypeId: row.room_type_id, night, allotment: row.allotment, sold: row.sold,
      held: row.held - (stale.get(`${row.room_type_id}|${night}`) ?? 0),
      stopSell: row.stop_sell, closedToArrival: row.closed_to_arrival, minNights: row.min_nights,
    };
  });
  const nightsByRoom = Map.groupBy(nights, (row) => row.roomTypeId);
  const result = new Map();
  for (const profile of profiles) {
    const listing = listings.find((l) => l.id === profile.rentable_id);
    result.set(listing.id, {
      listing,
      hotel: {
        checkInMinute: profile.check_in_minute, checkOutMinute: profile.check_out_minute,
        childFreeAge: profile.child_free_age, weekendNights: profile.weekend_nights.map(Number),
      },
      roomTypes: (roomsByHotel.get(listing.id) ?? []).map((row) => roomTypeOf(row, profile)),
      plans: (plansByHotel.get(listing.id) ?? []).map((row) => planOf(row, profile.hotel_policy)),
      overridesByPlan: overridesByHotel.get(listing.id) ?? {},
      nightsByRoom,
      slabs: taxSlabs,
    });
  }
  return result;
}

async function loadHotel(tx, listing, checkIn, checkOut, now) {
  const data = (await loadHotels(tx, [listing], checkIn, checkOut, now)).get(listing.id);
  if (!data) throw new HotelError('NOT_FOUND', 'Hotel unavailable.');
  return data;
}

function availabilityFor(data, roomType, nights) {
  return roomTypeAvailability({ roomCount: roomType.roomCount, nights, nightRows: data.nightsByRoom.get(roomType.id) ?? [] });
}

function priceLine(data, nights, { roomType, plan, adults, childAges }) {
  if (nights.length < plan.minNights || nights.length > plan.maxNights) {
    throw new HotelError('MIN_NIGHTS', `${plan.name} is for ${plan.minNights}–${plan.maxNights} nights.`);
  }
  const basePlan = plan.derivedFrom ? data.plans.find((row) => row.id === plan.derivedFrom) : plan;
  return priceRoomStay({
    nights, roomType, plan, basePlan, overrides: data.overridesByPlan[basePlan?.id] ?? {},
    hotel: data.hotel, slabs: data.slabs, adults, childAges,
  });
}

/** Story 3.3: the room as promised at booking; later owner edits never rewrite it. */
const roomSnapshot = (roomType, plan) => ({
  name: roomType.name, beds: roomType.beds, extraPlaces: roomType.extraPlaces,
  extraAdultIncludesBedding: roomType.extraAdultIncludesBedding, sizeSqm: roomType.sizeSqm, view: roomType.view,
  amenities: roomType.amenities, baseOccupancy: roomType.baseOccupancy, maxAdults: roomType.maxAdults, maxChildren: roomType.maxChildren,
  inclusions: plan.inclusions, childPolicy: roomType.childPolicy, cots: roomType.cots,
});

const planSnapshot = (plan) => ({
  name: plan.name, mealPlan: plan.mealPlan, freeCancelHours: plan.freeCancelHours, lateCharge: plan.lateCharge, noShow: plan.noShow,
  // Story 2.6: the room's own accepted policy; mixed rooms each keep theirs.
  cancellationPolicy: plan.cancellationPolicy,
});

/** Price `party` (one entry per room) in one room type and plan; throws HotelError when the plan cannot take it. */
function partyPrice(data, nights, roomType, plan, party) {
  let roomMinor = 0;
  let taxMinor = 0;
  const bedding = [];
  for (const guests of party) {
    const price = priceLine(data, nights, { roomType, plan, adults: guests.adults, childAges: guests.childAges });
    roomMinor += price.roomMinor;
    taxMinor += price.taxMinor;
    // Story 3.4: the guest sees each room's charged bedding next to the plan price.
    if (price.bedding) bedding.push({ bedding: price.bedding, nights: price.nights.map(({ beddingMinor = 0 }) => ({ beddingMinor })) });
  }
  return { roomMinor, taxMinor, totalMinor: roomMinor + taxMinor, ...(bedding.length ? { bedding } : {}) };
}

/**
 * Public availability for a stay: every active room type with rooms left and,
 * per plan, the price for the party split over `rooms` rooms of that type (the
 * search card's split), or for one room at base occupancy without a party.
 */
export async function getHotelAvailability(database, { rentableId, checkIn, checkOut, rooms = null, adults = null, childAges = [], now = new Date() }) {
  if (!UUID.test(rentableId ?? '')) throw new HotelError('NOT_FOUND', 'Hotel unavailable.');
  const nights = stayNights(checkIn, checkOut, now);
  const split = rooms ? splitParty({ rooms, adults, childAges }) : null;
  return withListingSnapshot(database, rentableId, async (tx, listing) => {
    const data = await loadHotel(tx, listing, checkIn, checkOut, new Date(now));
    const { startsAt } = stayInstants({ checkIn, checkOut, ...data.hotel });
    // Story 2.20: an overdue owner shows no bookable rooms; the reason stays generic for guests.
    const [{ stopped }] = await tx`SELECT owner_repayment_overdue(${listing.client_id}) stopped`;
    return {
      checkIn, checkOut, nights: nights.length, rooms: split?.length ?? 1, party: split,
      roomTypes: data.roomTypes.map((roomType) => {
        if (stopped) return { id: roomType.id, name: roomType.name, available: 0, reason: 'NOT_BOOKABLE', plans: [] };
        const { available, reason } = availabilityFor(data, roomType, nights);
        const party = split ?? [{ adults: Math.min(roomType.baseOccupancy, roomType.maxAdults), childAges: [] }];
        return {
          id: roomType.id, name: roomType.name, available, reason,
          plans: data.plans.filter((plan) => plan.roomTypeId === roomType.id && plan.isActive).map((plan) => {
            const terms = cancellationTerms(plan, startsAt);
            const base = { id: plan.id, name: plan.name, mealPlan: plan.mealPlan, adults: party[0].adults, terms };
            try {
              return { ...base, bookable: available >= party.length, ...partyPrice(data, nights, roomType, plan, party) };
            } catch (error) {
              if (!(error instanceof HotelError)) throw error;
              return { ...base, bookable: false, reason: error.code, message: error.message };
            }
          }),
        };
      }),
    };
  });
}

function buildQuote(data, { checkIn, checkOut, rooms }, now) {
  const nights = stayNights(checkIn, checkOut, now);
  if (data.listing.status !== 'live') throw new HotelError('NOT_BOOKABLE', 'This hotel is not taking bookings.');
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > HOTEL_POLICY.maxRooms) {
    throw new HotelError('ROOMS_INVALID', `Choose 1–${HOTEL_POLICY.maxRooms} rooms.`);
  }
  const wanted = new Map();
  const lines = rooms.map((room) => {
    const roomType = data.roomTypes.find((row) => row.id === room?.roomTypeId);
    const plan = data.plans.find((row) => row.id === room?.ratePlanId && row.isActive);
    if (!roomType || !plan || plan.roomTypeId !== roomType.id) throw new HotelError('ROOM_UNAVAILABLE', 'That room or rate is no longer offered.');
    wanted.set(roomType.id, (wanted.get(roomType.id) ?? 0) + 1);
    const childAges = room.childAges ?? [];
    const price = priceLine(data, nights, { roomType, plan, adults: room.adults, childAges });
    return { roomTypeId: roomType.id, ratePlanId: plan.id, adults: room.adults, childAges, plan: planSnapshot(plan), childPolicy: roomType.childPolicy, ...price };
  });
  for (const [roomTypeId, count] of wanted) {
    const roomType = data.roomTypes.find((row) => row.id === roomTypeId);
    const { available, reason } = availabilityFor(data, roomType, nights);
    if (count > available) {
      throw new HotelError(reason === 'SOLD_OUT' || available > 0 ? 'SOLD_OUT' : reason,
        available > 0 ? `Only ${available} ${roomType.name} left for these dates.` : `${roomType.name} is not available for these dates.`);
    }
  }
  const { startsAt, endsAt } = stayInstants({ checkIn, checkOut, ...data.hotel });
  const totals = ['roomMinor', 'taxMinor', 'totalMinor'].reduce((sum, key) => ({ ...sum, [key]: lines.reduce((acc, line) => acc + line[key], 0) }), {});
  const content = { version: HOTEL_POLICY.version, rentableId: data.listing.id, checkIn, checkOut, startsAt, endsAt, lines, totals };
  return { ...content, hash: quoteDigest(content) };
}

/** A priced, availability-checked quote. Not persisted: checkout (Phase 7) stores it with the order. */
export async function quoteHotelStay(database, { rentableId, checkIn, checkOut, rooms, now = new Date() }) {
  if (!UUID.test(rentableId ?? '')) throw new HotelError('NOT_FOUND', 'Hotel unavailable.');
  return withListingSnapshot(database, rentableId, async (tx, listing) => {
    const quote = buildQuote(await loadHotel(tx, listing, checkIn, checkOut, new Date(now)), { checkIn, checkOut, rooms }, now);
    return { ...quote, expiresAt: new Date(new Date(now).getTime() + HOTEL_POLICY.holdMinutes * 60_000).toISOString() };
  });
}

function inventoryError(error) {
  if (error?.code === '23514' && error.constraint_name === 'room_night_capacity_chk') {
    return new HotelError('SOLD_OUT', 'Those rooms were just booked. Choose other rooms.');
  }
  if (error?.code === '23514' && error.constraint_name === 'room_night_stop_sell') {
    return new HotelError('CLOSED', 'The hotel closed these rooms for one of your nights.');
  }
  return error;
}

/**
 * Hold the quote's rooms for a booking, inside withListingInventory. The quote
 * is rebuilt under the lock; a different price or rule gives QUOTE_CHANGED.
 * The booking (slot 'stay') and its order are the caller's.
 */
export async function holdHotelRooms(tx, listing, { bookingId, quote, guestNames = [], now }) {
  await expireInventoryHolds(tx, listing.id, now);
  const clock = now ? new Date(now) : new Date((await tx`SELECT clock_timestamp() AS now`)[0].now);
  // Story 3.3: the snapshot is read under the listing row lock that saveHotelRooms/saveHotelRates also take
  // (both run in withListingInventory); FOR SHARE keeps that true even for a writer that skips the mutex.
  await tx`SELECT id FROM room_type WHERE rentable_id = ${listing.id} ORDER BY id FOR SHARE`;
  await tx`SELECT id FROM rate_plan WHERE rentable_id = ${listing.id} ORDER BY id FOR SHARE`;
  const data = await loadHotel(tx, listing, quote.checkIn, quote.checkOut, clock);
  const fresh = buildQuote(data, {
    checkIn: quote.checkIn, checkOut: quote.checkOut,
    rooms: quote.lines.map(({ roomTypeId, ratePlanId, adults, childAges }) => ({ roomTypeId, ratePlanId, adults, childAges })),
  }, clock);
  if (fresh.hash !== quote.hash) throw new HotelError('QUOTE_CHANGED', 'The price or availability changed. Review the new price.');
  // Room types in ID order, so two holds never take their night rows in opposite orders.
  const lines = fresh.lines.map((line, index) => ({ line, name: guestNames[index] ?? null }))
    .sort((a, b) => (a.line.roomTypeId < b.line.roomTypeId ? -1 : a.line.roomTypeId > b.line.roomTypeId ? 1 : 0));
  try {
    for (const { line, name } of lines) {
      await tx`INSERT INTO booking_room (booking_id, rentable_id, room_type_id, rate_plan_id, check_in, check_out, adults, child_ages,
          guest_name, nights, amount_room_minor, amount_tax_minor, plan_snapshot, room_snapshot)
        VALUES (${bookingId}, ${listing.id}, ${line.roomTypeId}, ${line.ratePlanId}, ${fresh.checkIn}, ${fresh.checkOut}, ${line.adults},
          ${line.childAges}, ${name}, ${JSON.stringify(line.nights)}::text::jsonb, ${line.roomMinor}, ${line.taxMinor},
          ${JSON.stringify(line.plan)}::text::jsonb, ${JSON.stringify(roomSnapshot(
            data.roomTypes.find((row) => row.id === line.roomTypeId), data.plans.find((row) => row.id === line.ratePlanId)))}::text::jsonb)`;
    }
  } catch (error) {
    throw inventoryError(error);
  }
  return fresh;
}

async function moveRooms(tx, bookingId, from, to) {
  const rows = await tx`UPDATE booking_room SET state = ${to}, updated_at = clock_timestamp()
    WHERE booking_id = ${bookingId} AND state IN ${tx(from)} RETURNING id`;
  return rows.length;
}

/** Payment confirmed: held rooms become sold. */
export async function confirmHotelRooms(tx, bookingId) {
  const count = await moveRooms(tx, bookingId, ['held'], 'booked');
  if (!count) throw new HotelError('HOLD_MISSING', 'These rooms are no longer held.');
  return count;
}

/** Cancelled, failed or expired: rooms go back on sale. Idempotent. */
export const releaseHotelRooms = (tx, bookingId) => moveRooms(tx, bookingId, ['held', 'booked'], 'released');

/** After check-in: the hotel marks the stay as stayed or a no-show. Counts stay sold. */
export async function finishHotelRooms(tx, bookingId, outcome) {
  if (!['stayed', 'no_show'].includes(outcome)) throw new HotelError('INVALID_INPUT', 'Unknown stay outcome.');
  return moveRooms(tx, bookingId, ['booked'], outcome);
}

/** Refund if the guest cancels now, per room line and in total, from the booked snapshots. */
export async function previewHotelCancellation(sql, bookingId, now = new Date(), roomIds = null) {
  const rows = await sql`SELECT br.*, b.starts_at FROM booking_room br JOIN booking b ON b.id = br.booking_id
    WHERE br.booking_id = ${bookingId} AND br.state = 'booked' ORDER BY br.id`;
  if (!rows.length) throw new HotelError(roomIds ? 'ROOM_NOT_CANCELLABLE' : 'NOT_CANCELLABLE', 'There is nothing to cancel on this booking.');
  const selected = roomIds ? rows.filter((row) => roomIds.includes(row.id)) : rows;
  if (roomIds && selected.length !== roomIds.length) throw new HotelError('ROOM_NOT_CANCELLABLE', 'A selected room is no longer booked on this stay.');
  const lines = selected.map((row) => ({
    id: row.id,
    ...(!row.plan_snapshot.cancellationPolicy ? { legacy: { freeCancelHours: row.plan_snapshot.freeCancelHours, lateCharge: row.plan_snapshot.lateCharge } } : {}),
    ...hotelRefund({
      totalMinor: int(row.amount_room_minor) + int(row.amount_tax_minor), nights: row.nights,
      plan: { freeCancelHours: row.plan_snapshot.freeCancelHours, lateCharge: row.plan_snapshot.lateCharge,
        cancellationPolicy: row.plan_snapshot.cancellationPolicy },
    }, row.starts_at, now),
  }));
  return { lines, bookedRoomCount: rows.length, refundMinor: lines.reduce((sum, line) => sum + line.refundMinor, 0), chargeMinor: lines.reduce((sum, line) => sum + line.chargeMinor, 0) };
}

/** Commission for a hotel on a date: property rule, else city rule, else vertical rule. */
export async function resolveCommission(sql, { rentableId, date }) {
  const [rule] = await sql`SELECT cr.id, cr.rate_bps, cr.tier FROM commission_rule cr
    JOIN rentable r ON r.id = ${rentableId} JOIN category c ON c.id = r.category_id
    WHERE cr.vertical_code = c.vertical_code
      AND (cr.rentable_id = r.id OR (cr.rentable_id IS NULL AND (cr.city_id = r.city_id OR cr.city_id IS NULL)))
      AND ${date}::date BETWEEN cr.valid_from AND COALESCE(cr.valid_to, 'infinity'::date)
    ORDER BY (cr.rentable_id IS NOT NULL) DESC, (cr.city_id IS NOT NULL) DESC LIMIT 1`;
  if (!rule) throw new HotelError('COMMISSION_UNCONFIGURED', 'No commission rule covers this hotel on this date.');
  return { ruleId: rule.id, rateBps: rule.rate_bps, tier: rule.tier };
}

/** How a party is placed in rooms for search: adults as evenly as possible, children one by one. */
export function splitParty({ rooms, adults, childAges = [] }) {
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > HOTEL_POLICY.maxRooms || !Number.isInteger(adults) || adults < rooms) {
    throw new HotelError('ROOMS_INVALID', 'Each room needs at least one adult.');
  }
  return Array.from({ length: rooms }, (_, index) => ({
    adults: Math.floor(adults / rooms) + (index < adults % rooms ? 1 : 0),
    childAges: childAges.filter((_, child) => child % rooms === index),
  }));
}

/**
 * Search (hotel plan, Phase 6): for each hotel, the cheapest way to sell the
 * party `rooms` rooms of one type for the stay, honouring the free-cancellation
 * and breakfast filters. One read for every hotel; prices come from the same
 * functions as the hotel page and the quote, so the card price is the quote.
 */
export async function hotelSearchOffers(database, listings, { checkIn, checkOut, rooms, adults, childAges = [], freeCancel = false, breakfast = false }, now = new Date()) {
  const nights = stayNights(checkIn, checkOut, now);
  const party = splitParty({ rooms, adults, childAges });
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const all = await loadHotels(tx, listings, checkIn, checkOut, new Date(now));
    const offers = new Map();
    for (const [id, data] of all) {
      const { startsAt } = stayInstants({ checkIn, checkOut, ...data.hotel });
      let best = null;
      for (const roomType of data.roomTypes) {
        const { available } = availabilityFor(data, roomType, nights);
        if (available < rooms) continue;
        for (const plan of data.plans.filter((row) => row.roomTypeId === roomType.id && row.isActive)) {
          // Free cancellation that already ended for these dates is not free cancellation.
          const { freeUntil } = cancellationTerms(plan, startsAt);
          const freeNow = freeUntil != null && new Date(freeUntil) > new Date(now);
          if (freeCancel && !freeNow) continue;
          if (breakfast && plan.mealPlan === 'EP') continue;
          let price;
          try {
            price = partyPrice(data, nights, roomType, plan, party);
          } catch (error) {
            if (error instanceof HotelError) continue;
            throw error;
          }
          if (!best || price.totalMinor < best.totalMinor) {
            best = {
              roomTypeId: roomType.id, roomTypeName: roomType.name, planId: plan.id, planName: plan.name, mealPlan: plan.mealPlan,
              freeUntil: freeNow ? freeUntil : null, roomsLeft: available, nights: nights.length,
              ...price,
            };
          }
        }
      }
      if (best) offers.set(id, best);
    }
    return offers;
  });
}

/** A priced, availability-checked stay inside the caller's transaction (checkout quote and hold). */
export async function stayQuoteIn(tx, listing, { checkIn, checkOut, rooms }, now) {
  return buildQuote(await loadHotel(tx, listing, checkIn, checkOut, new Date(now)), { checkIn, checkOut, rooms }, now);
}
