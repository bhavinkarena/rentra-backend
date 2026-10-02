import { currentPolicyReferences } from '../content/service.js';
import 'server-only';
import { createHash } from 'node:crypto';
import { bookingSelectionSchema, localDateSchema } from '../schemas/zod/booking.js';
import { bookingConfigSchema, hourlyBookingConfigSchema } from '../schemas/zod/booking-config.js';
import { CANCELLATION_TIERS, CANCELLATION_TIERS_HOURLY } from '../domain/pricing.js';
import { bookingModel } from '../domain/verticals.js';
import { HourlyError, buildHourlyVisit, priceHourlyVisit } from '../domain/hourly.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';
import { addLocalDays, buildVisitIntervals, propertyToday } from '../domain/booking-dates.js';
import { priceVisitsMinor, sumVisitTotals, visitMoneyMinor } from '../domain/booking-money.js';
import { getPaymentConfiguration } from '../payments/gateway-settings.js';
import { withListingSnapshot, expireInventoryHolds, findInventoryConflicts, prepareInventoryCheck,
  prepareHourlyInventoryCheck, inventoryWindow, isReadOnlyInventory } from './inventory.js';

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

export function listingConfiguration(listing) {
  const value = listing.booking_config;
  if (!value || !value.inventoryReady) throw new BookingQuoteError('SCHEDULE_UNAVAILABLE', 'The owner needs to confirm the booking hours and calendar.');
  if (bookingModel(listing) === 'hourly') {
    const { inventoryReady: _inventoryReady, ...config } = value;
    const parsed = hourlyBookingConfigSchema.safeParse(config);
    if (!parsed.success) throw new BookingQuoteError('SCHEDULE_UNAVAILABLE', 'The booking schedule needs attention.');
    return parsed.data;
  }
  // A config in the other model's shape is a misconfiguration, never a silent default.
  if (value.model === 'hourly') throw new BookingQuoteError('SCHEDULE_UNAVAILABLE', 'The booking schedule needs attention.');
  const { timeZone, leadTimeMinutes, bookingHorizonDays, slots } = value;
  const parsed = bookingConfigSchema.safeParse({ timeZone, leadTimeMinutes, bookingHorizonDays, slots });
  if (!parsed.success) throw new BookingQuoteError('SCHEDULE_UNAVAILABLE', 'The booking schedule needs attention.');
  return parsed.data;
}

function paymentSnapshotFor(payment, visits, totals) {
  return {
    version: payment.version, provider: payment.provider, environment: payment.environment,
    mode: payment.mode, enabled: payment.enabled, collectionPurpose: payment.collectionPurpose,
    expectedMinor: payment.collectionPurpose === 'advance' ? totals.illustrativeAdvanceMinor : totals.totalMinor,
    actualCollectedMinor: 0,
    collectionPolicyVersion: BOOKING_POLICY.version,
    remainingMinor: payment.collectionPurpose === 'advance' ? totals.illustrativeBalanceMinor : 0,
    allocations: visits.map((visit) => ({
      date: visit.date,
      rentMinor: payment.collectionPurpose === 'advance' ? visit.illustrativeAdvanceMinor - visit.feeMinor : visit.rentMinor,
      feeMinor: visit.feeMinor, depositMinor: 0,
    })),
  };
}

/**
 * Courts that can take this selection, in the order holds assign them.
 * inputs.resources are active courts ordered by sort_order, name, id.
 */
export function hourlyCandidates(inputs, selection) {
  const activity = inputs.activities.find((row) => row.slug === selection.activity);
  if (!activity) throw new BookingQuoteError('ACTIVITY_UNAVAILABLE', 'This venue does not offer that activity right now.');
  const offered = inputs.resources.filter((row) => row.activities.includes(activity.id));
  if (!offered.length) throw new BookingQuoteError('ACTIVITY_UNAVAILABLE', 'This venue does not offer that activity right now.');
  const eligible = offered.filter((row) => row.capacity >= selection.guests);
  if (!eligible.length) throw new BookingQuoteError('CAPACITY_EXCEEDED', 'No court here takes that many players.');
  if (selection.resourceId && !eligible.some((row) => row.id === selection.resourceId)) {
    throw new BookingQuoteError('RESOURCE_UNAVAILABLE', 'That court cannot take this booking. Choose another court.');
  }
  return { activity, eligible: selection.resourceId ? eligible.filter((row) => row.id === selection.resourceId) : eligible };
}

/**
 * A time-booked visit at a venue (entertainment plan, Phase 4). Same output
 * shape and hashing as prepareQuote; the assigned court is NOT part of the
 * hash when the guest chose "any court", because every eligible court of an
 * activity has the same price.
 */
export function prepareHourlyQuote(selection, listing, inputs, now, publications) {
  if (listing.status !== 'live' || listing.total_units !== 1 || bookingModel(listing) !== 'hourly') {
    throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This venue is not available for booking.');
  }
  const config = listingConfiguration(listing);
  const { activity } = hourlyCandidates(inputs, selection);
  const bands = inputs.bands.filter((band) => band.categoryId === activity.id);
  let visit, price;
  try {
    visit = buildHourlyVisit({ date: selection.date, start: selection.start, durationMinutes: selection.durationMinutes, config, now });
    price = priceHourlyVisit({ bands, date: selection.date, startMinute: visit.startMinute, durationMinutes: selection.durationMinutes });
  } catch (error) {
    if (error instanceof HourlyError) throw new BookingQuoteError(error.code, error.message);
    throw error;
  }
  const money = visitMoneyMinor({ baseRentMinor: price.rentMinor, depositMinor: Number(listing.deposit_minor) });
  const priced = { date: selection.date, slot: 'hourly', guests: selection.guests, priceSource: price.dayKind, ...money };
  const totals = sumVisitTotals([priced]);
  const tier = CANCELLATION_TIERS_HOURLY[listing.cancellation_tier];
  const policy = {
    ...(publications ? { publications } : {}),
    version: BOOKING_POLICY.version, listingConfigVersion: listing.booking_config_version,
    cancellationTier: listing.cancellation_tier, houseRules: listing.house_rules,
    cancellation: { bandUnit: 'hours', bands: tier.bands.map((band) => [...band]), noShow: tier.noShow, feeOnFullRefund: listing.cancellation_tier === 'flexible' },
    pricing: { platformFeeBps: BOOKING_POLICY.platformFeeBps, illustrativeAdvanceBps: BOOKING_POLICY.illustrativeAdvanceBps, depositCollectedOnline: false },
    depositScope: 'per_visit', taxPolicy: 'not_configured', timeZone: config.timeZone,
  };
  const paymentSnapshot = paymentSnapshotFor(inputs.payment, [priced], totals);
  const visits = [{
    ...visit, ...priced,
    activity: { id: activity.id, slug: activity.slug, name: activity.name },
    requestedResourceId: selection.resourceId ?? null,
    // The court's name, so review screens can say which court was chosen before the hold.
    requestedResourceName: selection.resourceId ? inputs.resources.find((r) => r.id === selection.resourceId)?.name ?? null : null,
    segments: price.segments,
  }];
  const rates = bands.map((band) => ({ ...band, hourlyRateMinor: Number(band.hourlyRateMinor) }));
  const pricingVersion = quoteDigest({ rates, overrides: [], schedule: config, totals }).slice(0, 32);
  const content = { selection, visits, totals, policy, payment: paymentSnapshot, pricingVersion };
  return { ...content, hash: quoteDigest(content), currency: 'INR', timeZone: config.timeZone };
}

/** Either model, from the inputs currentInputs loaded for this listing. */
function quoteFor(selection, listing, inputs, publications) {
  return selection.kind === 'hourly'
    ? prepareHourlyQuote(selection, listing, inputs, inputs.now, publications)
    : prepareQuote(selection, listing, inputs.rates, inputs.overrides, inputs.payment, inputs.now, publications);
}

/** The same immutable inputs drive a persisted quote and each calendar price. */
export function prepareQuote(selection, listing, rates, overrides, payment, now, publications) {
  if (listing.status !== 'live' || listing.total_units !== 1) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
  if (bookingModel(listing) === 'hourly') throw new BookingQuoteError('SLOT_UNAVAILABLE', 'This venue is booked by time, not by slot.');
  const config = listingConfiguration(listing);
  const schedule = config.slots[selection.slot];
  const rate = rates.find((row) => row.slot === selection.slot);
  if (!schedule?.enabled || !rate) throw new BookingQuoteError('SLOT_UNAVAILABLE', 'This slot is not offered.');
  if (schedule.capacity > listing.capacity || selection.guests > schedule.capacity) throw new BookingQuoteError('CAPACITY_EXCEEDED', 'The guest count exceeds this slot’s capacity.');
  const visits = buildVisitIntervals({ ...selection, schedule, now, ...config });
  const byDate = {};
  for (const row of overrides) {
    const date = dayKey(row.day);
    byDate[date] = { ...byDate[date], [row.slot]: Number(row.rent_minor) };
  }
  const price = priceVisitsMinor({
    ...selection,
    rate: { ...schedule, weekdayMinor: Number(rate.weekday_minor), weekendMinor: Number(rate.weekend_minor), depositMinor: Number(listing.deposit_minor) },
    overridesByDate: byDate,
  });
  // Older pricing saved one day type as 0; never sell those visits for nothing.
  if (price.visits.some((visit) => visit.baseRentMinor <= 0)) throw new BookingQuoteError('SLOT_UNAVAILABLE', 'This slot is not offered on that day.');
  const policy = {
    ...(publications ? {publications} : {}),
    version: BOOKING_POLICY.version, listingConfigVersion: listing.booking_config_version,
    cancellationTier: listing.cancellation_tier, houseRules: listing.house_rules,
    cancellation: { bands: CANCELLATION_TIERS[listing.cancellation_tier].bands.map(band=>[...band]), noShow: CANCELLATION_TIERS[listing.cancellation_tier].noShow, feeOnFullRefund: listing.cancellation_tier === 'flexible' },
    pricing: { platformFeeBps: BOOKING_POLICY.platformFeeBps, illustrativeAdvanceBps: BOOKING_POLICY.illustrativeAdvanceBps, depositCollectedOnline: false },
    depositScope: 'per_visit', taxPolicy: 'not_configured', timeZone: config.timeZone,
  };
  // Public quotes remain available while payments are disabled. No credentials
  // or operational credential error details are returned to a browsing guest.
  const paymentSnapshot = paymentSnapshotFor(payment, price.visits, price.totals);
  const visitSnapshots = visits.map((visit, index) => ({ ...visit, ...price.visits[index] }));
  const pricingVersion = quoteDigest({ rates, overrides, schedule, totals: price.totals }).slice(0, 32);
  const content = { selection, visits: visitSnapshots, totals: price.totals, policy, payment: paymentSnapshot, pricingVersion };
  return { ...content, hash: quoteDigest(content), currency: 'INR', timeZone: config.timeZone };
}

/** Courts, their activities and the hourly bands of a time-booked venue. */
export async function hourlyInputs(tx, listing) {
  return (await hourlyInputsQuery(tx, listing))[0];
}

export function hourlyInputsQuery(tx, listing) {
  return tx`SELECT
    COALESCE((SELECT json_agg(b ORDER BY b."categoryId", b."dayKind", b."startMinute") FROM (
      SELECT category_id AS "categoryId", day_kind AS "dayKind", start_minute AS "startMinute",
        end_minute AS "endMinute", hourly_rate_minor::text AS "hourlyRateMinor"
      FROM rentable_rate WHERE rentable_id=${listing.id}) b), '[]'::json) AS bands,
    COALESCE((SELECT json_agg(r ORDER BY r.sort_order, r.name, r.id) FROM (
      SELECT r.id, r.name, r.capacity, r.sort_order, COALESCE(json_agg(a.category_id) FILTER (WHERE a.category_id IS NOT NULL), '[]'::json) AS activities
      FROM rentable_resource r LEFT JOIN rentable_resource_activity a ON a.resource_id=r.id
      WHERE r.rentable_id=${listing.id} AND r.is_active GROUP BY r.id) r), '[]'::json) AS resources,
    COALESCE((SELECT json_agg(c ORDER BY c.sort_order, c.name) FROM (
      SELECT c.id, c.slug, c.name, c.icon_key AS "iconKey", c.sort_order FROM category c
      WHERE c.is_active AND c.default_rental_unit::text='hour'
        AND c.vertical_code=(SELECT vertical_code FROM category WHERE id=${listing.category_id})
        AND c.id IN (SELECT category_id FROM rentable_resource_activity WHERE rentable_id=${listing.id})) c), '[]'::json) AS activities`;
}

/** New quotes need an active owner and a public vertical; existing bookings are not affected. */
export async function requireBookableListing(tx, listing) {
  const [row] = await tx`SELECT
    EXISTS (SELECT 1 FROM "user" WHERE id=${listing.client_id} AND role='client' AND account_status='active') AS owner_active,
    EXISTS (SELECT 1 FROM category c JOIN vertical v ON v.code=c.vertical_code WHERE c.id=${listing.category_id} AND v.status='public') AS vertical_public`;
  if (!row.owner_active || !row.vertical_public) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
}

async function currentInputs(tx, listing, selection, variables) {
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  await requireBookableListing(tx, listing);
  // Snapshot reads (search, quotes) treat expired holds as free instead of writing.
  if (!isReadOnlyInventory(tx, listing.id)) await expireInventoryHolds(tx, listing.id, clock.now);
  if ((selection.kind === 'hourly') !== (bookingModel(listing) === 'hourly')) {
    throw new BookingQuoteError(selection.kind === 'hourly' ? 'LISTING_UNAVAILABLE' : 'SLOT_UNAVAILABLE', 'This booking type is not offered here.');
  }
  if (selection.kind === 'hourly') {
    const payment = await getPaymentConfiguration(tx, variables);
    return { now: clock.now, ...(await hourlyInputs(tx, listing)), payment, publications: await currentPolicyReferences(tx) };
  }
  const rates = await tx`SELECT slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${listing.id} ORDER BY slot`;
  const first = selection.dates[0], last = selection.dates.at(-1);
  const overrides = await tx`SELECT day::text AS day,slot,rent_minor FROM booking_price_override WHERE rentable_id=${listing.id} AND day BETWEEN ${first} AND ${last} ORDER BY day,slot`;
  const payment = await getPaymentConfiguration(tx, variables);
  return { now: clock.now, rates, overrides, payment, publications: await currentPolicyReferences(tx) };
}

/**
 * Quote plus an inventory check. For a time-booked visit the result also carries
 * `freeCourts` ({ id, name } in assignment order); it is not part of the hash and
 * is stripped from public responses.
 */
async function checkedQuote(tx, listing, selection, variables) {
  const inputs = await currentInputs(tx, listing, selection, variables);
  const quote = quoteFor(selection, listing, inputs, inputs.publications);
  const stamps = { createdAt: new Date(inputs.now).toISOString(), expiresAt: new Date(new Date(inputs.now).getTime() + BOOKING_POLICY.quoteMinutes * 60_000).toISOString() };
  if (selection.kind === 'hourly') {
    const { eligible } = hourlyCandidates(inputs, selection);
    const check = await prepareHourlyInventoryCheck(tx, listing, inventoryWindow(quote.visits));
    const visit = quote.visits[0];
    const { code, freeResourceIds } = check(visit, eligible.map((row) => row.id));
    if (code) throw new BookingQuoteError('AVAILABILITY_CONFLICT', 'That time is no longer free. Your selection has been preserved.', [{ date: visit.date, start: visit.start, code }]);
    return { ...quote, ...stamps, freeCourts: freeResourceIds.map((id) => ({ id, name: eligible.find((row) => row.id === id).name })) };
  }
  const conflicts = await findInventoryConflicts(tx, listing, quote.visits);
  if (conflicts.length) throw new BookingQuoteError('AVAILABILITY_CONFLICT', 'Some visit dates are unavailable. Your selection has been preserved.', conflicts);
  return { ...quote, ...stamps };
}

/**
 * Discovery checks the complete selection without creating abandoned quote rows.
 * Read-only snapshot (P1): searching never takes the listing write lock.
 */
export async function previewBookingQuote(database, input, variables = process.env) {
  const selection = bookingSelectionSchema.parse(input);
  const { freeCourts: _freeCourts, ...quote } = await withListingSnapshot(database, selection.rentableId, (tx, listing) => checkedQuote(tx, listing, selection, variables));
  return quote;
}

/**
 * A quote is advice; it never reserves inventory, and every hold re-validates it
 * under the listing mutex. So it is computed in a read-only snapshot (P1) and
 * stored afterwards, instead of queueing behind checkouts on the write lock.
 */
export async function createBookingQuote(database, input, { customerId = null, variables = process.env } = {}) {
  const selection = bookingSelectionSchema.parse(input);
  if (customerId) {
    const [customer] = await database`SELECT id FROM "user" WHERE id=${customerId} AND role='customer' AND account_status='active'`;
    if (!customer) throw new BookingQuoteError('CUSTOMER_REQUIRED', 'An active customer account is required.');
  }
  const { freeCourts: _freeCourts, ...quote } = await withListingSnapshot(database, selection.rentableId, (tx, listing) => checkedQuote(tx, listing, selection, variables));
  const [saved] = await database`
    INSERT INTO booking_quote (customer_id,intent_hash,rentable_id,currency,time_zone,selection,visit_snapshots,
      policy_snapshot,payment_snapshot,pricing_version,policy_version,version,quote_hash,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,created_at,expires_at)
    VALUES (${customerId},${quoteDigest(selection)},${selection.rentableId},'INR',${quote.timeZone},${JSON.stringify(selection)}::text::jsonb,${JSON.stringify(quote.visits)}::text::jsonb,
      ${JSON.stringify(quote.policy)}::text::jsonb,${JSON.stringify(quote.payment)}::text::jsonb,${quote.pricingVersion},${BOOKING_POLICY.version},1,${quote.hash},
      ${quote.totals.rentMinor},${quote.totals.feeMinor},${quote.totals.depositMinor},${quote.createdAt},${quote.expiresAt}) RETURNING id`;
  return { ...quote, id: saved.id, version: 1, advisory: true };
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
  const quote = quoteFor(bookingSelectionSchema.parse(saved.selection), listing, inputs, order.policy_snapshot?.publications);
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
        SELECT slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${listing.id}
      ) r), '[]'::json) AS rates,
      COALESCE((SELECT json_agg(o ORDER BY o.day,o.slot) FROM (
        SELECT day::text AS day,slot,rent_minor FROM booking_price_override
        WHERE rentable_id=${listing.id} AND day BETWEEN ${dates[0]} AND ${dates.at(-1)}
      ) o), '[]'::json) AS explicit`;
  if (!inputs.owner_active) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
  // prepareInventoryCheck treats expired holds as free in the read-only snapshot.
  const payment = await getPaymentConfiguration(tx, variables);
  return { now: inputs.now, rates: inputs.rates, overrides: inputs.explicit, payment };
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
      // Only the requested days (plus overnight neighbours) are loaded (P2).
      prepareInventoryCheck(tx, listing, {
        from: new Date(`${addLocalDays(from, -2)}T00:00:00+05:30`).toISOString(),
        to: new Date(`${addLocalDays(to, 3)}T00:00:00+05:30`).toISOString(),
      }),
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
