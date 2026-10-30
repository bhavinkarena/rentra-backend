import { and, eq, sql as raw, desc, asc, isNotNull, ne } from 'drizzle-orm';
import { db, sql } from './index.js';
import { getBookingAvailability } from '../booking/quotes.js';
import { getHourlyAvailability } from '../booking/time-slots.js';
import {
  rentable, rentablePrice, rentableAmenity, amenity, verificationVisit,
  area, city, category, review, users,
} from './schema/index.js';
import { listingPath } from '@/services/domain/listing-url';
import { addLocalDays, propertyToday } from '@/services/domain/booking-dates';
import { resolveInclusions } from '@/services/domain/hotel-rooms';
import { effectiveChildPolicy } from '@/services/domain/child-policy';
import { effectivePetPolicy, publicPetPolicy } from '@/services/domain/pet-policy';
import { amenityStates, normalizePublicPhotos, publicHouseRules, publicSlotSchedules } from '@/services/domain/listing-content';
import { DEFAULT_VERTICAL } from '@/services/domain/verticals';
import { minuteToHhmm } from '@/services/domain/hourly';
import { distanceKm, parsePoint } from '@/services/domain/geo';
import { betaVerticals } from '@/services/auth/beta-access';

/**
 * Data access for public, indexable pages.
 *
 * These are called from Server Components so the markup Google receives
 * already contains the listings. They deliberately do NOT go through RTK
 * Query — a client-side fetch here would mean a spinner and an empty page
 * for crawlers.
 */

/** Hourly card facts (time-booked venues): activities, courts, from-price per hour. */
function hourlyCardFields(row) {
  return {
    vertical: row.vertical,
    rentalUnit: 'hour',
    activities: row.activities ?? [],
    resourceCount: Number(row.resourceCount ?? 0),
    maxPlayers: row.maxPlayers == null ? null : Number(row.maxPlayers),
    isIndoor: row.indoorKinds == null ? null : row.indoorKinds === 'indoor' ? true : row.indoorKinds === 'outdoor' ? false : 'mixed',
    price: row.hourFromMinor == null ? null : Number(row.hourFromMinor) / 100,
    priceWeekend: null,
    unit: 'hour',
    priceNote: 'Per hour; platform fee added at checkout. Choose a date and time for a total.',
  };
}

/**
 * Hotel card facts (hotel plan, Phase 6) without dates: the lowest nightly room
 * rate of any active plan, before taxes and per-guest extras, so "from" is a floor.
 */
function hotelCardFields(row) {
  return {
    vertical: 'hotel',
    rentalUnit: 'night',
    price: row.hotelFromMinor == null ? null : Number(row.hotelFromMinor) / 100,
    priceWeekend: null,
    unit: 'night',
    priceNote: 'Per room per night, before taxes. Add dates for the total.',
    starRating: row.starRating ?? null,
    couples: Boolean(row.hotelPolicies?.couples),
    localId: Boolean(row.hotelPolicies?.localId),
  };
}

/** Lowest nightly rate over active plans of active room types; a derived plan is its base rate ± its percentage. */
const HOTEL_FROM_MINOR = (id) => raw`(select min(case when rp.derived_from is null then least(rp.weekday_minor, rp.weekend_minor)
    else (select least(b.weekday_minor, b.weekend_minor) from rate_plan b where b.id = rp.derived_from) * (10000 + rp.derived_pct_bps) / 10000 end)
  from rate_plan rp join room_type rt on rt.id = rp.room_type_id and rt.is_active where rp.rentable_id = ${id} and rp.is_active)`;

const photoContext = (row) => ({
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  title: row.title,
  place: [row.areaName, row.cityName].filter(Boolean).join(', '),
});

/** Shape the ListingCard component expects. */
function toCard(row) {
  const photos = normalizePublicPhotos(row.photos, photoContext(row));
  const card = {
    id: row.id,
    slug: row.slug,
    publicCode: row.publicCode,
    /** The canonical public path. Built in one place so it never drifts. */
    href: listingPath(row.slug, row.publicCode),
    area: `${row.areaName}, ${row.cityName}`,
    title: row.title,
    categorySlug: row.categorySlug,
    capacity: row.capacity,
    bedrooms: row.bedrooms,
    highlight: row.highlight,
    // Undated cards show the lower configured night base rate.
    // Dates, guest charges and fees require an authoritative quote.
    price: [row.nightWeekday, row.nightWeekend].some(v => v != null)
      ? Math.min(...[row.nightWeekday, row.nightWeekend].filter(v => v != null).map(Number)) : null,
    priceNote: 'Base rent per night; guest charges, platform fee and refundable deposit extra. Select dates for a total.',
    priceWeekend: row.nightWeekend ?? null,
    isFromPrice: true,
    // Only ever set when a discount is genuine. A permanent fake
    // strike-through makes us look like a coupon site.
    strikePrice: null,
    unit: 'night',
    rating: row.ratingAvg ?? 0,
    reviewCount: row.reviewCount ?? 0,
    // Rank: passed physical visit > new > none. Never more than one badge.
    badge: row.physicallyVerified ? 'verified' : row.reviewCount === 0 ? 'new' : null,
    photos,
    photo: photos[0] ?? null,
    photoCount: photos.length,
    vertical: row.vertical ?? DEFAULT_VERTICAL,
    rentalUnit: row.rentalUnit ?? 'slot',
  };
  if (row.rentalUnit === 'unit_night') return { ...card,
    price: row.apartmentFromMinor == null ? null : Number(row.apartmentFromMinor) / 100,
    priceWeekend: null,
    priceNote: 'Per night for the whole apartment. Add dates for the total including cleaning and fees.',
  };
  if (row.vertical === 'hotel' && row.rentalUnit === 'night') return { ...card, ...hotelCardFields(row) };
  return row.rentalUnit === 'hour' ? { ...card, ...hourlyCardFields(row) } : card;
}

const cardColumns = {
  id: rentable.id,
  slug: rentable.slug,
  publicCode: rentable.publicCode,
  title: rentable.title,
  categorySlug: raw`(select vc.slug from category vc where vc.id=${rentable.categoryId})`.as('category_slug'),
  capacity: rentable.capacity,
  bedrooms: rentable.bedrooms,
  highlight: rentable.highlight,
  ratingAvg: rentable.ratingAvg,
  reviewCount: rentable.reviewCount,
  verifiedAt: rentable.verifiedAt,
  physicallyVerified: raw`${rentable.verifiedAt} is not null and exists(select 1 from verification_visit vv where vv.rentable_id=${rentable.id} and vv.mode='physical' and vv.outcome='passed' and vv.completed_at is not null)`.as('physically_verified'),
  photos: rentable.photos,
  areaName: area.name,
  areaSlug: area.slug,
  cityName: city.name,
  citySlug: city.slug,
  // Stored in paise; the public API keeps whole rupees.
  nightWeekday: raw`(${rentablePrice.weekdayMinor}/100)::int`.mapWith(Number).as('night_weekday'),
  nightWeekend: raw`(${rentablePrice.weekendMinor}/100)::int`.mapWith(Number).as('night_weekend'),
  rentalUnit: rentable.rentalUnit,
  vertical: raw`(select vc.vertical_code from category vc where vc.id=${rentable.categoryId})`.as('vertical'),
  // Time-booked venues only (NULL / empty for farmhouses): one subquery each, all index-backed.
  hourFromMinor: raw`(select min(rr.hourly_rate_minor) from rentable_rate rr where rr.rentable_id=${rentable.id})`.as('hour_from_minor'),
  hotelFromMinor: HOTEL_FROM_MINOR(rentable.id).as('hotel_from_minor'),
  apartmentFromMinor: raw`(select least(ap.weekday_minor, ap.weekend_minor) from apartment_profile ap where ap.rentable_id=${rentable.id})`.as('apartment_from_minor'),
  starRating: raw`(select hp.star_rating from hotel_profile hp where hp.rentable_id=${rentable.id})`.as('star_rating'),
  hotelPolicies: raw`(select hp.policies from hotel_profile hp where hp.rentable_id=${rentable.id})`.as('hotel_policies'),
  resourceCount: raw`(select count(*)::int from rentable_resource rs where rs.rentable_id=${rentable.id} and rs.is_active)`.as('resource_count'),
  maxPlayers: raw`(select max(rs.capacity) from rentable_resource rs where rs.rentable_id=${rentable.id} and rs.is_active)`.as('max_players'),
  indoorKinds: raw`(select case when bool_and(rs.is_indoor) then 'indoor' when not bool_or(rs.is_indoor) then 'outdoor' when count(rs.is_indoor)>0 then 'mixed' end
    from rentable_resource rs where rs.rentable_id=${rentable.id} and rs.is_active)`.as('indoor_kinds'),
  activities: raw`(select coalesce(json_agg(json_build_object('slug',ac.slug,'name',ac.name,'iconKey',ac.icon_key) order by ac.sort_order, ac.name), '[]'::json)
    from category ac where ac.is_active and ac.id in (select ra.category_id from rentable_resource_activity ra
      join rentable_resource rs on rs.id=ra.resource_id and rs.is_active where ra.rentable_id=${rentable.id}))`.as('activities'),
};

/** Cards and lists of one vertical; farmhouse unless the caller asks. */
const inVertical = (vertical = DEFAULT_VERTICAL) =>
  raw`exists (select 1 from category vc where vc.id=${rentable.categoryId} and vc.vertical_code=${vertical})`;

const nightPrice = and(
  eq(rentablePrice.rentableId, rentable.id),
  eq(rentablePrice.slot, 'night'),
);

/**
 * Public means live AND owned by an active client — the same rule discovery
 * search applies. A suspended or blocked owner's listings leave every public
 * read (detail, availability, cards, similar, sitemap, area counts) at once.
 */
const publiclyListed = () => and(
  eq(rentable.status, 'live'),
  raw`exists (select 1 from "user" o where o.id = ${rentable.clientId}
    and o.role = 'client' and o.account_status = 'active')`,
  // A vertical that is not public yet (hidden, or open to partners only) never
  // reaches a public read — except a partners vertical opened by this request's
  // beta pass (hotel plan, Phase 9). Sitemap requests never carry one.
  raw`exists (select 1 from category pc join vertical pv on pv.code = pc.vertical_code
    where pc.id = ${rentable.categoryId} and (pv.status = 'public'
      or (pv.status = 'partners' and pv.code = any(string_to_array(${betaVerticals().join(',')}, ',')))))`,
);

export async function getLiveListings({ citySlug, areaSlug, limit = 24, vertical = DEFAULT_VERTICAL } = {}) {
  const filters = [publiclyListed(), inVertical(vertical)];
  if (citySlug) filters.push(eq(city.slug, citySlug));
  if (areaSlug) filters.push(eq(area.slug, areaSlug));

  const rows = await db
    .select(cardColumns)
    .from(rentable)
    .innerJoin(area, eq(area.id, rentable.areaId))
    .innerJoin(city, eq(city.id, rentable.cityId))
    .leftJoin(rentablePrice, nightPrice)
    .where(and(...filters))
    // NULLS LAST matters: Postgres sorts NULLs first in DESC, which would
    // put an unverified brand-new listing at the top of every results page.
    .orderBy(
      raw`${rentable.verifiedAt} desc nulls last`,
      raw`${rentable.ratingAvg} desc nulls last`,
    )
    .limit(limit);

  return rows.map(toCard);
}

/**
 * Proximity search. The reason PostGIS is in the stack — "within 25 km of me"
 * is a native index-backed query, not a bounding-box approximation.
 */
export async function getListingsNearby({ lng, lat, km = 25, limit = 24, vertical = DEFAULT_VERTICAL }) {
  const rows = await db
    .select({
      ...cardColumns,
      distanceKm: raw`round((ST_Distance(
        ${rentable.location}::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      ) / 1000)::numeric, 1)`.as('distance_km'),
    })
    .from(rentable)
    .innerJoin(area, eq(area.id, rentable.areaId))
    .innerJoin(city, eq(city.id, rentable.cityId))
    .leftJoin(rentablePrice, nightPrice)
    .where(and(
      publiclyListed(),
      inVertical(vertical),
      raw`ST_DWithin(
        ${rentable.location}::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${km * 1000}
      )`,
    ))
    .orderBy(asc(raw`distance_km`))
    .limit(limit);

  return rows.map((r) => ({ ...toCard(r), distanceKm: Number(r.distanceKm) }));
}

/**
 * Public listing detail. Keep exact coordinates, street addresses and owner
 * phone numbers out of both the SELECT and the returned object. Only the shared
 * locality centre is public; private arrival details require booking authorization.
 */
export async function getListingByCode(publicCode, previewOwnerId=null) {
  const [row] = await db
    .select({
      ...cardColumns,
      description: rentable.description,
      houseRules: rentable.houseRules,
      petPolicy: rentable.petPolicy,
      depositAmount: raw`(${rentable.depositMinor}/100)::int`.mapWith(Number).as('deposit_amount'),
      cancellationTier: rentable.cancellationTier,
      clientName: users.name,
      clientResponseRate: users.responseRate,
      clientRespondsWithinMins: users.respondsWithinMins,
      clientSince: users.createdAt,
      categorySlug: category.slug,
      categoryName: category.name,
      // The detail page needs these; a card does not, which is why they are
      // here rather than in cardColumns.
      areaId: rentable.areaId,
      areaCentre: area.centre,
      cityId: rentable.cityId,
      farmSize: rentable.farmSize,
      farmSizeUnit: rentable.farmSizeUnit,
      poolSize: rentable.poolSize,
      checkInFrom: rentable.checkInFrom,
      checkOutBy: rentable.checkOutBy,
      bookingConfig: rentable.bookingConfig,
      totalUnits: rentable.totalUnits,
      updatedAt: rentable.updatedAt,
    })
    .from(rentable)
    .innerJoin(area, eq(area.id, rentable.areaId))
    .innerJoin(city, eq(city.id, rentable.cityId))
    .innerJoin(users, eq(users.id, rentable.clientId))
    .innerJoin(category, eq(category.id, rentable.categoryId))
    .leftJoin(rentablePrice, nightPrice)
    // Resolved by CODE, not slug — retitling must never 404.
    .where(and(eq(rentable.publicCode, publicCode), previewOwnerId?eq(rentable.clientId,previewOwnerId):publiclyListed()))
    .limit(1);

  if (!row) return null;

  // Public words and aggregates use the same evidence-backed publication view.
  const published = and(
    eq(review.rentableId, row.id),
    eq(review.authorRole, 'customer'),
    isNotNull(review.publishedAt),
    raw`${review.id} IN (SELECT id FROM public_customer_review)`,
  );

  const [prices, selectedAmenities, amenityCatalogue, physicalVisits, reviews, subScoreRows] = await Promise.all([
    db.select({ slot: rentablePrice.slot, weekday: raw`(${rentablePrice.weekdayMinor}/100)::int`.mapWith(Number).as('weekday'), weekend: raw`(${rentablePrice.weekendMinor}/100)::int`.mapWith(Number).as('weekend') })
      .from(rentablePrice)
      .where(eq(rentablePrice.rentableId, row.id)),
    db.select({
      id: amenity.id, label: amenity.labelEn, valueType: amenity.valueType,
      value: rentableAmenity.value, sortOrder: amenity.sortOrder,
    }).from(rentableAmenity)
      .innerJoin(amenity, eq(amenity.id, rentableAmenity.amenityId))
      .where(and(eq(rentableAmenity.rentableId, row.id), eq(amenity.isActive, true)))
      .orderBy(asc(amenity.sortOrder)),
    db.select({ id: amenity.id, label: amenity.labelEn, sortOrder: amenity.sortOrder })
      .from(amenity)
      // Only the listing's vertical: a venue page must not list "Private pool" as missing.
      .where(and(eq(amenity.isActive, true), eq(amenity.isFilterable, true),
        raw`exists (select 1 from amenity_vertical av where av.amenity_id=${amenity.id} and av.vertical_code=${row.vertical ?? DEFAULT_VERTICAL})`))
      .orderBy(asc(amenity.sortOrder)),
    db.select({ completedAt: verificationVisit.completedAt })
      .from(verificationVisit)
      .where(and(
        eq(verificationVisit.rentableId, row.id),
        eq(verificationVisit.mode, 'physical'),
        eq(verificationVisit.outcome, 'passed'),
        isNotNull(verificationVisit.completedAt),
      )).limit(1),
    db.select({
      id: review.id, rating: review.rating, body: review.body, ownerReply: review.ownerReply,
      cleanliness: review.cleanliness,
      accuracy: review.accuracy,
      valueForMoney: review.valueForMoney,
      staff: review.staff,
      location: review.location,
      comfort: review.comfort,
      facilities: review.facilities,
      travellerType: review.travellerType,
      publishedAt: review.publishedAt, authorName: users.name,
    })
      .from(review)
      .innerJoin(users, eq(users.id, review.authorId))
      .where(published)
      .orderBy(desc(review.publishedAt))
      .limit(10),

    // Averaged in SQL, over every published review — not over the ten above,
    // which would quietly turn a sub-score into "average of the last ten".
    db.select({
      n: raw`count(*)::int`.as('n'),
      cleanliness: raw`round(avg(${review.cleanliness})::numeric, 1)::float8`.as('cleanliness'),
      accuracy: raw`round(avg(${review.accuracy})::numeric, 1)::float8`.as('accuracy'),
      valueForMoney: raw`round(avg(${review.valueForMoney})::numeric, 1)::float8`.as('value_for_money'),
      staff: raw`round(avg(${review.staff})::numeric, 1)::float8`.as('staff'),
      location: raw`round(avg(${review.location})::numeric, 1)::float8`.as('location'),
      comfort: raw`round(avg(${review.comfort})::numeric, 1)::float8`.as('comfort'),
      facilities: raw`round(avg(${review.facilities})::numeric, 1)::float8`.as('facilities'),
    }).from(review).where(published),
  ]);

  const agg = subScoreRows[0] ?? {};
  const venue = row.vertical === 'hotel' && row.rentalUnit === 'night' ? await hotelDetail(row) : row.rentalUnit === 'hour' ? await venueDetail(row)
    : row.rentalUnit === 'unit_night' ? await apartmentDetail(row) : {};
  const petPolicy = row.rentalUnit === 'hour' ? null : publicPetPolicy(effectivePetPolicy(row.petPolicy,
    row.rentalUnit === 'night' ? venue.hotel?.policies?.pets === true : row.houseRules?.petsAllowed === true));
  const amenities = amenityStates({
    selected: selectedAmenities,
    catalogue: amenityCatalogue,
  });

  return {
    ...toCard(row),
    description: row.description,
    photos: normalizePublicPhotos(row.photos, photoContext(row)),
    amenities,
    houseRules: publicHouseRules(row.houseRules, petPolicy),
    // Story 3.8: limits only; the fee is shown once Story 3.9 charges it. Venues have no pet policy.
    petPolicy,
    depositAmount: row.depositAmount,
    cancellationTier: row.cancellationTier,
    areaSlug: row.areaSlug,
    citySlug: row.citySlug,
    areaName: row.areaName,
    cityName: row.cityName,
    areaId: row.areaId,
    approximateLocation: row.areaCentre
      ? { latitude: row.areaCentre.y, longitude: row.areaCentre.x }
      : null,
    cityId: row.cityId,
    categorySlug: row.categorySlug,
    categoryName: row.categoryName,
    farmSize: row.farmSize,
    farmSizeUnit: row.farmSizeUnit,
    poolSize: row.poolSize,
    checkInFrom: row.checkInFrom,
    checkOutBy: row.checkOutBy,
    verifiedAt: row.verifiedAt,
    physicallyVerified: Boolean(row.verifiedAt && physicalVisits.length),
    slotSchedules: publicSlotSchedules(row.bookingConfig),
    updatedAt: row.updatedAt,
    client: {
      /**
       * First name only, and no phone column is selected at all.
       * Per the information release ladder, a browsing visitor gets the
       * owner's first name, badge and response time — the phone number and
       * exact address unlock on confirmation. The safest way to honour that
       * is for the digits never to leave Postgres.
       */
      firstName: (row.clientName ?? '').trim().split(/\s+/)[0] || 'Owner',
      responseRate: row.clientResponseRate,
      respondsWithinMins: row.clientRespondsWithinMins,
      since: row.clientSince,
    },
    subScores: agg.n
      ? {
        cleanliness: agg.cleanliness,
        accuracy: agg.accuracy,
        valueForMoney: agg.valueForMoney,
        staff: agg.staff,
        location: agg.location,
        comfort: agg.comfort,
        facilities: agg.facilities,
      }
      : null,
    // Both rates per slot — a Saturday and a Tuesday are different prices,
    // and the slot selector has to be able to show the right one.
    prices: Object.fromEntries(
      prices.map((p) => [p.slot, { weekday: p.weekday, weekend: p.weekend }]),
    ),
    reviews,
    ...venue,
  };
}

/**
 * Public facts of a time-booked venue: courts (no internal state), their
 * activities, weekly opening hours and hourly rate bands in whole rupees,
 * like `prices`. Free/busy comes from /times, never from this cached page.
 */
async function venueDetail(row) {
  const [resources, rates] = await Promise.all([
    sql`SELECT r.id, r.name, r.capacity, r.is_indoor AS "isIndoor", r.details,
        COALESCE(json_agg(c.slug ORDER BY c.sort_order, c.name) FILTER (WHERE c.id IS NOT NULL), '[]'::json) AS activities
      FROM rentable_resource r LEFT JOIN rentable_resource_activity a ON a.resource_id = r.id
      LEFT JOIN category c ON c.id = a.category_id AND c.is_active
      WHERE r.rentable_id = ${row.id} AND r.is_active GROUP BY r.id ORDER BY r.sort_order, r.name, r.id`,
    sql`SELECT c.slug AS activity, rr.day_kind AS "dayKind", rr.start_minute AS "startMinute", rr.end_minute AS "endMinute",
        (rr.hourly_rate_minor / 100.0)::float8 AS "hourlyRate"
      FROM rentable_rate rr JOIN category c ON c.id = rr.category_id
      WHERE rr.rentable_id = ${row.id} ORDER BY c.sort_order, rr.day_kind, rr.start_minute`,
  ]);
  const config = row.bookingConfig?.model === 'hourly' ? row.bookingConfig : null;
  return {
    slotSchedules: [],
    prices: {},
    activities: row.activities ?? [],
    resources,
    openingHours: config
      ? { weeklyHours: config.weeklyHours, stepMinutes: config.stepMinutes, minDurationMinutes: config.minDurationMinutes, maxDurationMinutes: config.maxDurationMinutes, bookingHorizonDays: config.bookingHorizonDays }
      : null,
    // Live but mid-change (inventory not rebuilt yet): the page shows facts, not times.
    bookable: Boolean(config?.inventoryReady),
    rates: rates.map((r) => ({ activity: r.activity, dayKind: r.dayKind, from: minuteToHhmm(r.startMinute), to: minuteToHhmm(r.endMinute),
      endsNextDay: r.endMinute > 1440, hourlyRate: r.hourlyRate })),
    venueRules: row.houseRules ?? {},
  };
}

/** Public policy answers only: never the wizard's bookkeeping flags. */
const HOTEL_PUBLIC_POLICIES = ['couples', 'localId', 'idTypes', 'pets', 'smoking', 'parties', 'notes'];

/**
 * Public facts of a hotel (hotel plan, Phase 6): profile, room types with their
 * plans (no prices: those come from /rooms for the guest's dates and party),
 * and the nearest landmarks. The exact pin only when the owner chose to show it.
 */
/**
 * Story 3.11: the public facts of a whole apartment (rules and flat prices in whole rupees). The quote
 * decides availability and the total; null while the owner's setup is incomplete.
 */
async function apartmentDetail(row) {
  const [p] = await sql`SELECT * FROM apartment_profile WHERE rentable_id=${row.id}`;
  if (!p || p.weekday_minor == null || p.check_in_minute == null) return { apartment: null };
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { apartment: {
    bedrooms: p.bedrooms, bathrooms: p.bathrooms, beds: p.beds ?? [], maxAdults: p.max_adults, maxChildren: p.max_children, maxOccupants: p.max_occupants,
    minNights: p.min_nights, maxNights: p.max_nights, arrivalRules: p.arrival_rules, checkInTime: hhmm(p.check_in_minute), checkOutTime: hhmm(p.check_out_minute),
    turnoverNights: p.turnover_nights, weekday: Number(p.weekday_minor) / 100, weekend: Number(p.weekend_minor) / 100,
    cleaningFee: Number(p.cleaning_fee_minor) / 100, weekendNights: (p.weekend_nights ?? []).map(Number),
  } };
}

async function hotelDetail(row) {
  const [[profile], roomTypes, plans, landmarks] = await Promise.all([
    sql`SELECT p.star_rating, p.check_in_minute, p.check_out_minute, p.child_free_age, p.child_policy, p.policies, p.show_exact_address,
        r.location, CASE WHEN p.show_exact_address THEN r.exact_address END AS address
      FROM hotel_profile p JOIN rentable r ON r.id = p.rentable_id WHERE p.rentable_id = ${row.id}`,
    sql`SELECT id, name, beds, size_sqm AS "sizeSqm", view, max_adults AS "maxAdults", max_children AS "maxChildren",
        max_occupancy AS "maxOccupancy", room_count AS "roomCount", amenities, photos, extra_places AS "extraPlaces",
        extra_adult_includes_bedding AS "extraAdultIncludesBedding", child_policy AS "childPolicy", cots, extra_child_minor
      FROM room_type WHERE rentable_id = ${row.id} AND is_active ORDER BY sort_order, name, id`,
    sql`SELECT id, room_type_id AS "roomTypeId", name, meal_plan AS "mealPlan", free_cancel_hours AS "freeCancelHours", min_nights AS "minNights", inclusions
      FROM rate_plan WHERE rentable_id = ${row.id} AND is_active ORDER BY sort_order, name, id`,
    sql`SELECT slug, name, kind, latitude::float8 AS latitude, longitude::float8 AS longitude
      FROM landmark WHERE city_id = ${row.cityId} AND is_active`,
  ]);
  const pin = parsePoint(profile?.location);
  const policies = Object.fromEntries(HOTEL_PUBLIC_POLICIES.filter((key) => profile?.policies?.[key] != null).map((key) => [key, profile.policies[key]]));
  return {
    slotSchedules: [],
    prices: {},
    hotel: profile ? {
      starRating: profile.star_rating, checkIn: minuteToHhmm(profile.check_in_minute), checkOut: minuteToHhmm(profile.check_out_minute),
      childFreeAge: profile.child_free_age, policies,
      // Story 3.6: the saved property child bands, or null (each room then carries its own effective policy).
      childPolicy: profile.child_policy ?? null,
      exactLocation: profile.show_exact_address && pin ? { ...pin, address: profile.address } : null,
    } : null,
    roomTypes: roomTypes.map(({ extra_child_minor: extraChildMinor, childPolicy, ...room }) => ({
      ...room,
      childPolicy: effectiveChildPolicy({ childPolicy: profile?.child_policy, childFreeAge: profile?.child_free_age }, { childPolicy, extraChildMinor: Number(extraChildMinor) }),
      photos: normalizePublicPhotos(room.photos, { ...photoContext(row), title: `${row.title} · ${room.name}` }),
      plans: plans.filter((plan) => plan.roomTypeId === room.id).map(({ roomTypeId: _roomTypeId, ...plan }) => ({ ...plan, inclusions: resolveInclusions(plan.mealPlan, plan.inclusions) })),
    })),
    // Nearest six within 25 km, measured from the real pin even when the pin itself is not shown.
    landmarks: pin ? landmarks.map(({ latitude, longitude, ...landmark }) => ({ ...landmark, km: Math.round(distanceKm(pin, { latitude, longitude }) * 10) / 10 }))
      .filter((landmark) => landmark.km <= 25).sort((a, b) => a.km - b.km).slice(0, 6) : [],
    bookable: roomTypes.length > 0 && plans.length > 0,
  };
}

/**
 * Resolve a public code to an id, for callers that need nothing else —
 * the availability endpoint, which must not pay for a full listing join on
 * every calendar paint.
 */
/** id and booking model of a public listing; null when not publicly listed. */
export async function getListingRefByCode(publicCode) {
  const [row] = await db
    .select({ id: rentable.id, rentalUnit: rentable.rentalUnit })
    .from(rentable)
    .where(and(eq(rentable.publicCode, publicCode), publiclyListed()))
    .limit(1);
  return row ?? null;
}

export async function getListingIdByCode(publicCode) {
  const [row] = await db
    .select({ id: rentable.id })
    .from(rentable)
    .where(and(eq(rentable.publicCode, publicCode), publiclyListed()))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The next few bookable dates, per slot.
 *
 * This is what the ISR-cached listing page renders server-side, so the page
 * (and the WhatsApp preview card built from it) always carries a real date
 * without shipping the whole calendar. The date picker then loads live
 * availability client-side — the cached HTML must never be the source of
 * truth for what is still free.
 */
export async function getNextAvailableDates({ rentableId, days = 60, limit = 3 }) {
  const today = propertyToday();
  const [venue] = await sql`SELECT c.slug, (r.booking_config->>'minDurationMinutes')::int AS duration
    FROM rentable r JOIN category c ON c.id = r.category_id WHERE r.id = ${rentableId} AND r.rental_unit::text = 'hour'`;
  if (venue) {
    // Time-booked venue: the next days with at least one free start for its main activity.
    try {
      const result = await getHourlyAvailability(sql, { rentableId, from: today, days: Math.min(Number(days) || 30, 30),
        activity: venue.slug, durationMinutes: venue.duration ?? 60 });
      return { hourly: Object.entries(result.days).filter(([, entry]) => entry.freeStarts > 0).slice(0, limit).map(([date]) => date) };
    } catch (error) {
      if (/^[0-9A-Z]{5}$/.test(error.code ?? '') && !['42P01', '42703'].includes(error.code)) throw error;
      return { hourly: [] };
    }
  }
  try {
    const result = await getBookingAvailability(sql, { rentableId, from: today, to: addLocalDays(today, days - 1) });
    return Object.fromEntries(['day','night','full_day'].map((slot) => [slot,
      Object.entries(result.days).filter(([, entry]) => entry[slot === 'full_day' ? 'full' : slot]).slice(0, limit).map(([date]) => date),
    ]));
  } catch (error) {
    if (['42P01','42703','INVENTORY_NOT_READY','INVENTORY_REMEDIATION_REQUIRED','SCHEDULE_UNAVAILABLE','LISTING_UNAVAILABLE','OWNER_REPAYMENT_OVERDUE','UNSUPPORTED_INVENTORY'].includes(error.code)) return { day: [], night: [], full_day: [] };
    throw error;
  }
}

/**
 * "Similar farmhouses nearby" — the same area first, then the same city.
 *
 * Deliberately not a PostGIS radius query: the listing being viewed is the
 * centre, and a guest comparing farmhouses thinks in areas ("another one in
 * Kamrej"), not in kilometres.
 */
export async function getSimilarListings({ rentableId, areaId, cityId, limit = 4 }) {
  const rows = await db
    .select(cardColumns)
    .from(rentable)
    .innerJoin(area, eq(area.id, rentable.areaId))
    .innerJoin(city, eq(city.id, rentable.cityId))
    .leftJoin(rentablePrice, nightPrice)
    .where(and(
      publiclyListed(),
      ne(rentable.id, rentableId),
      eq(rentable.cityId, cityId),
      // Similar means the same vertical as the listing being viewed.
      raw`exists (select 1 from category vc where vc.id=${rentable.categoryId} and vc.vertical_code=
        (select oc.vertical_code from rentable o join category oc on oc.id=o.category_id where o.id=${rentableId}))`,
    ))
    .orderBy(
      // Same area first, then the same category, then verified, then best rated.
      raw`(${rentable.areaId} = ${areaId}) desc`,
      raw`(${rentable.categoryId} = (select o.category_id from rentable o where o.id=${rentableId})) desc`,
      raw`${rentable.verifiedAt} desc nulls last`,
      raw`${rentable.ratingAvg} desc nulls last`,
    )
    .limit(limit);

  return rows.map(toCard);
}

export async function getCities() {
  return db.select({ slug: city.slug, name: city.name })
    .from(city).where(eq(city.isActive, true)).orderBy(asc(city.sortOrder), asc(city.name));
}

export async function getAreas(citySlug) {
  return db.select({ slug: area.slug, name: area.name })
    .from(area).innerJoin(city, eq(city.id, area.cityId))
    .where(and(eq(city.slug, citySlug), eq(city.isActive, true), eq(area.isActive, true))).orderBy(asc(area.sortOrder), asc(area.name));
}

/** Sitemap source. Generated from the DB, never hand-maintained. */
export async function getSitemapEntries() {
  const listings = await db
    .select({
      slug: rentable.slug,
      publicCode: rentable.publicCode,
      updatedAt: rentable.updatedAt,
      photos: rentable.photos,
    })
    .from(rentable).where(publiclyListed());

  const cities = await db
    .select({ slug: city.slug }).from(city).where(eq(city.isActive, true));

  const areas = await db
    .select({ citySlug: city.slug, areaSlug: area.slug })
    .from(area).innerJoin(city, eq(city.id, area.cityId)).where(and(eq(city.isActive, true), eq(area.isActive, true)));

  // Google Images reads up to the first few photos per page from the sitemap.
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  return {
    listings: listings.map(({ photos, ...listing }) => ({
      ...listing,
      images: normalizePublicPhotos(photos, { cloudName }).slice(0, 6).map((p) => p.url),
    })),
    cities,
    areas,
  };
}

/**
 * Count of live listings for an area page — drives the thin-page guard.
 * Under 3 listings, the page is noindexed rather than published as a
 * doorway page.
 */
export async function countLiveInArea({ citySlug, areaSlug }) {
  const [row] = await db
    .select({ n: raw`count(*)::int`.as('n') })
    .from(rentable)
    .innerJoin(area, eq(area.id, rentable.areaId))
    .innerJoin(city, eq(city.id, rentable.cityId))
    .where(and(
      publiclyListed(),
      eq(city.slug, citySlug),
      eq(area.slug, areaSlug),
    ));
  return row?.n ?? 0;
}
