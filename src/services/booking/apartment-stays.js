import 'server-only';
import { z } from 'zod';
import { currentPolicyReferences } from '../content/service.js';
import { getPaymentConfiguration } from '../payments/gateway-settings.js';
import { resolveServiceFee } from '../finance/service-fee.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';
import { CANCELLATION_TIERS } from '../domain/pricing.js';
import { listingCancellationPolicy } from '../domain/cancellation-policy.js';
import { allocateByWeights, allocateOrderFee } from '../domain/booking-money.js';
import { propertyToday } from '../domain/booking-dates.js';
import { HOTEL_POLICY, stayInstants } from '../domain/hotel.js';
import { addDays, apartmentNights, apartmentPrice, apartmentStayProblem, localMidnight, reservationRange } from '../domain/apartment.js';
import { conflict, notFound, unprocessable } from '../../utils/apiError.js';
import { BookingQuoteError, petPolicyStamp, petTerms, quoteDigest, requireBookableListing } from './quotes.js';
import { createOwnerBlock, expireInventoryHolds, isReadOnlyInventory, releaseOwnerBlock, withListingInventory, withListingSnapshot } from './inventory.js';

/**
 * Story 3.11: a whole apartment is booked as ONE exclusive unit. One booking (slot 'stay') per order and
 * one inventory_reservation (resource NULL) from check-in midnight to midnight of checkout + turnover,
 * so the GiST exclusion `reservation_active_overlap_excl` refuses any overlap (owner blocks included).
 * Quotes ride the generic quote/hold/payment path (quotes.js, checkout.js); the order's policy says
 * kind 'stay' (always paid in full) with an `apartment` block, which is how every branch tells it from a hotel.
 */
export const APARTMENT_CHOICE_CODES = ['DATES_INVALID', 'OUTSIDE_BOOKING_WINDOW', 'MIN_NIGHTS', 'MAX_NIGHTS', 'OCCUPANCY'];
export const isApartmentPolicy = (policy) => policy?.kind === 'stay' && policy?.apartment != null;

/** The bookable profile, or null while a part of the setup is missing. */
export async function loadApartmentProfile(tx, rentableId) {
  const [row] = await tx`SELECT * FROM apartment_profile WHERE rentable_id=${rentableId}`;
  if (!row || row.weekday_minor == null || row.weekend_minor == null || row.check_in_minute == null || row.check_out_minute == null) return null;
  return profileOf(row);
}
export const profileOf = (row) => ({
  version: row.version, maxAdults: row.max_adults, maxChildren: row.max_children, maxOccupants: row.max_occupants,
  minNights: row.min_nights, maxNights: row.max_nights, arrivalRules: row.arrival_rules ?? { weekdays: {}, ranges: [] },
  checkInMinute: row.check_in_minute, checkOutMinute: row.check_out_minute, turnoverNights: row.turnover_nights,
  cleaningMinor: Number(row.cleaning_fee_minor), weekdayMinor: Number(row.weekday_minor), weekendMinor: Number(row.weekend_minor),
  weekendNights: (row.weekend_nights ?? []).map(Number),
});

/**
 * The full priced stay from trusted inputs (no inventory). Throws BookingQuoteError with a stable code.
 * Content and hash follow quotes.js: the profile version, nightly prices, cleaning and pets are all inside.
 */
export function priceApartmentStay({ listing, profile, selection, now, payment, publications, fee }) {
  if (listing.status !== 'live' || listing.total_units !== 1) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This property is not available for booking.');
  if (!profile) throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This apartment is not taking bookings yet.');
  const problem = apartmentStayProblem(profile, selection, propertyToday(now));
  if (problem) throw new BookingQuoteError(problem.code, problem.message);
  const times = stayInstants({ checkIn: selection.checkIn, checkOut: selection.checkOut, checkInMinute: profile.checkInMinute, checkOutMinute: profile.checkOutMinute });
  if (new Date(times.startsAt) <= new Date(now)) throw new BookingQuoteError('OUTSIDE_BOOKING_WINDOW', 'Check-in time has passed for this date.');
  const nightly = apartmentNights(profile, selection.checkIn, selection.checkOut);
  // Story 3.9 pet math, units = nights.
  const petsLegacy = listing.house_rules?.petsAllowed === true;
  const petStamp = petPolicyStamp(listing.pet_policy, listing.pet_policy_version, petsLegacy);
  const { parts: _parts, ...pets } = petTerms(listing.pet_policy, petsLegacy, selection.pets, nightly.length);
  if (!selection.pets) { const { pets: _none, ...rest } = selection; selection = rest; }
  const price = apartmentPrice(profile, nightly, pets.pets?.totalMinor ?? 0);
  // One service fee over rent + cleaning + pet (Story 2.2), split by component for refunds.
  const [rentFee, cleaningFee, petFee] = allocateOrderFee([price.rentMinor, price.cleaningMinor, price.petMinor], fee.bps);
  const feeMinor = rentFee + cleaningFee + petFee;
  const totalMinor = price.stayMinor + feeMinor;
  const range = reservationRange(selection.checkIn, selection.checkOut, profile.turnoverNights);
  const guests = selection.adults + (selection.childAges?.length ?? 0);
  const apartment = { adults: selection.adults, childAges: selection.childAges ?? [], nightly, rentMinor: price.rentMinor,
    cleaningMinor: price.cleaningMinor, petMinor: price.petMinor, feeParts: { rent: rentFee, cleaning: cleaningFee, pet: petFee },
    turnoverNights: profile.turnoverNights, checkInMinute: profile.checkInMinute, checkOutMinute: profile.checkOutMinute, profileVersion: profile.version };
  const visit = {
    date: selection.checkIn, slot: 'stay', checkIn: selection.checkIn, checkOut: selection.checkOut, nights: nightly.length, guests,
    // The reservation holds whole nights [check-in midnight, midnight of checkout + turnover); the visit's own
    // blocked interval must also cover its checkout time (turnover 0 ends at checkout-day midnight).
    startsAt: times.startsAt, endsAt: times.endsAt, blockedStartAt: range.blockedStartAt,
    blockedEndAt: new Date(Math.max(+new Date(range.blockedEndAt), +new Date(times.endsAt))).toISOString(),
    reservationEndAt: range.blockedEndAt, apartment,
    baseRentMinor: price.rentMinor, cleaningMinor: price.cleaningMinor, ...(price.petMinor ? { petMinor: price.petMinor } : {}),
    rentMinor: price.stayMinor, feeMinor, depositMinor: 0, totalMinor, illustrativeAdvanceMinor: totalMinor, illustrativeBalanceMinor: 0,
  };
  const totals = { baseRentMinor: price.rentMinor, cleaningMinor: price.cleaningMinor, ...(price.petMinor ? { petMinor: price.petMinor } : {}),
    rentMinor: price.stayMinor, feeMinor, depositMinor: 0, totalMinor, illustrativeAdvanceMinor: totalMinor, illustrativeBalanceMinor: 0 };
  const tier = CANCELLATION_TIERS[listing.cancellation_tier] ?? CANCELLATION_TIERS.moderate;
  const policy = {
    ...(publications ? { publications } : {}),
    version: BOOKING_POLICY.version, kind: 'stay',
    cancellationTier: listing.cancellation_tier, houseRules: listing.house_rules,
    // Night presets (Story 3.10) or the owner's own windows, accepted with the booking.
    cancellationPolicy: listingCancellationPolicy(listing),
    cancellation: { bands: tier.bands.map((band) => [...band]), noShow: tier.noShow, feeOnFullRefund: listing.cancellation_tier === 'flexible' },
    pricing: { platformFeeBps: fee.bps, feeSource: fee.source, feeSettingId: fee.settingId, feeModel: 'guest_service_fee' },
    depositScope: 'per_visit', taxPolicy: 'not_configured', timeZone: BOOKING_POLICY.timeZone,
    apartment: { version: profile.version, weekdayMinor: profile.weekdayMinor, weekendMinor: profile.weekendMinor, weekendNights: profile.weekendNights,
      cleaningMinor: profile.cleaningMinor, turnoverNights: profile.turnoverNights },
    hotel: { checkInMinute: profile.checkInMinute, checkOutMinute: profile.checkOutMinute },
    ...petStamp, ...pets,
  };
  // Always paid in full; the ledger books cleaning and pet as rent (3.9 precedent), split kept here.
  const paymentSnapshot = {
    version: payment.version, provider: payment.provider, environment: payment.environment, mode: payment.mode, enabled: payment.enabled,
    collectionPurpose: 'full', expectedMinor: totalMinor, actualCollectedMinor: 0, // The stay collection policy (hotel-v1): always in full, whatever the gateway default.
    collectionPolicyVersion: HOTEL_POLICY.version, remainingMinor: 0,
    allocations: [{ date: selection.checkIn, rentMinor: price.stayMinor, feeMinor, depositMinor: 0, cleaningMinor: price.cleaningMinor, petMinor: price.petMinor }],
  };
  const pricingVersion = quoteDigest({ profile, totals }).slice(0, 32);
  const content = { selection, visits: [visit], totals, policy, payment: paymentSnapshot, pricingVersion };
  return { ...content, hash: quoteDigest(content), currency: 'INR', timeZone: BOOKING_POLICY.timeZone };
}

/** Live reservations overlapping [start, end); expired holds count as free (written off by writers). */
export async function apartmentOverlaps(tx, listing, { blockedStartAt, blockedEndAt }, now) {
  if (!isReadOnlyInventory(tx, listing.id)) await expireInventoryHolds(tx, listing.id, now);
  return tx`SELECT id, source, booking_id FROM inventory_reservation WHERE rentable_id=${listing.id} AND state IN ('held','committed')
    AND NOT (state='held' AND hold_expires_at <= ${new Date(now).toISOString()})
    AND tstzrange(blocked_start_at, blocked_end_at, '[)') && tstzrange(${blockedStartAt}::timestamptz, ${blockedEndAt}::timestamptz, '[)')`;
}

async function inputs(tx, listing, variables) {
  const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
  await requireBookableListing(tx, listing);
  const [profile, payment, publications, fee] = [await loadApartmentProfile(tx, listing.id), await getPaymentConfiguration(tx, variables),
    await currentPolicyReferences(tx), await resolveServiceFee(tx, listing.client_id, now)];
  return { now, profile, payment, publications, fee };
}

/** Quote + advisory availability (authoritative at hold: same check under the listing lock, then the exclusion). */
export async function checkedApartmentQuote(tx, listing, selection, variables = process.env) {
  if (selection.kind !== 'apartment' || listing.rental_unit !== 'unit_night') throw new BookingQuoteError('LISTING_UNAVAILABLE', 'This booking type is not offered here.');
  const input = await inputs(tx, listing, variables);
  const quote = priceApartmentStay({ listing, selection, ...input });
  const visit = quote.visits[0];
  if ((await apartmentOverlaps(tx, listing, { blockedStartAt: visit.blockedStartAt, blockedEndAt: visit.reservationEndAt }, input.now)).length) {
    throw new BookingQuoteError('DATES_UNAVAILABLE', 'These dates are not available. Try other dates.', [{ date: selection.checkIn, code: 'DATES_UNAVAILABLE' }]);
  }
  return { ...quote, createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(new Date(input.now).getTime() + BOOKING_POLICY.quoteMinutes * 60_000).toISOString() };
}

/** A held order owns its reservation: recheck price and terms only (approved requests as at the request). */
export async function heldApartmentTerms(tx, listing, order, selection, variables = process.env) {
  const input = await inputs(tx, listing, variables);
  if (order.approved) input.now = order.created_at;
  const quote = priceApartmentStay({ listing, selection, ...input, publications: order.policy_snapshot?.publications });
  const [held] = await tx`SELECT count(*)::int n FROM inventory_reservation r JOIN booking b ON b.id=r.booking_id
    WHERE b.order_id=${order.id} AND r.state='held'`;
  if (!held.n) throw new BookingQuoteError('HOLD_EXPIRED', 'These dates are no longer held.');
  return quote;
}

/* ------------------------------------ Discovery (advisory) ------------------------------------ */

/**
 * Search offers for dated apartment results: listing id -> { totalMinor, stayMinor, nights } for those
 * that are bookable for these dates, party and pets. Read-only, one batch query for overlaps.
 */
export async function apartmentSearchOffers(database, rows, { checkIn, checkOut, adults, childAges = [], pets = 0 }, variables = process.env) {
  const ids = rows.map((r) => r.id);
  if (!ids.length || !checkIn || !checkOut) return new Map();
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    const listings = await tx`SELECT r.*, p.* FROM rentable r JOIN apartment_profile p ON p.rentable_id=r.id WHERE r.id IN ${tx(ids)}`;
    const busy = await tx`SELECT DISTINCT r.rentable_id FROM inventory_reservation r JOIN apartment_profile p ON p.rentable_id=r.rentable_id
      WHERE r.rentable_id IN ${tx(ids)} AND r.state IN ('held','committed') AND NOT (r.state='held' AND r.hold_expires_at <= ${now})
        AND tstzrange(r.blocked_start_at, r.blocked_end_at, '[)') && tstzrange(${localMidnight(checkIn)}::timestamptz,
          (${localMidnight(checkOut)}::timestamptz + make_interval(days => p.turnover_nights)), '[)')`;
    const blocked = new Set(busy.map((b) => b.rentable_id));
    const payment = await getPaymentConfiguration(tx, variables);
    const offers = new Map();
    for (const row of listings) {
      if (blocked.has(row.rentable_id)) continue;
      const profile = row.weekday_minor == null || row.check_in_minute == null ? null : profileOf(row);
      try {
        const fee = await resolveServiceFee(tx, row.client_id, now);
        const quote = priceApartmentStay({ listing: { ...row, id: row.rentable_id }, profile, now, payment, publications: null, fee,
          selection: { kind: 'apartment', rentableId: row.rentable_id, checkIn, checkOut, adults, childAges, ...(pets ? { pets } : {}) } });
        offers.set(row.rentable_id, { totalMinor: quote.totals.totalMinor, stayMinor: quote.totals.rentMinor, nights: quote.visits[0].nights,
          cleaningMinor: quote.totals.cleaningMinor, petMinor: quote.totals.petMinor ?? 0, feeMinor: quote.totals.feeMinor });
      } catch (error) {
        if (!(error instanceof BookingQuoteError)) throw error;
      }
    }
    return offers;
  });
}

/* ------------------------------------- Owner calendar ------------------------------------------ */

const localDate = (instant) => propertyToday(instant);
const calendarQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.coerce.number().int().min(1).max(62).default(42) });

async function ownedApartment(tx, ownerId, listing) {
  const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client'`;
  if (!owner || listing.client_id !== ownerId) throw notFound();
  if (listing.rental_unit !== 'unit_night') throw conflict('UNSUPPORTED_INVENTORY', 'This calendar is for whole apartments.');
}

/** The live reservations of an apartment as night labels, plus a version over them for safe edits. */
async function calendarState(tx, listing, from, days) {
  const to = addDays(from, days);
  const rows = await tx`SELECT r.id, r.source, r.state, r.blocked_start_at, r.blocked_end_at, r.reason, b.reference,
      b.slot_snapshot->>'checkOut' AS check_out, coalesce((b.slot_snapshot->'apartment'->>'turnoverNights')::int, 0) AS turnover
    FROM inventory_reservation r LEFT JOIN booking b ON b.id=r.booking_id
    WHERE r.rentable_id=${listing.id} AND r.state IN ('held','committed') AND NOT (r.state='held' AND r.hold_expires_at <= clock_timestamp())
      AND tstzrange(r.blocked_start_at, r.blocked_end_at, '[)') && tstzrange(${localMidnight(from)}::timestamptz, ${localMidnight(to)}::timestamptz, '[)')
    ORDER BY r.blocked_start_at, r.id`;
  const nights = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    const start = localMidnight(d);
    const row = rows.find((r) => new Date(r.blocked_start_at) <= new Date(start) && new Date(r.blocked_end_at) > new Date(start));
    if (!row) { nights.push({ date: d, state: 'open' }); continue; }
    if (row.source === 'owner_block') { nights.push({ date: d, state: 'blocked', blockId: row.id, reason: row.reason }); continue; }
    // Booked until the earlier of checkout and the (possibly shrunk) end before its buffer.
    const bookedUntil = [row.check_out, addDays(localDate(row.blocked_end_at), -row.turnover)].filter(Boolean).sort()[0];
    nights.push({ date: d, state: d < bookedUntil ? 'booked' : 'buffer', reference: row.reference, held: row.state === 'held' });
  }
  const version = quoteDigest(rows.map((r) => [r.id, r.state, new Date(r.blocked_start_at).toISOString(), new Date(r.blocked_end_at).toISOString()])).slice(0, 16);
  return { from, days, nights, version };
}

export async function apartmentCalendar(database, ownerId, rentableId, query = {}) {
  z.string().uuid().parse(rentableId);
  const q = calendarQuery.parse(query);
  return withListingSnapshot(database, rentableId, async (tx, listing) => {
    await ownedApartment(tx, ownerId, listing);
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    return { today: propertyToday(now), ...(await calendarState(tx, listing, q.from ?? propertyToday(now), q.days)) };
  });
}

const changeSchema = z.object({
  action: z.enum(['block', 'unblock']), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().max(500).optional(), version: z.string().min(1), calendarFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), calendarDays: z.coerce.number().int().min(1).max(62),
}).strict();

/**
 * Block or unblock nights `from`..`to` (inclusive, property-local). Blocks are owner_block reservations, so they
 * exclude bookings like any stay; a block over booked or buffer nights is refused. `version` must match the
 * calendar the owner previewed (409 CALENDAR_CHANGED otherwise). Unblock releases every block touching the range.
 */
export async function changeApartmentCalendar(database, ownerId, rentableId, body) {
  z.string().uuid().parse(rentableId);
  const parsed = changeSchema.safeParse(body ?? {});
  if (!parsed.success) throw unprocessable(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', [i.message]])));
  const v = parsed.data;
  if (v.to < v.from) throw unprocessable({ to: ['The last night must be on or after the first night'] });
  if (addDays(v.from, 365) < v.to) throw unprocessable({ to: ['Choose at most a year of nights'] });
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await ownedApartment(tx, ownerId, listing);
    await expireInventoryHolds(tx, listing.id);
    const current = await calendarState(tx, listing, v.calendarFrom, v.calendarDays);
    if (current.version !== v.version) throw conflict('CALENDAR_CHANGED', 'This calendar changed after you opened it. Review the latest nights and try again.');
    const range = { blockedStartAt: localMidnight(v.from), blockedEndAt: localMidnight(addDays(v.to, 1)) };
    const touching = await tx`SELECT id, source, blocked_start_at, blocked_end_at, reason FROM inventory_reservation WHERE rentable_id=${listing.id} AND state IN ('held','committed')
      AND tstzrange(blocked_start_at, blocked_end_at, '[)') && tstzrange(${range.blockedStartAt}::timestamptz, ${range.blockedEndAt}::timestamptz, '[)')`;
    // Reuse the inventory writers inside this transaction (they join the held listing lock).
    const scoped = { inventoryTransaction: { transaction: tx, listing } };
    if (v.action === 'block') {
      if (touching.some((r) => r.source === 'booking')) throw conflict('DATES_BOOKED', 'Some of these nights are booked or kept for cleaning. Choose open nights.');
      if (touching.length) throw conflict('ALREADY_BLOCKED', 'Some of these nights are already blocked.');
      await createOwnerBlock(scoped, ownerId, { rentableId, ...range, reason: v.reason && v.reason.length >= 3 ? v.reason : 'Blocked by owner' });
    } else {
      // Only the chosen nights reopen: a block reaching past the range is released and its outer parts re-blocked.
      for (const r of touching.filter((row) => row.source === 'owner_block')) {
        await releaseOwnerBlock(scoped, ownerId, { rentableId, blockId: r.id });
        const keep = [
          [new Date(r.blocked_start_at), new Date(range.blockedStartAt)],
          [new Date(range.blockedEndAt), new Date(r.blocked_end_at)],
        ].filter(([start, end]) => start < end);
        for (const [start, end] of keep) {
          await createOwnerBlock(scoped, ownerId, { rentableId, blockedStartAt: start.toISOString(), blockedEndAt: end.toISOString(), reason: r.reason ?? 'Blocked by owner' });
        }
      }
    }
    return calendarState(tx, listing, v.calendarFrom, v.calendarDays);
  });
}

/* ---------------------------------- Cancellation / departure ----------------------------------- */

/** Split a refunded "rent" (rent + cleaning + pet) back into its parts by what was paid, floored by largest remainder. */
export function apartmentRefundParts(apartment, refundRentMinor) {
  const [rent, cleaning, pet] = allocateByWeights(refundRentMinor, [apartment.rentMinor, apartment.cleaningMinor, apartment.petMinor ?? 0]);
  return { rent, cleaning, pet };
}

/** Reservation end after an early departure: midnight of the first unused night + turnover. */
export const departedReservationEnd = (inventoryEnd, turnoverNights) => localMidnight(addDays(inventoryEnd, turnoverNights));
