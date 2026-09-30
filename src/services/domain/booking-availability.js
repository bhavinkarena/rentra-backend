import { addLocalDays, isLocalDate, propertyToday } from './booking-dates.js';

export function availabilityDateRange({ from, days, now = new Date() }) {
  if (from !== undefined && !isLocalDate(from)) throw new RangeError('Invalid start date');
  if (!Number.isInteger(days) || days < 1 || days > 120) throw new RangeError('Choose 1–120 calendar days');
  const today = propertyToday(now);
  const start = from && from > today ? from : today;
  return { from: start, to: addLocalDays(start, days - 1) };
}
