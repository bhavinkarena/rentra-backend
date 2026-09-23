import 'server-only';
import { createHash } from 'node:crypto';
import { bookingSelectionSchema, localDateSchema } from '../schemas/zod/booking.js';
import { bookingConfigSchema } from '../schemas/zod/booking-config.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';
import { addLocalDays, buildVisitIntervals, propertyToday } from '../domain/booking-dates.js';
import { legacyRupeesToMinor, priceVisitsMinor } from '../domain/booking-money.js';
import { getPaymentConfiguration } from '../payments/gateway-settings.js';
import { withListingInventory, withListingSnapshot, expireInventoryHolds, findInventoryConflicts, prepareInventoryCheck } from './inventory.js';

export class BookingQuoteError extends Error {
  constructor(code, message, conflicts = []) { super(message); this.code = code; this.conflicts = conflicts; }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const quoteDigest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const dayKey = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value;

function listingConfiguration(listing) {
  const value = listing.booking_config;
  if (!value || !value.inventoryReady) throw new BookingQuoteError('SCHEDULE_UNAVAILABLE', 'The owner needs to confirm the booking hours and calendar.');
  const { timeZone, leadTimeMinutes, bookingHorizonDays, slots } = value;
  const parsed = bookingConfigSchema.safeParse({ timeZone, leadTimeMinutes, bookingHorizonDays, slots });
  if (!parsed.success) throw new BookingQuoteError('SCHEDULE_UNAVAILABLE', 'The booking schedule needs attention.');
  return parsed.data;
}

/** The same immutable inputs drive a persisted quote and each calendar price. */
export function prepareQuote(selection, listing, rates, overrides, payment, now) {
  if (listing.status !== 'live' || listing.total_units !== 1) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
  const config = listingConfiguration(listing);
  const schedule = config.slots[selection.slot];
  const rate = rates.find((row) => row.slot === selection.slot);
  if (!schedule?.enabled || !rate) throw new BookingQuoteError('SLOT_UNAVAILABLE', 'This slot is not offered.');
  if (schedule.capacity > listing.capacity || selection.guests > schedule.capacity) throw new BookingQuoteError('CAPACITY_EXCEEDED', 'The guest count exceeds this slot’s capacity.');
  const visits = buildVisitIntervals({ ...selection, schedule, now, ...config });
  const byDate = {};
  for (const row of overrides) {
    const date = dayKey(row.day);
    byDate[date] = { ...byDate[date], [row.slot]: row.rent_minor != null ? Number(row.rent_minor) : legacyRupeesToMinor(row.price_override) };
  }
  const price = priceVisitsMinor({
    ...selection,
    rate: { ...schedule, weekdayMinor: legacyRupeesToMinor(rate.weekday), weekendMinor: legacyRupeesToMinor(rate.weekend), depositMinor: legacyRupeesToMinor(listing.deposit_amount) },
    overridesByDate: byDate,
  });
  const policy = {
    version: BOOKING_POLICY.version, listingConfigVersion: listing.booking_config_version,
    cancellationTier: listing.cancellation_tier, houseRules: listing.house_rules,
    depositScope: 'per_visit', taxPolicy: 'not_configured', timeZone: config.timeZone,
  };
  // Public quotes remain available while payments are disabled. No credentials
  // or operational credential error details are returned to a browsing guest.
  const paymentSnapshot = {
    version: payment.version, provider: payment.provider, environment: payment.environment,
    mode: payment.mode, enabled: payment.enabled, collectionPurpose: payment.collectionPurpose,
    expectedMinor: payment.collectionPurpose === 'advance' ? price.totals.illustrativeAdvanceMinor : price.totals.totalMinor,
    actualCollectedMinor: 0,
    collectionPolicyVersion: BOOKING_POLICY.version,
    remainingMinor: payment.collectionPurpose === 'advance' ? price.totals.illustrativeBalanceMinor : 0,
    allocations: price.visits.map((visit) => ({
      date: visit.date,
      rentMinor: payment.collectionPurpose === 'advance' ? visit.illustrativeAdvanceMinor - visit.feeMinor : visit.rentMinor,
      feeMinor: visit.feeMinor, depositMinor: 0,
    })),
  };
  const visitSnapshots = visits.map((visit, index) => ({ ...visit, ...price.visits[index] }));
  const pricingVersion = quoteDigest({ rates, overrides, schedule, totals: price.totals }).slice(0, 32);
  const content = { selection, visits: visitSnapshots, totals: price.totals, policy, payment: paymentSnapshot, pricingVersion };
  return { ...content, hash: quoteDigest(content), currency: 'INR', timeZone: config.timeZone };
}

async function currentInputs(tx, listing, selection, variables) {
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  const [owner] = await tx`SELECT id FROM "user" WHERE id=${listing.client_id} AND role='client' AND account_status='active'`;
  if (!owner) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
  await expireInventoryHolds(tx, listing.id, clock.now);
  const rates = await tx`SELECT slot,weekday,weekend FROM rentable_price WHERE rentable_id=${listing.id} ORDER BY slot`;
  const first = selection.dates[0], last = selection.dates.at(-1);
  const legacy = await tx`SELECT day::text AS day,slot,price_override FROM availability WHERE rentable_id=${listing.id} AND day BETWEEN ${first} AND ${last} AND price_override IS NOT NULL ORDER BY day,slot`;
  const explicit = await tx`SELECT day::text AS day,slot,rent_minor FROM booking_price_override WHERE rentable_id=${listing.id} AND day BETWEEN ${first} AND ${last} ORDER BY day,slot`;
  const payment = await getPaymentConfiguration(tx, variables);
  return { now: clock.now, rates, overrides: [...legacy, ...explicit], payment };
}

async function checkedQuote(tx, listing, selection, variables) {
  const inputs = await currentInputs(tx, listing, selection, variables);
  const quote = prepareQuote(selection, listing, inputs.rates, inputs.overrides, inputs.payment, inputs.now);
  const conflicts = await findInventoryConflicts(tx, listing, quote.visits);
  if (conflicts.length) throw new BookingQuoteError('AVAILABILITY_CONFLICT', 'Some visit dates are unavailable. Your selection has been preserved.', conflicts);
  return { ...quote, createdAt: new Date(inputs.now).toISOString(), expiresAt: new Date(new Date(inputs.now).getTime() + BOOKING_POLICY.quoteMinutes * 60_000).toISOString() };
}

/** Discovery checks the complete selection without creating abandoned quote rows. */
export async function previewBookingQuote(database, input, variables = process.env) {
  const selection = bookingSelectionSchema.parse(input);
  return withListingInventory(database, selection.rentableId, (tx, listing) => checkedQuote(tx, listing, selection, variables));
}

export async function createBookingQuote(database, input, { customerId = null, variables = process.env } = {}) {
  const selection = bookingSelectionSchema.parse(input);
  return withListingInventory(database, selection.rentableId, async (tx, listing) => {
    if (customerId) {
      const [customer] = await tx`SELECT id FROM "user" WHERE id=${customerId} AND role='customer' AND account_status='active' FOR SHARE`;
      if (!customer) throw new BookingQuoteError('CUSTOMER_REQUIRED', 'An active customer account is required.');
    }
    const quote = await checkedQuote(tx, listing, selection, variables);
    const [saved] = await tx`
      INSERT INTO booking_quote (customer_id,intent_hash,rentable_id,currency,time_zone,selection,visit_snapshots,
        policy_snapshot,payment_snapshot,pricing_version,policy_version,version,quote_hash,
        amount_rent_minor,amount_fee_minor,amount_deposit_minor,created_at,expires_at)
      VALUES (${customerId},${quoteDigest(selection)},${listing.id},'INR',${quote.timeZone},${JSON.stringify(selection)}::jsonb,${JSON.stringify(quote.visits)}::jsonb,
        ${JSON.stringify(quote.policy)}::jsonb,${JSON.stringify(quote.payment)}::jsonb,${quote.pricingVersion},${BOOKING_POLICY.version},1,${quote.hash},
        ${quote.totals.rentMinor},${quote.totals.feeMinor},${quote.totals.depositMinor},${quote.createdAt},${quote.expiresAt}) RETURNING id`;
    return { ...quote, id: saved.id, version: 1, advisory: true };
  });
}

/** Must be called inside withListingInventory by future hold/confirmation writers. */
export async function revalidateBookingQuote(tx, listing, { quoteId, customerId, hash, version }, variables = process.env) {
  const [saved] = await tx`SELECT * FROM booking_quote WHERE id=${quoteId} AND rentable_id=${listing.id} AND customer_id=${customerId}`;
  if (!customerId || !saved || saved.quote_hash !== hash || saved.version !== version) throw new BookingQuoteError('QUOTE_NOT_FOUND', 'Request a new quote for this account.');
  const [customer] = await tx`SELECT id FROM "user" WHERE id=${customerId} AND role='customer' AND account_status='active' FOR SHARE`;
  if (!customer) throw new BookingQuoteError('CUSTOMER_REQUIRED', 'An active customer account is required.');
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  if (new Date(saved.expires_at) <= new Date(clock.now)) throw new BookingQuoteError('QUOTE_EXPIRED', 'This quote expired. Review a new quote.');
  const quote = await checkedQuote(tx, listing, bookingSelectionSchema.parse(saved.selection), variables);
  if (quote.hash !== saved.quote_hash) throw new BookingQuoteError('QUOTE_CHANGED', 'The price, terms or payment settings changed. Review a new quote.');
  return { ...quote, id: saved.id, version: saved.version, createdAt: new Date(saved.created_at).toISOString(), expiresAt: new Date(saved.expires_at).toISOString() };
}

/** A held order already owns its intervals; recheck terms without conflicting with itself. */
export async function revalidateHeldQuoteTerms(tx, listing, order, variables = process.env) {
  const [saved] = await tx`SELECT * FROM booking_quote WHERE id=${order.quote_id} AND customer_id=${order.customer_id}`;
  if (!saved) throw new BookingQuoteError('QUOTE_NOT_FOUND', 'Request a fresh quote.');
  const inputs = await currentInputs(tx, listing, bookingSelectionSchema.parse(saved.selection), variables);
  if (new Date(saved.expires_at) <= new Date(inputs.now)) throw new BookingQuoteError('QUOTE_EXPIRED', 'Request and accept a fresh quote.');
  const quote = prepareQuote(bookingSelectionSchema.parse(saved.selection), listing, inputs.rates, inputs.overrides, inputs.payment, inputs.now);
  if (quote.hash !== order.quote_hash || saved.version !== order.quote_version) throw new BookingQuoteError('QUOTE_CHANGED', 'Review the changed terms.');
  return quote;
}

/** Batch independent calendar inputs to avoid one remote DB round trip per table.
 * Booking writes still use currentInputs and recheck under the same inventory lock.
 */
async function currentCalendarInputs(tx, listing, dates, variables) {
  const [inputs] = await tx`
    SELECT clock_timestamp() AS now,
      EXISTS(SELECT 1 FROM "user" WHERE id=${listing.client_id}
        AND role='client' AND account_status='active') AS owner_active,
      COALESCE((SELECT json_agg(r ORDER BY r.slot) FROM (
        SELECT slot,weekday,weekend FROM rentable_price WHERE rentable_id=${listing.id}
      ) r), '[]'::json) AS rates,
      COALESCE((SELECT json_agg(a ORDER BY a.day,a.slot) FROM (
        SELECT day::text AS day,slot,price_override FROM availability
        WHERE rentable_id=${listing.id} AND day BETWEEN ${dates[0]} AND ${dates.at(-1)}
          AND price_override IS NOT NULL
      ) a), '[]'::json) AS legacy,
      COALESCE((SELECT json_agg(o ORDER BY o.day,o.slot) FROM (
        SELECT day::text AS day,slot,rent_minor FROM booking_price_override
        WHERE rentable_id=${listing.id} AND day BETWEEN ${dates[0]} AND ${dates.at(-1)}
      ) o), '[]'::json) AS explicit`;
  if (!inputs.owner_active) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
  // prepareInventoryCheck treats expired holds as free in the read-only snapshot.
  const payment = await getPaymentConfiguration(tx, variables);
  return { now: inputs.now, rates: inputs.rates, overrides: [...inputs.legacy, ...inputs.explicit], payment };
}

/** Bounded public read with the same price/config/interval rules as quoting. */
export async function getBookingAvailability(database, { rentableId, from, to, guests = 1 }, variables = process.env) {
  localDateSchema.parse(from);
  localDateSchema.parse(to);
  if (from > to) throw new BookingQuoteError('INVALID_RANGE', 'Choose an ordered date range.');
  const dates = [];
  for (let day = from; day <= to; day = addLocalDays(day, 1)) {
    if (dates.length >= 120) throw new BookingQuoteError('INVALID_RANGE', 'Choose at most 120 calendar days.');
    dates.push(day);
  }
  // A read-only snapshot: painting the calendar never locks or writes, so it
  // cannot queue behind checkout. Every write rechecks under the listing lock.
  return withListingSnapshot(database, rentableId, async (tx, listing) => {
    const days = {};
    const input = bookingSelectionSchema.parse({ rentableId, dates: [from], slot: 'day', guests });
    const [inputs, checkInventory] = await Promise.all([
      currentCalendarInputs(tx, listing, dates, variables),
      prepareInventoryCheck(tx, listing),
    ]);
    for (const date of dates) {
      const entry = { day: false, night: false, full: false, pricesMinor: {}, priceOverride: {}, reasons: {}, intervals: {} };
      for (const slot of ['day', 'night', 'full_day']) {
        try {
          const quote = prepareQuote({ ...input, dates: [date], slot }, listing, inputs.rates, inputs.overrides, inputs.payment, inputs.now);
          const conflicts = checkInventory(quote.visits);
          if (conflicts.length) { entry.reasons[slot] = 'Unavailable'; continue; }
          entry[slot === 'full_day' ? 'full' : slot] = true;
          entry.pricesMinor[slot] = quote.totals;
          entry.priceOverride[slot] = quote.totals.rentMinor / 100; // Temporary legacy picker display boundary.
          entry.intervals[slot] = { startsAt: quote.visits[0].startsAt, endsAt: quote.visits[0].endsAt };
        } catch (error) {
          if (!(error instanceof RangeError) && !error.code) throw error;
          // Database failures must never masquerade as a successful empty calendar.
          if (/^[0-9A-Z]{5}$/.test(error.code ?? '')) throw error;
          entry.reasons[slot] = 'Unavailable';
        }
      }
      days[date] = entry;
    }
    return { from, to, today: propertyToday(inputs.now), timeZone: BOOKING_POLICY.timeZone, advisory: true, days };
  });
}
