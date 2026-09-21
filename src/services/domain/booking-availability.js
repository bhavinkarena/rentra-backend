import { addLocalDays, isLocalDate, propertyToday } from './booking-dates.js';

export function availabilityDateRange({ from, days, now = new Date() }) {
  if (from !== undefined && !isLocalDate(from)) throw new RangeError('Invalid start date');
  if (!Number.isInteger(days) || days < 1 || days > 120) throw new RangeError('Choose 1–120 calendar days');
  const today = propertyToday(now);
  const start = from && from > today ? from : today;
  return { from: start, to: addLocalDays(start, days - 1) };
}

/**
 * Advisory legacy calendar only. This is not interval inventory: the later
 * reservation ledger will resolve cross-date overlaps and exact slot hours.
 */
export function legacyAvailabilityDays(rows) {
  const days = {};
  for (const row of rows) {
    if (!isLocalDate(row.day) || !['day', 'night'].includes(row.slot)) continue;
    const entry = days[row.day] ?? (days[row.day] = { day: false, night: false, full: false });
    // An omitted owner-block flag is unknown, not permission to sell.
    entry[row.slot] = row.blockedByClient === false && row.unitsAvailable > 0;
    if (row.priceOverride != null) {
      entry.priceOverride = { ...entry.priceOverride, [row.slot]: row.priceOverride };
    }
  }
  for (const entry of Object.values(days)) entry.full = entry.day && entry.night;
  return days;
}
