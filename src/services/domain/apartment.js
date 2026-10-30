import { BED_CAPACITY, bedCapacity } from './hotel-rooms.js';
import { propertyLocalInstant } from './booking-dates.js';

/**
 * Story 3.10: a whole apartment, one exclusive nightly unit (rental_unit 'unit_night', category under the
 * hotel vertical). The owner's setup is saved in three parts: `unit`, `stay` and `price`.
 * Mirrored in Rentra/lib/domain/apartment.js — keep both in step.
 */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const APARTMENT_PARTS = ['unit', 'stay', 'price'];
export const MAX_NIGHTS = 90;
export const MAX_ARRIVAL_RANGES = 20;
export const MAX_CLEANING_FEE = 50000;

/** Defaults the forms start from (nothing is saved until the owner saves each part). */
export const APARTMENT_DEFAULTS = Object.freeze({
  bedrooms: 1, bathrooms: 1, beds: [], maxAdults: 2, maxChildren: 0, maxOccupants: 2,
  minNights: 1, maxNights: 30, arrivalRules: { weekdays: {}, ranges: [] },
  checkInTime: '14:00', checkOutTime: '11:00', turnoverNights: 0,
  weekday: null, weekend: null, cleaningFee: 0, weekendNights: [5, 6],
});

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const minuteOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
export const clockOf = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** Why one part of the setup cannot be saved, or null. */
export function apartmentProblem(part, v) {
  if (!v || typeof v !== 'object') return 'Fill in this section';
  if (part === 'unit') {
    if (!int(v.bedrooms, 0, 20)) return 'Bedrooms must be from 0 to 20';
    if (!int(v.bathrooms, 1, 20)) return 'Bathrooms must be from 1 to 20';
    if (!Array.isArray(v.beds) || !v.beds.length) return 'Add the beds';
    if (v.beds.length > 8 || v.beds.some((b) => !b || !(b.type in BED_CAPACITY) || !int(b.count, 1, 20))) return 'Choose each bed type and a count from 1 to 20';
    if (!int(v.maxAdults, 1, 30)) return 'Max adults must be from 1 to 30';
    if (!int(v.maxChildren, 0, 20)) return 'Max children must be from 0 to 20';
    if (!int(v.maxOccupants, 1, 50)) return 'Max occupants must be from 1 to 50';
    if (v.maxOccupants < v.maxAdults) return 'Max occupants cannot be fewer than max adults';
    const sleeps = bedCapacity(v.beds);
    if (sleeps < v.maxAdults) return `These beds sleep ${sleeps}; add a sleeping place or lower max adults to ${sleeps}`;
    return null;
  }
  if (part === 'stay') {
    if (!int(v.minNights, 1, MAX_NIGHTS)) return `Minimum nights must be from 1 to ${MAX_NIGHTS}`;
    if (!int(v.maxNights, 1, MAX_NIGHTS)) return `Maximum nights must be from 1 to ${MAX_NIGHTS}`;
    if (v.minNights > v.maxNights) return 'Minimum nights cannot be more than maximum nights';
    const within = (n) => int(n, v.minNights, v.maxNights);
    const rules = v.arrivalRules ?? { weekdays: {}, ranges: [] };
    const weekdays = rules.weekdays ?? {};
    if (typeof weekdays !== 'object' || Array.isArray(weekdays)) return 'Choose arrival-day minimums';
    for (const [day, n] of Object.entries(weekdays)) {
      if (!WEEKDAYS.includes(day)) return 'Choose arrival-day minimums';
      if (!within(n)) return `Arrival-day minimums must be from ${v.minNights} to ${v.maxNights} nights`;
    }
    const ranges = rules.ranges ?? [];
    if (!Array.isArray(ranges) || ranges.length > MAX_ARRIVAL_RANGES) return `Add at most ${MAX_ARRIVAL_RANGES} date-range minimums`;
    for (const r of ranges) {
      if (!r || !validDate(r.from) || !validDate(r.to) || r.from > r.to) return 'Each date range needs a start on or before its end';
      if (!within(r.minNights)) return `Date-range minimums must be from ${v.minNights} to ${v.maxNights} nights`;
    }
    if (!CLOCK.test(v.checkInTime ?? '') || !CLOCK.test(v.checkOutTime ?? '')) return 'Use HH:mm for check-in and check-out';
    if (minuteOf(v.checkOutTime) >= minuteOf(v.checkInTime)) return 'Check-out must be before check-in on the same day';
    if (!int(v.turnoverNights, 0, 3)) return 'Turnover must be from 0 to 3 nights';
    return null;
  }
  if (part === 'price') {
    if (!int(v.weekday, 1, 500000) || !int(v.weekend, 1, 500000)) return 'Enter weekday and weekend prices in whole rupees';
    if (!int(v.cleaningFee, 0, MAX_CLEANING_FEE)) return `Cleaning fee must be from 0 to ${MAX_CLEANING_FEE.toLocaleString('en-IN')} rupees`;
    if (!Array.isArray(v.weekendNights) || v.weekendNights.some((d) => !int(d, 0, 6))) return 'Choose the weekend nights';
    return null;
  }
  return 'Unknown apartment section';
}

/** The stored form of the arrival rules: weekday keys in order, ranges by start date. */
export function normalizeArrivalRules(rules = {}) {
  const weekdays = Object.fromEntries(WEEKDAYS.filter((d) => rules.weekdays?.[d] != null).map((d) => [d, rules.weekdays[d]]));
  const ranges = (rules.ranges ?? []).map(({ from, to, minNights }) => ({ from, to, minNights })).sort((a, b) => a.from.localeCompare(b.from));
  return { weekdays, ranges };
}

/** "No cleaning fee" or "Cleaning fee ₹1,500 per stay". */
export const cleaningFeeLine = (rupees) => (rupees ? `Cleaning fee ₹${rupees.toLocaleString('en-IN')} per stay` : 'No cleaning fee');

/* ---------------------------------------------------------------------------------------------- *
 * Story 3.11: booking a whole apartment. Pure rules and price; the service reads the profile.
 * ---------------------------------------------------------------------------------------------- */
const DAY_MS = 86_400_000;
const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
export const APARTMENT_HORIZON_DAYS = 365;
const dayIndex = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Weekday key (mon..sun) of a local date. */
export const weekdayKey = (date) => WEEKDAYS[(dayIndex(date) + 6) % 7];

/** The minimum nights for an arrival on `checkIn`, and why (the strictest rule wins). */
export function arrivalMinimum(profile, checkIn) {
  let min = profile.minNights, reason = null;
  const key = weekdayKey(checkIn);
  const day = profile.arrivalRules?.weekdays?.[key];
  if (day != null && day > min) { min = day; reason = `for ${WEEKDAY_NAMES[key]} arrival`; }
  for (const r of profile.arrivalRules?.ranges ?? []) {
    if (checkIn >= r.from && checkIn <= r.to && r.minNights > min) { min = r.minNights; reason = `for arrivals from ${r.from} to ${r.to}`; }
  }
  return { min, reason };
}

/**
 * Why this stay cannot be quoted ({ code, message }), or null. `today` is the property-local date.
 * Codes: DATES_INVALID, OUTSIDE_BOOKING_WINDOW, MIN_NIGHTS, MAX_NIGHTS, OCCUPANCY.
 */
export function apartmentStayProblem(profile, { checkIn, checkOut, adults, childAges = [] }, today) {
  if (!validDate(checkIn) || !validDate(checkOut)) return { code: 'DATES_INVALID', message: 'Choose check-in and check-out dates.' };
  if (checkOut <= checkIn) return { code: 'DATES_INVALID', message: 'Check-out must be after check-in.' };
  if (checkIn < today || checkIn > addDays(today, APARTMENT_HORIZON_DAYS)) return { code: 'OUTSIDE_BOOKING_WINDOW', message: 'These dates cannot be booked.' };
  const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
  if (nights > profile.maxNights) return { code: 'MAX_NIGHTS', message: `Maximum ${profile.maxNights} night${profile.maxNights === 1 ? '' : 's'}` };
  const { min, reason } = arrivalMinimum(profile, checkIn);
  if (nights < min) return { code: 'MIN_NIGHTS', message: `Minimum ${min} night${min === 1 ? '' : 's'}${reason ? ` ${reason}` : ''}` };
  if (!Number.isInteger(adults) || adults < 1) return { code: 'OCCUPANCY', message: 'At least one adult is needed.' };
  if (!Array.isArray(childAges) || childAges.some((age) => !int(age, 0, 17))) return { code: 'OCCUPANCY', message: 'Enter each child’s age from 0 to 17.' };
  if (adults > profile.maxAdults) return { code: 'OCCUPANCY', message: `Up to ${profile.maxAdults} adult${profile.maxAdults === 1 ? '' : 's'}` };
  if (childAges.length > profile.maxChildren) return { code: 'OCCUPANCY', message: profile.maxChildren ? `Up to ${profile.maxChildren} child${profile.maxChildren === 1 ? '' : 'ren'}` : 'This apartment does not take children' };
  if (adults + childAges.length > profile.maxOccupants) return { code: 'OCCUPANCY', message: `Up to ${profile.maxOccupants} guests in total` };
  return null;
}

/** Each night's flat unit price (weekend nights by `weekendNights`, Date#getUTCDay of the night). */
export function apartmentNights(profile, checkIn, checkOut) {
  const nights = [];
  for (let night = checkIn; night < checkOut; night = addDays(night, 1)) {
    const weekend = profile.weekendNights.includes(dayIndex(night));
    nights.push({ night, rateMinor: weekend ? profile.weekendMinor : profile.weekdayMinor, taxMinor: 0, weekend });
  }
  return nights;
}

/** Rent (nights), the one-off cleaning fee and the pet charge, in integer paise. */
export function apartmentPrice(profile, nights, petMinor = 0) {
  const rentMinor = nights.reduce((sum, n) => sum + n.rateMinor, 0);
  const cleaningMinor = profile.cleaningMinor;
  [rentMinor, cleaningMinor, petMinor].forEach((v) => { if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('Invalid apartment amount'); });
  return { rentMinor, cleaningMinor, petMinor, stayMinor: rentMinor + cleaningMinor + petMinor };
}

/** Local midnight (IST) of a date, as an ISO instant. */
export const localMidnight = (date, timeZone) => propertyLocalInstant(date, '00:00', timeZone);
/** The exclusive range one stay holds: check-in midnight up to midnight of checkout + turnover nights, [). */
export const reservationRange = (checkIn, checkOut, turnoverNights) =>
  ({ blockedStartAt: localMidnight(checkIn), blockedEndAt: localMidnight(addDays(checkOut, turnoverNights)) });
