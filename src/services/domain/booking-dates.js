import { BOOKING_POLICY, BOOKING_SLOTS } from './booking-policy.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const KOLKATA_OFFSET_MINUTES = 330;

/** A local calendar date is a string, never a browser-local instant. */
export function isLocalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseLocalDate(value) {
  if (!isLocalDate(value)) throw new RangeError('Use a valid YYYY-MM-DD calendar date');
  // UTC here is only a container for calendar arithmetic, not a visit time.
  return new Date(`${value}T00:00:00.000Z`);
}

export function addLocalDays(value, count) {
  if (!Number.isSafeInteger(count)) throw new RangeError('Day count must be an integer');
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + count);
  const result = date.toISOString().slice(0, 10);
  if (!isLocalDate(result)) throw new RangeError('Date is outside the supported calendar');
  return result;
}

function assertTimeZone(timeZone) {
  // Current properties are in India. Never silently apply this offset to a
  // future timezone with different rules or daylight-saving transitions.
  if (timeZone !== BOOKING_POLICY.timeZone) throw new RangeError('Unsupported property timezone');
}

export function propertyToday(now = new Date(), timeZone = BOOKING_POLICY.timeZone) {
  assertTimeZone(timeZone);
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new RangeError('Invalid clock');
  return new Date(instant.getTime() + KOLKATA_OFFSET_MINUTES * MINUTE_MS).toISOString().slice(0, 10);
}

export function isWeekendLocalDate(value) {
  const day = parseLocalDate(value).getUTCDay();
  return day === 0 || day === 6;
}

export function formatLocalDate(value, options = {}) {
  return parseLocalDate(value).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', ...options, timeZone: 'UTC',
  });
}

export function normalizeVisitDates(dates) {
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > BOOKING_POLICY.maxVisits) {
    throw new RangeError(`Choose 1–${BOOKING_POLICY.maxVisits} visits`);
  }
  for (const date of dates) parseLocalDate(date);
  if (new Set(dates).size !== dates.length) throw new RangeError('Duplicate visit dates are not allowed');
  return [...dates].sort();
}

/** Inclusive visit-start dates; a consecutive selection is not continuous access. */
export function consecutiveVisitDates(startDate, endDate) {
  const count = (parseLocalDate(endDate) - parseLocalDate(startDate)) / DAY_MS + 1;
  if (count < 1 || count > BOOKING_POLICY.maxVisits) {
    throw new RangeError(`Choose an ordered range of 1–${BOOKING_POLICY.maxVisits} visits`);
  }
  return Array.from({ length: count }, (_, index) => addLocalDays(startDate, index));
}

function minutesOfDay(time) {
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new RangeError('Slot hours must use HH:mm');
  }
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function propertyLocalInstant(date, time, timeZone = BOOKING_POLICY.timeZone) {
  assertTimeZone(timeZone);
  return new Date(parseLocalDate(date).getTime() + (minutesOfDay(time) - KOLKATA_OFFSET_MINUTES) * MINUTE_MS).toISOString();
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative integer`);
  return value;
}

/** Resolve explicitly configured hours. Legacy display labels are not schedules. */
export function visitInterval({ date, slot, schedule, timeZone = BOOKING_POLICY.timeZone }) {
  assertTimeZone(timeZone);
  if (!BOOKING_SLOTS.includes(slot) || !schedule || schedule.enabled !== true) {
    throw new RangeError('This slot has no enabled booking schedule');
  }
  const startMinutes = minutesOfDay(schedule.startTime);
  const endMinutes = minutesOfDay(schedule.endTime);
  const offset = schedule.endDayOffset;
  if (![0, 1].includes(offset) || (slot === 'day' && offset !== 0) || (slot === 'night' && offset !== 1)) {
    throw new RangeError('Explicit slot end day is invalid');
  }
  // Buffers are mandatory, even when zero: absent data must not imply safety.
  const before = nonnegativeInteger(schedule.bufferBeforeMinutes, 'Buffer before');
  const after = nonnegativeInteger(schedule.bufferAfterMinutes, 'Buffer after');
  const base = parseLocalDate(date).getTime() - KOLKATA_OFFSET_MINUTES * MINUTE_MS;
  const start = base + startMinutes * MINUTE_MS;
  const end = base + offset * DAY_MS + endMinutes * MINUTE_MS;
  if (end <= start) throw new RangeError('A visit must end after it starts');
  return {
    date, slot, timeZone,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    blockedStartAt: new Date(start - before * MINUTE_MS).toISOString(),
    blockedEndAt: new Date(end + after * MINUTE_MS).toISOString(),
    durationMinutes: (end - start) / MINUTE_MS,
  };
}

/** Half-open occupied ranges: touching boundaries are allowed, overlaps are not. */
export function intervalsOverlap(left, right) {
  const values = [left.blockedStartAt, left.blockedEndAt, right.blockedStartAt, right.blockedEndAt]
    .map((value) => new Date(value).getTime());
  if (values.some((value) => !Number.isFinite(value)) || values[0] >= values[1] || values[2] >= values[3]) {
    throw new RangeError('Invalid occupied interval');
  }
  return values[0] < values[3] && values[2] < values[1];
}

/** Pure preflight. The inventory service must still recheck under its DB lock. */
export function buildVisitIntervals({
  dates, slot, schedule, now = new Date(), timeZone = BOOKING_POLICY.timeZone,
  leadTimeMinutes, bookingHorizonDays,
}) {
  nonnegativeInteger(leadTimeMinutes, 'Lead time');
  nonnegativeInteger(bookingHorizonDays, 'Booking horizon');
  const today = propertyToday(now, timeZone);
  const lastDate = addLocalDays(today, bookingHorizonDays);
  const cutoff = new Date(now).getTime() + leadTimeMinutes * MINUTE_MS;
  const visits = normalizeVisitDates(dates).map((date) => {
    const visit = visitInterval({ date, slot, schedule, timeZone });
    if (date < today || date > lastDate || new Date(visit.startsAt).getTime() <= cutoff) {
      throw new RangeError(`Visit ${date} is outside the booking window`);
    }
    return visit;
  });
  for (let index = 1; index < visits.length; index += 1) {
    if (intervalsOverlap(visits[index - 1], visits[index])) {
      throw new RangeError(`Visits ${visits[index - 1].date} and ${visits[index].date} overlap`);
    }
  }
  return visits;
}
