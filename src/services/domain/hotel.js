import { applyBasisPoints } from './booking-money.js';
import { addLocalDays, isLocalDate, parseLocalDate, propertyLocalInstant, propertyToday } from './booking-dates.js';

/**
 * Hotel stays (hotel plan, Phase 2). Pure: no database, no clock except the
 * `now` passed in. Availability, quotes, holds and cancellation previews all
 * price through these functions, so the price a guest sees is the price held.
 *
 * A stay is check-in date → check-out date; it occupies the NIGHTS
 * [checkIn, checkOut). Money is integer paise. Tax is decided per room per
 * night on the tariff actually charged (plan rate + extra guests).
 */
export const HOTEL_POLICY = Object.freeze({
  version: 'hotel-v1',
  currency: 'INR',
  timeZone: 'Asia/Kolkata',
  holdMinutes: 15,
  maxNights: 30,
  maxRooms: 8,
  bookingHorizonDays: 365,
});

export class HotelError extends RangeError {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const money = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
};

/** The nights a stay occupies, after checking the dates against the booking window. */
export function stayNights(checkIn, checkOut, now = new Date()) {
  if (!isLocalDate(checkIn) || !isLocalDate(checkOut)) throw new HotelError('DATES_INVALID', 'Choose check-in and check-out dates.');
  if (checkOut <= checkIn) throw new HotelError('DATES_INVALID', 'Check-out must be after check-in.');
  const count = (parseLocalDate(checkOut) - parseLocalDate(checkIn)) / 86_400_000;
  if (count > HOTEL_POLICY.maxNights) throw new HotelError('DATES_INVALID', `Stays can be up to ${HOTEL_POLICY.maxNights} nights.`);
  const today = propertyToday(now);
  if (checkIn < today || checkIn > addLocalDays(today, HOTEL_POLICY.bookingHorizonDays)) {
    throw new HotelError('OUTSIDE_BOOKING_WINDOW', 'These dates cannot be booked.');
  }
  return Array.from({ length: count }, (_, index) => addLocalDays(checkIn, index));
}

export const isWeekendNight = (night, weekendNights) => weekendNights.includes(parseLocalDate(night).getUTCDay());

/** Check-in and check-out as instants (IST), from the hotel's times in minutes after midnight. */
export function stayInstants({ checkIn, checkOut, checkInMinute, checkOutMinute }) {
  const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return { startsAt: propertyLocalInstant(checkIn, hhmm(checkInMinute)), endsAt: propertyLocalInstant(checkOut, hhmm(checkOutMinute)) };
}

/**
 * Who is charged in one room. Children under childFreeAge are free; base
 * occupancy covers adults first. Throws OCCUPANCY when the room cannot take them.
 */
export function roomOccupancy(roomType, { adults, childAges = [] }, childFreeAge) {
  if (!Number.isSafeInteger(adults) || adults < 1 || !Array.isArray(childAges)
    || childAges.some((age) => !Number.isSafeInteger(age) || age < 0 || age > 17)) {
    throw new HotelError('OCCUPANCY', 'Tell us the guests and each child’s age.');
  }
  if (adults > roomType.maxAdults || childAges.length > roomType.maxChildren
    || adults + childAges.length > roomType.maxOccupancy) {
    throw new HotelError('OCCUPANCY', `${roomType.name} takes up to ${roomType.maxOccupancy} guests (${roomType.maxAdults} adults).`);
  }
  const chargedChildren = childAges.filter((age) => age >= childFreeAge).length;
  const extra = Math.max(0, adults + chargedChildren - roomType.baseOccupancy);
  const extraAdults = Math.min(extra, Math.max(0, adults - roomType.baseOccupancy));
  return { guests: adults + childAges.length, chargedGuests: adults + chargedChildren, extraAdults, extraChildren: extra - extraAdults };
}

/** A plan's price for one room-night before extra guests. Derived plans follow their base plan. */
export function planNightRate({ plan, basePlan, overrides = {}, night, weekendNights, chargedGuests }) {
  const base = plan.derivedFrom ? basePlan : plan;
  if (!base || base.derivedFrom || (plan.derivedFrom && plan.derivedFrom !== base.id)) {
    throw new HotelError('PRICE_MISSING', 'This rate has no price yet.');
  }
  const weekend = isWeekendNight(night, weekendNights);
  const own = overrides[night] ?? (weekend ? base.weekendMinor : base.weekdayMinor);
  money(own, 'Rate');
  if (!plan.derivedFrom) return { rateMinor: own, source: overrides[night] != null ? 'override' : weekend ? 'weekend' : 'weekday' };
  const pct = plan.derivedPctBps;
  const adjusted = pct >= 0 ? own + applyBasisPoints(own, pct) : own - applyBasisPoints(own, -pct);
  return { rateMinor: adjusted + money(plan.derivedPerGuestMinor, 'Per-guest charge') * chargedGuests, source: 'derived' };
}

/** The slab for one room-night's tariff on that night; throws TAX_UNCONFIGURED rather than guessing 0%. */
export function taxBpsFor(rateMinor, night, slabs) {
  const slab = slabs.find((row) => rateMinor >= row.minRateMinor && (row.maxRateMinor == null || rateMinor <= row.maxRateMinor)
    && night >= row.effectiveFrom && (row.effectiveTo == null || night <= row.effectiveTo));
  if (!slab) throw new HotelError('TAX_UNCONFIGURED', 'Tax for this price is not configured.');
  return slab.taxBps;
}

/**
 * One room for the whole stay: per-night tariff, slab, tax; totals.
 * hotel: { weekendNights, childFreeAge }. rooms/plans in camelCase.
 */
export function priceRoomStay({ nights, roomType, plan, basePlan, overrides, hotel, slabs, adults, childAges }) {
  const occupancy = roomOccupancy(roomType, { adults, childAges }, hotel.childFreeAge);
  const extrasMinor = occupancy.extraAdults * money(roomType.extraAdultMinor, 'Extra adult charge')
    + occupancy.extraChildren * money(roomType.extraChildMinor, 'Extra child charge');
  let roomMinor = 0;
  let taxMinor = 0;
  const priced = nights.map((night) => {
    const { rateMinor: planMinor, source } = planNightRate({ plan, basePlan, overrides, night, weekendNights: hotel.weekendNights, chargedGuests: occupancy.chargedGuests });
    const rateMinor = planMinor + extrasMinor;
    const taxBps = taxBpsFor(rateMinor, night, slabs);
    const tax = applyBasisPoints(rateMinor, taxBps);
    roomMinor += rateMinor;
    taxMinor += tax;
    return { night, rateMinor, source, taxBps, taxMinor: tax };
  });
  if (!Number.isSafeInteger(roomMinor + taxMinor)) throw new RangeError('Amount exceeds safe integer range');
  return { nights: priced, occupancy, roomMinor, taxMinor, totalMinor: roomMinor + taxMinor };
}

/** The guest-facing promise for a plan, from its rules (never free text). */
export function cancellationTerms(plan, checkInAt) {
  const freeUntil = plan.freeCancelHours == null ? null
    : new Date(new Date(checkInAt).getTime() - plan.freeCancelHours * 3_600_000).toISOString();
  return { freeUntil, lateCharge: plan.lateCharge, noShow: plan.noShow };
}

/**
 * Refund if the guest cancels one room line now. Free before the deadline;
 * after it and before check-in, the late charge is kept; from check-in the
 * stay has started (no-show or early departure are hotel/support cases).
 * line: { totalMinor, nights: [{ rateMinor, taxMinor }], plan: { freeCancelHours, lateCharge } }.
 */
export function hotelRefund(line, checkInAt, now) {
  const remaining = new Date(checkInAt).getTime() - new Date(now).getTime();
  if (!Number.isFinite(remaining)) throw new RangeError('Invalid clock');
  if (remaining <= 0) throw new HotelError('STAY_STARTED', 'The stay has started. Contact support to change it.');
  const total = money(line.totalMinor, 'Total');
  const { freeCancelHours, lateCharge } = line.plan;
  if (freeCancelHours != null && remaining >= freeCancelHours * 3_600_000) {
    return { refundMinor: total, chargeMinor: 0, free: true };
  }
  const first = line.nights[0];
  const charge = lateCharge === 'full_stay' ? total : Math.min(total, first.rateMinor + first.taxMinor);
  return { refundMinor: total - charge, chargeMinor: charge, free: false };
}

/** What a no-show keeps for one room line. */
export function noShowCharge(line) {
  const total = money(line.totalMinor, 'Total');
  if (line.plan.noShow === 'full_stay') return total;
  const first = line.nights[0];
  return Math.min(total, first.rateMinor + first.taxMinor);
}

/**
 * Rooms of one type still sellable for every night of the stay, and why not
 * when zero. Closed-to-arrival and minimum nights apply to the arrival night. nightRows: room_night rows in camelCase; a missing night is open
 * with allotment = roomCount.
 */
export function roomTypeAvailability({ roomCount, nights, nightRows, minNights = 1 }) {
  const byNight = new Map(nightRows.map((row) => [row.night, row]));
  let available = roomCount;
  let reason = null;
  for (const [index, night] of nights.entries()) {
    const row = byNight.get(night);
    if (!row) continue;
    if (row.stopSell) { available = 0; reason ??= 'CLOSED'; continue; }
    if (index === 0 && row.closedToArrival) { available = 0; reason ??= 'CLOSED_TO_ARRIVAL'; }
    if (index === 0 && row.minNights && nights.length < row.minNights) { available = 0; reason ??= 'MIN_NIGHTS'; }
    available = Math.min(available, Math.max(0, row.allotment - row.sold - row.held));
  }
  if (nights.length < minNights) { available = 0; reason ??= 'MIN_NIGHTS'; }
  if (available === 0) reason ??= 'SOLD_OUT';
  return { available, reason };
}
