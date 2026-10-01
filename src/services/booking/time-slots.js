import 'server-only';
import { addLocalDays, propertyToday } from '../domain/booking-dates.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';
import { HourlyError, buildHourlyVisit, candidateStarts, dayKind, minuteToHhmm, operatingWindows, priceHourlyVisit } from '../domain/hourly.js';
import { bookingModel } from '../domain/verticals.js';
import { prepareHourlyInventoryCheck, withListingSnapshot } from './inventory.js';
import { BookingQuoteError, hourlyCandidates, hourlyInputs, listingConfiguration, requireBookableListing } from './quotes.js';
import { logger } from '@/utils/logger.js';

/**
 * Public time grid for a time-booked venue (entertainment plan, Phase 4/9).
 * Read-only snapshot: never locks or writes. Uses the same visit, price and
 * court checks as the quote, so every start shown here is one the hold accepts
 * (unless someone else takes it first). Reveals only free/busy, court names and
 * prices: no booking ids, customers or hold times.
 */
async function venueInputs(tx, listing) {
  if (bookingModel(listing) !== 'hourly') throw new BookingQuoteError('UNSUPPORTED_INVENTORY', 'This listing is booked by slot.');
  if (listing.status !== 'live') throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This venue is not available for booking.');
  await requireBookableListing(tx, listing);
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  return { now: clock.now, config: listingConfiguration(listing), ...(await hourlyInputs(tx, listing)) };
}

function durationsFor(config) {
  const values = [];
  for (let minutes = config.minDurationMinutes; minutes <= config.maxDurationMinutes; minutes += config.stepMinutes) values.push(minutes);
  return values;
}

// An owner data gap (open hours without a price band) hides those starts; say so once per process.
// ponytail: per-process memory, so each server instance logs it once; move to a metric if it matters.
const priceGapsLogged = new Set();
function logPriceGap(rentableId, activityId, kind) {
  const key = `${rentableId}:${activityId}:${kind}`;
  if (priceGapsLogged.has(key)) return;
  priceGapsLogged.add(key);
  logger.warn('PRICE_MISSING advisory: opening hours without a price band', { rentableId, activityId, dayKind: kind });
}

/** Every bookable start on one operating day, with its price and free courts. */
function gridFor({ inputs, check, eligible, date, durationMinutes, activityId, rentableId }) {
  const bands = inputs.bands.filter((band) => band.categoryId === activityId && band.dayKind === dayKind(date));
  const lowest = Math.min(...bands.map((band) => Number(band.hourlyRateMinor)));
  const times = [];
  for (const startMinute of candidateStarts(inputs.config, date, durationMinutes)) {
    let visit, price;
    try {
      visit = buildHourlyVisit({ date, start: minuteToHhmm(startMinute), durationMinutes, config: inputs.config, now: inputs.now });
      price = priceHourlyVisit({ bands, date, startMinute, durationMinutes });
    } catch (error) {
      if (error instanceof HourlyError) {
        // Past lead time, outside the horizon or unpriced: not offered.
        if (error.code === 'PRICE_MISSING') logPriceGap(rentableId, activityId, dayKind(date));
        continue;
      }
      throw error;
    }
    const { freeResourceIds } = check(visit, eligible.map((row) => row.id));
    if (!freeResourceIds.length) continue;
    times.push({
      start: visit.start,
      end: minuteToHhmm(startMinute + durationMinutes),
      endsNextDay: visit.endsNextDay,
      rentMinor: price.rentMinor,
      peak: price.segments.some((segment) => segment.hourlyRateMinor > lowest),
      freeResourceIds,
    });
  }
  return times;
}

function windowForDays(first, last) {
  // Operating days may run to 06:00 the next morning; inventoryWindow-style margin of two days.
  return { from: new Date(`${addLocalDays(first, -2)}T00:00:00+05:30`).toISOString(), to: new Date(`${addLocalDays(last, 3)}T00:00:00+05:30`).toISOString() };
}

export async function getTimeSlots(database, { rentableId, date, activity, durationMinutes, guests = 1 }) {
  return withListingSnapshot(database, rentableId, async (tx, listing) => {
    const inputs = await venueInputs(tx, listing);
    const { activity: chosen, eligible } = hourlyCandidates(inputs, { activity, guests, resourceId: null });
    const check = await prepareHourlyInventoryCheck(tx, listing, windowForDays(date, date));
    const times = gridFor({ inputs, check, eligible, date, durationMinutes, activityId: chosen.id, rentableId });
    const today = propertyToday(inputs.now);
    let nextOpenDate = null;
    for (let offset = 1; offset <= 30 && !times.length; offset += 1) {
      const candidate = addLocalDays(date, offset);
      if (candidate > addLocalDays(today, inputs.config.bookingHorizonDays)) break;
      if (operatingWindows(inputs.config, candidate).length) { nextOpenDate = candidate; break; }
    }
    return {
      date, timeZone: BOOKING_POLICY.timeZone, activity: chosen.slug,
      stepMinutes: inputs.config.stepMinutes, durationMinutes, durations: durationsFor(inputs.config),
      open: operatingWindows(inputs.config, date).map((w) => ({
        open: minuteToHhmm(w.startMin), close: minuteToHhmm(w.endMin), closesNextDay: w.endMin > 1440,
      })),
      resources: eligible.map((row) => ({ id: row.id, name: row.name, capacity: row.capacity })),
      times, nextOpenDate, advisory: false,
    };
  });
}

/** Date strip: per day, is the venue open and how many starts are still free. */
export async function getHourlyAvailability(database, { rentableId, from, days, activity, durationMinutes, guests = 1 }) {
  return withListingSnapshot(database, rentableId, async (tx, listing) => {
    const inputs = await venueInputs(tx, listing);
    const today = propertyToday(inputs.now);
    const first = from && from > today ? from : today;
    const last = addLocalDays(first, days - 1);
    const { activity: chosen, eligible } = hourlyCandidates(inputs, { activity, guests, resourceId: null });
    const check = await prepareHourlyInventoryCheck(tx, listing, windowForDays(first, last));
    const result = {};
    for (let date = first; date <= last; date = addLocalDays(date, 1)) {
      const open = operatingWindows(inputs.config, date).length > 0;
      result[date] = { open, freeStarts: open ? gridFor({ inputs, check, eligible, date, durationMinutes, activityId: chosen.id, rentableId }).length : 0 };
    }
    return { from: first, to: last, today, timeZone: BOOKING_POLICY.timeZone, activity: chosen.slug, durationMinutes, advisory: true, days: result };
  });
}
