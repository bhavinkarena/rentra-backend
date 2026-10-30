import 'server-only';
import { sql } from './index.js';
import { previewBookingQuote } from '../booking/quotes.js';
import { listingPath } from '../domain/listing-url.js';
import { savedListingHref } from '../domain/saved-places.js';
import { validRouteSlug, sortDiscoveryCards, resolveDiscoveryRoute, DISCOVERY_INTENTS } from '../domain/discovery.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';
import { DEFAULT_VERTICAL } from '../domain/verticals.js';
import { STAY_VERTICAL } from '../domain/discovery.js';
import { getSearchTimeSlots } from '../booking/time-slots.js';
import { hotelSearchOffers } from '../booking/hotel-stays.js';
import { apartmentSearchOffers } from '../booking/apartment-stays.js';

/** Story 3.11: an apartment guests can book has every part of its setup saved. */
const APARTMENT_PRICED = (database) => database`EXISTS (SELECT 1 FROM apartment_profile ap WHERE ap.rentable_id=r.id
  AND ap.weekday_minor IS NOT NULL AND ap.weekend_minor IS NOT NULL AND ap.check_in_minute IS NOT NULL AND ap.check_out_minute IS NOT NULL)`;
import { distanceKm, parsePoint } from '../domain/geo.js';
import { betaVerticals, visibleVertical } from '../auth/beta-access.js';

/** In-process registry cache (P5): it was 4 queries on every search request. */
const REGISTRY_TTL_MS = 60_000;
const registryCache = new WeakMap();
/** Catalogue writers call this so the next read in this process is fresh; other instances fall back to the TTL. */
export function clearDiscoveryRegistryCache(database = sql) {
  registryCache.delete(database);
}

/**
 * Public catalogue: public verticals, their active categories (with vertical,
 * icon and booking model), cities, areas and filterable amenities (with the
 * verticals they belong to). Keys are additive, so older clients ignore them.
 */
export async function getDiscoveryRegistry(database = sql) {
  // A beta pass changes what is visible: never served from, or stored in, the shared cache.
  const beta = betaVerticals().length > 0;
  const cached = beta ? null : registryCache.get(database);
  if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.value;
  const [cities, areas, categories, amenities, verticals, landmarks] = await Promise.all([
    database`SELECT id,slug,name FROM city WHERE is_active=true ORDER BY sort_order,name,id`,
    database`SELECT a.id,a.city_id AS "cityId",a.slug,a.name FROM area a JOIN city c ON c.id=a.city_id WHERE c.is_active=true AND a.is_active=true ORDER BY a.sort_order,a.name,a.id`,
    database`SELECT c.id,c.slug,c.name,c.vertical_code AS vertical,c.icon_key AS "iconKey",c.default_rental_unit::text AS "rentalUnit"
      FROM category c JOIN vertical v ON v.code=c.vertical_code AND ${visibleVertical(database)}
      WHERE c.is_active=true ORDER BY v.sort_order,c.sort_order,c.name,c.id`,
    database`SELECT a.slug,a.label_en AS name,
        COALESCE(json_agg(av.vertical_code ORDER BY av.vertical_code) FILTER (WHERE av.vertical_code IS NOT NULL), '[]'::json) AS verticals
      FROM amenity a LEFT JOIN amenity_vertical av ON av.amenity_id=a.id
      WHERE a.is_active=true AND a.is_filterable=true GROUP BY a.id ORDER BY a.sort_order,a.slug`,
    database`SELECT v.code,v.slug,v.name,v.sort_order AS "sortOrder",v.status='partners' AS beta FROM vertical v WHERE ${visibleVertical(database)} ORDER BY v.sort_order,v.code`,
    database`SELECT l.slug,l.name,l.kind,l.city_id AS "cityId",l.latitude::float8 AS latitude,l.longitude::float8 AS longitude
      FROM landmark l JOIN city c ON c.id=l.city_id AND c.is_active WHERE l.is_active ORDER BY l.sort_order,l.name`,
  ]);
  const value = { verticals, cities: cities.filter(r => validRouteSlug(r.slug)), areas: areas.filter(r => validRouteSlug(r.slug)), categories: categories.filter(r => validRouteSlug(r.slug)), amenities,
    // Landmarks belong to Hotels: nothing about them is public until that vertical is.
    landmarks: verticals.some(r => r.code === STAY_VERTICAL) ? landmarks.filter(r => validRouteSlug(r.slug)) : [] };
  if (!beta) registryCache.set(database, { at: Date.now(), value });
  return value;
}

/**
 * Story 3.9: the effective pet policy (saved, else the legacy yes/no flag, which allows 1) takes `pets`.
 * Mirrors effectivePetPolicy + petProblem; the quote still decides.
 */
const petsFit = (database, legacy, pets) => database`(CASE WHEN r.pet_policy IS NULL OR jsonb_typeof(r.pet_policy)<>'object' THEN COALESCE((${legacy})='true', false) AND ${pets}::int <= 1
  ELSE r.pet_policy->>'status'='allowed' AND (r.pet_policy->>'maxPets')::int >= ${pets}::int END)`;

const unavailable = new Set(['INVENTORY_NOT_READY', 'INVENTORY_REMEDIATION_REQUIRED', 'SCHEDULE_UNAVAILABLE', 'LISTING_UNAVAILABLE', 'OWNER_REPAYMENT_OVERDUE', 'UNSUPPORTED_INVENTORY', 'SLOT_UNAVAILABLE', 'CAPACITY_EXCEEDED', 'AVAILABILITY_CONFLICT', 'NOT_FOUND', 'PETS_NOT_ALLOWED', 'PETS_OVER_LIMIT']);

/**
 * Story 3.1: a zero-result page also carries `meta.inventory`, the live count for the
 * location, category and vertical alone (no filters, dates or party), so the guest sees
 * "nothing listed here yet" apart from "your filters exclude everything". Read-only.
 */
export async function searchDiscovery(filters, route = null, database = sql, registry = null) {
  const result = await searchDiscoveryResults(filters, route, database, registry);
  if (result.total || result.errors?.length || result.code) return result;
  const city = route?.city?.slug || filters.city, area = route?.area?.slug || filters.area;
  const category = route?.category?.slug || filters.category;
  const vertical = route?.verticalCode ?? filters.vertical ?? DEFAULT_VERTICAL;
  const term = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
  const [row] = await database`SELECT count(*)::int AS n FROM rentable r
    JOIN city c ON c.id=r.city_id JOIN area a ON a.id=r.area_id JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    JOIN vertical v ON v.code=cat.vertical_code AND ${visibleVertical(database)} AND v.code=${vertical}
    WHERE r.status='live' AND c.is_active AND a.is_active AND cat.is_active AND u.role='client' AND u.account_status='active'
      AND (${!city} OR c.slug=${city}) AND (${!area} OR a.slug=${area})
      AND (${!category} OR cat.slug=${category} OR (r.rental_unit::text='hour' AND EXISTS (SELECT 1 FROM rentable_resource_activity ra
        JOIN category ac ON ac.id=ra.category_id WHERE ra.rentable_id=r.id AND ac.slug=${category})))
      AND (${!filters.q} OR a.name ILIKE ${term} OR c.name ILIKE ${term} OR r.title ILIKE ${term})
      -- Hotels count only when bookable at all (the main search's rate-plan predicate, without the
      -- freecancel/breakfast filters). Remaining gap: farm/venue inventory-readiness and the hotel
      -- landmark radius are not mirrored, so a hidden-by-readiness listing still counts as inventory.
      AND (${vertical !== STAY_VERTICAL} OR (r.rental_unit::text='night' AND EXISTS (SELECT 1 FROM rate_plan rp
        JOIN room_type rt ON rt.id=rp.room_type_id AND rt.is_active WHERE rp.rentable_id=r.id AND rp.is_active))
        OR (r.rental_unit::text='unit_night' AND ${APARTMENT_PRICED(database)}))`;
  return { ...result, meta: { ...result.meta, inventory: row.n } };
}

/** Filter every candidate before global sorting/pagination; never paginate before availability. */
async function searchDiscoveryResults(filters, route = null, database = sql, registry = null) {
  registry ??= await getDiscoveryRegistry(database);
  const city = route?.city?.slug || filters.city;
  const category = route?.category?.slug || filters.category;
  const area = route?.area?.slug || filters.area;
  const vertical = route?.verticalCode ?? filters.vertical ?? DEFAULT_VERTICAL;
  const errors = [];
  const verticals = registry.verticals ?? [{ code: DEFAULT_VERTICAL }];
  if (!verticals.some(r => r.code === vertical)) errors.push('Choose an available kind of place.');
  const chosen = category && registry.categories.find(r => r.slug === category);
  // VERTICAL_MISMATCH: a category always implies its vertical.
  if (chosen && (chosen.vertical ?? DEFAULT_VERTICAL) !== vertical) return {
    items: [], total: 0, page: 1, totalPages: 1, code: 'VERTICAL_MISMATCH',
    errors: [`${chosen.name} is not in this kind of place. Switch the tab or clear the category.`],
  };
  for (const key of ['city', 'area', 'category']) {
    if (route?.[key] && filters[key] && filters[key] !== route[key].slug) errors.push(`This page is limited to ${route[key].name}; clear the conflicting ${key} filter or use Search all places.`);
  }
  if (city && !registry.cities.some(r => r.slug === city)) errors.push('Choose an available city.');
  if (category && !registry.categories.some(r => r.slug === category)) errors.push('Choose an available category.');
  if (area && !city) errors.push('Choose a city before selecting an area.');
  if (area && !registry.areas.some(r => r.slug === area && (!city || registry.cities.some(c => c.id === r.cityId && c.slug === city)))) errors.push('Choose an area in the selected city.');
  if (filters.amenities.some(a => !registry.amenities.some(r => r.slug === a))) errors.push('Choose available amenities.');
  if (route?.intent?.slot && filters.slot !== route.intent.slot) errors.push('Day picnic requires the day slot.');
  const landmark = filters.near ? (registry.landmarks ?? []).find(r => r.slug === filters.near) : null;
  if (filters.near && !landmark) errors.push('Choose an available landmark.');
  if (landmark && city && !registry.cities.some(c => c.slug === city && c.id === landmark.cityId)) errors.push('That landmark is in another city.');
  if (errors.length) return { items: [], total: 0, page: 1, totalPages: 1, errors };
  const amenities = [...new Set([...filters.amenities, ...(route?.intent?.amenity ? [route.intent.amenity] : [])])];
  if (vertical === STAY_VERTICAL) return searchHotels({ filters, city, area, category: chosen, amenities, policy: route?.intent?.policy ?? null, landmark, database });
  if (vertical !== DEFAULT_VERTICAL) return searchVenues({ filters, city, area, category: chosen, vertical, amenities, database });
  // Escape SQL LIKE wildcards so a location term is literal user text.
  const term = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
  let cursor = '00000000-0000-0000-0000-000000000000';
  const cards = [];
  while (true) {
    const rows = await database`
      SELECT r.id,r.slug,r.public_code,r.title,r.capacity,r.bedrooms,r.highlight,r.photos,r.created_at,r.rating_avg,r.review_count,
        (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)) AS physically_verified,
        a.name AS area_name,c.name AS city_name,(p.weekday_minor/100)::int AS weekday,(p.weekend_minor/100)::int AS weekend
      FROM rentable r JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id
      JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
      JOIN vertical v ON v.code=cat.vertical_code AND v.status='public' AND v.code=${DEFAULT_VERTICAL}
      LEFT JOIN rentable_price p ON p.rentable_id=r.id AND p.slot=${filters.slot}
      WHERE r.status='live' AND u.role='client' AND u.account_status='active' AND c.is_active=true AND a.is_active=true AND cat.is_active=true
        AND r.id>${cursor}::uuid AND r.capacity>=${filters.guests}
        -- Cheap prefilter before the per-listing quote: only listings the quote could accept
        -- (inventory ready, every requested date open for every half of the slot).
        AND (${!filters.dates.length} OR (r.booking_config->>'inventoryReady' = 'true' AND NOT EXISTS (
          SELECT 1 FROM unnest(${filters.dates}::text[]::date[]) d(day)
          CROSS JOIN unnest(CASE WHEN ${filters.slot}='full_day' THEN ARRAY['day','night'] ELSE ARRAY[${filters.slot}] END) h(slot)
          WHERE NOT EXISTS (SELECT 1 FROM availability av WHERE av.rentable_id=r.id AND av.day=d.day
            AND av.slot::text=h.slot AND av.units_available>0))))
        AND (${!city} OR c.slug=${city}) AND (${!area} OR a.slug=${area}) AND (${!category} OR cat.slug=${category})
        AND (${!filters.q} OR a.name ILIKE ${term} OR c.name ILIKE ${term} OR r.title ILIKE ${term})
        AND (${!filters.cancellation} OR r.cancellation_tier::text=${filters.cancellation})
        AND (${!filters.pets} OR ${petsFit(database, database`r.house_rules->>'petsAllowed'`, filters.pets)})
        AND NOT EXISTS (SELECT 1 FROM unnest(${amenities}::text[]) wanted(slug) WHERE NOT EXISTS (
          SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id
          WHERE ra.rentable_id=r.id AND am.slug=wanted.slug AND am.is_active=true))
      ORDER BY r.id LIMIT 100`;
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = await Promise.all(rows.slice(offset, offset + 4).map(async row => {
        if (filters.bedrooms != null && (row.bedrooms == null || Number(row.bedrooms) < filters.bedrooms)) return null;
        if (filters.verified === '1' && !row.physically_verified) return null;
        let selection = null, totals = null;
        if (filters.dates.length) {
          selection = { rentableId: row.id, dates: filters.dates, slot: filters.slot, guests: filters.guests, ...(filters.pets ? { pets: filters.pets } : {}) };
          try { totals = (await previewBookingQuote(database, selection)).totals; }
          catch (error) {
            if (error instanceof RangeError || unavailable.has(error.code)) return null;
            throw error; // A database outage is an error, never a successful empty result.
          }
        }
        const rates = [row.weekday, row.weekend].filter(v => v != null).map(Number);
        const price = totals ? totals.totalMinor / 100 : rates.length ? Math.min(...rates) : null;
        if ((filters.min != null || filters.max != null) && price == null) return null;
        if (filters.min != null && price < filters.min || filters.max != null && price > filters.max) return null;
        const photos = normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME, title: row.title, place: `${row.area_name}, ${row.city_name}` });
        return { id: row.id, href: savedListingHref(listingPath(row.slug, row.public_code), selection), selection,
          title: row.title, area: `${row.area_name}, ${row.city_name}`, capacity: row.capacity, bedrooms: row.bedrooms,
          highlight: row.highlight, price, priceMinor: totals?.totalMinor ?? null, isFromPrice: !totals, unit: totals ? `${filters.dates.length} visit${filters.dates.length === 1 ? '' : 's'}` : filters.slot.replace('_', ' '),
          priceNote: totals ? `Includes platform fee. Refundable deposit ₹${(totals.depositMinor / 100).toLocaleString('en-IN')} separate. Availability can change.` : 'Base rent; guest charges, platform fee and refundable deposit extra. Select dates for a total.',
          rating: row.rating_avg == null ? null : Number(row.rating_avg), reviewCount: Number(row.review_count), badge: row.physically_verified ? 'verified' : null, photos, photo: photos[0] ?? null, photoCount: photos.length,
          createdAt: new Date(row.created_at).toISOString() };
      }));
      cards.push(...batch.filter(Boolean));
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1).id;
  }
  sortDiscoveryCards(cards, filters.sort);
  const total = cards.length, totalPages = Math.max(1, Math.ceil(total / 12)), page = Math.min(filters.page, totalPages);
  return { items: cards.slice((page - 1) * 12, page * 12), total, totalPages, page, errors: [] };
}

/**
 * Time-booked venues (any non-farmhouse vertical). Undated: "from ₹X / hr".
 * Dated: up to three free start times at or after `start`, from the same grid
 * the venue page shows. One statement loads each candidate batch in a shared
 * snapshot, then the same grid algorithm runs in memory without write locks.
 */
async function searchVenues({ filters, city, area, category, vertical, amenities, database }) {
  const term = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
  const players = filters.players ?? 1;
  const date = filters.dates[0] ?? null;
  const activityId = category?.id ?? null;
  let cursor = '00000000-0000-0000-0000-000000000000';
  const cards = [];
  while (true) {
    const rows = await database`
      SELECT r.id,r.slug,r.public_code,r.title,r.highlight,r.photos,r.created_at,r.rating_avg,r.review_count,
        (r.booking_config->>'minDurationMinutes')::int AS min_duration,
        (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)) AS physically_verified,
        a.name AS area_name,c.name AS city_name,cat.slug AS primary_activity,
        (SELECT min(rr.hourly_rate_minor) FROM rentable_rate rr WHERE rr.rentable_id=r.id AND (${!activityId} OR rr.category_id=${activityId}::uuid)) AS hour_from_minor,
        (SELECT count(*)::int FROM rentable_resource rs WHERE rs.rentable_id=r.id AND rs.is_active) AS resource_count,
        (SELECT max(rs.capacity) FROM rentable_resource rs WHERE rs.rentable_id=r.id AND rs.is_active) AS max_players,
        (SELECT CASE WHEN bool_and(rs.is_indoor) THEN 'indoor' WHEN NOT bool_or(rs.is_indoor) THEN 'outdoor' WHEN count(rs.is_indoor)>0 THEN 'mixed' END
          FROM rentable_resource rs WHERE rs.rentable_id=r.id AND rs.is_active) AS indoor_kinds,
        (SELECT coalesce(json_agg(json_build_object('slug',ac.slug,'name',ac.name,'iconKey',ac.icon_key) ORDER BY ac.sort_order,ac.name),'[]'::json)
          FROM category ac WHERE ac.is_active AND ac.id IN (SELECT ra.category_id FROM rentable_resource_activity ra
            JOIN rentable_resource rs ON rs.id=ra.resource_id AND rs.is_active WHERE ra.rentable_id=r.id)) AS activities
      FROM rentable r JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id
      JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
      JOIN vertical v ON v.code=cat.vertical_code AND v.status='public' AND v.code=${vertical}
      WHERE r.status='live' AND r.rental_unit::text='hour' AND u.role='client' AND u.account_status='active'
        AND c.is_active=true AND a.is_active=true AND cat.is_active=true AND r.id>${cursor}::uuid
        AND (${!date} OR r.booking_config->>'inventoryReady' = 'true')
        -- A court that offers the activity (any, when none is chosen) and takes the group.
        AND EXISTS (SELECT 1 FROM rentable_resource rs JOIN rentable_resource_activity ra ON ra.resource_id=rs.id
          WHERE rs.rentable_id=r.id AND rs.is_active AND rs.capacity>=${players}
            AND (${!activityId} OR ra.category_id=${activityId}::uuid)
            AND (${filters.indoor == null} OR rs.is_indoor=${filters.indoor ?? false}))
        AND (${!city} OR c.slug=${city}) AND (${!area} OR a.slug=${area})
        AND (${!filters.q} OR a.name ILIKE ${term} OR c.name ILIKE ${term} OR r.title ILIKE ${term})
        AND (${!filters.cancellation} OR r.cancellation_tier::text=${filters.cancellation})
        AND (${filters.verified !== '1'} OR (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv
          WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)))
        AND NOT EXISTS (SELECT 1 FROM unnest(${amenities}::text[]) wanted(slug) WHERE NOT EXISTS (
          SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id
          WHERE ra.rentable_id=r.id AND am.slug=wanted.slug AND am.is_active=true))
      ORDER BY r.id LIMIT 100`;
    const grids = date ? await getSearchTimeSlots(database, rows.map((row) => ({
      rentableId: row.id, date, activity: category?.slug ?? row.primary_activity,
      durationMinutes: filters.duration ?? row.min_duration ?? 60, guests: players,
    }))) : null;
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = await Promise.all(rows.slice(offset, offset + 4).map(async row => {
        const activity = category?.slug ?? row.primary_activity;
        const duration = filters.duration ?? row.min_duration ?? 60;
        let times = null;
        if (date) {
          try {
            const grid = grids.get(row.id);
            if (grid.error) throw grid.error;
            times = grid.times.filter(t => !filters.start || t.start >= filters.start).slice(0, 3);
          } catch (error) {
            if (error instanceof RangeError || unavailable.has(error.code) || ['ACTIVITY_UNAVAILABLE', 'PRICE_MISSING'].includes(error.code)) return null;
            throw error;
          }
          if (!times.length) return null;
        }
        const cheapest = times ? Math.min(...times.map(t => t.rentMinor)) : null;
        const price = times ? cheapest / 100 : row.hour_from_minor == null ? null : Number(row.hour_from_minor) / 100;
        if ((filters.min != null || filters.max != null) && price == null) return null;
        // Budget filters are per hour for venues.
        const perHour = times ? price / (duration / 60) : price;
        if (filters.min != null && perHour < filters.min || filters.max != null && perHour > filters.max) return null;
        const photos = normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME, title: row.title, place: `${row.area_name}, ${row.city_name}` });
        const selection = date ? { kind: 'hourly', activity, date, durationMinutes: duration, guests: players } : null;
        const query = selection ? `?${new URLSearchParams({ activity, date, duration: String(duration), players: String(players) })}` : '';
        return { id: row.id, vertical, rentalUnit: 'hour', href: `${listingPath(row.slug, row.public_code)}${query}`, selection,
          title: row.title, area: `${row.area_name}, ${row.city_name}`, highlight: row.highlight,
          activities: row.activities ?? [], resourceCount: Number(row.resource_count), maxPlayers: row.max_players == null ? null : Number(row.max_players),
          isIndoor: row.indoor_kinds == null ? null : row.indoor_kinds === 'indoor' ? true : row.indoor_kinds === 'outdoor' ? false : 'mixed',
          times: times?.map(t => ({ start: t.start, end: t.end, endsNextDay: t.endsNextDay, rentMinor: t.rentMinor, peak: t.peak })) ?? null,
          price, priceMinor: cheapest, isFromPrice: !times, unit: times ? `${duration / 60} hr` : 'hour',
          priceNote: times ? 'Court rent for the time shown; platform fee added at checkout. Availability can change.' : 'Per hour; platform fee added at checkout. Choose a date and time for a total.',
          rating: row.rating_avg == null ? null : Number(row.rating_avg), reviewCount: Number(row.review_count), badge: row.physically_verified ? 'verified' : null,
          photos, photo: photos[0] ?? null, photoCount: photos.length, createdAt: new Date(row.created_at).toISOString() };
      }));
      cards.push(...batch.filter(Boolean));
    }
    if (rows.length < 100) break;
    cursor = rows.at(-1).id;
  }
  sortDiscoveryCards(cards, filters.sort);
  const total = cards.length, totalPages = Math.max(1, Math.ceil(total / 12)), page = Math.min(filters.page, totalPages);
  return { items: cards.slice((page - 1) * 12, page * 12), total, totalPages, page, errors: [] };
}

/** "Near a landmark" means within this many km of it (hotel plan §4.4). */
export const NEAR_KM = 5;
const HOTEL_FROM_MINOR = (database) => database`(SELECT min(CASE WHEN rp.derived_from IS NULL THEN least(rp.weekday_minor,rp.weekend_minor)
    ELSE (SELECT least(b.weekday_minor,b.weekend_minor) FROM rate_plan b WHERE b.id=rp.derived_from)*(10000+rp.derived_pct_bps)/10000 END)
  FROM rate_plan rp JOIN room_type rt ON rt.id=rp.room_type_id AND rt.is_active WHERE rp.rentable_id=r.id AND rp.is_active)`;
const MEALS = { CP: 'Breakfast included', MP: 'Breakfast and one meal', AP: 'All meals' };

/**
 * Hotels (hotel plan, Phase 6). One statement finds the candidates; with dates,
 * hotelSearchOffers prices every candidate in one snapshot with the same
 * functions as the hotel page and the quote, so the card total is the quote
 * total. Undated cards say "from ₹X / night". Budget filters are per room per night.
 */
async function searchHotels({ filters, city, area, category, amenities, policy, landmark, database }) {
  const term = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
  const couples = filters.couples === '1' || policy === 'couples';
  const localId = filters.localid === '1' || policy === 'localId';
  const rows = await database`
    SELECT r.id,r.slug,r.public_code,r.title,r.highlight,r.photos,r.created_at,r.rating_avg,r.review_count,
      (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)) AS physically_verified,
      a.name AS area_name,c.name AS city_name,cat.name AS category_name,hp.star_rating,hp.policies,r.pet_policy,
      ${HOTEL_FROM_MINOR(database)} AS from_minor,
      hp.show_exact_address,r.location,a.centre
    FROM rentable r JOIN hotel_profile hp ON hp.rentable_id=r.id
    JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id
    JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    JOIN vertical v ON v.code=cat.vertical_code AND ${visibleVertical(database)} AND v.code=${STAY_VERTICAL}
    WHERE r.status='live' AND r.rental_unit::text='night' AND u.role='client' AND u.account_status='active'
      AND c.is_active=true AND a.is_active=true AND cat.is_active=true
      AND (${!city} OR c.slug=${city}) AND (${!area} OR a.slug=${area}) AND (${!category} OR cat.id=${category?.id ?? null}::uuid)
      AND (${!landmark} OR (c.id=${landmark?.cityId ?? null}::uuid AND r.location IS NOT NULL))
      AND (${!filters.q} OR a.name ILIKE ${term} OR c.name ILIKE ${term} OR r.title ILIKE ${term})
      AND (${!couples} OR hp.policies->>'couples'='true') AND (${!localId} OR hp.policies->>'localId'='true')
      AND (${!filters.pets} OR ${petsFit(database, database`hp.policies->>'pets'`, filters.pets)})
      AND (${!filters.rating} OR r.rating_avg>=${filters.rating || 0}::numeric)
      AND (${filters.verified !== '1'} OR (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv
        WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)))
      AND NOT EXISTS (SELECT 1 FROM unnest(${amenities}::text[]) wanted(slug) WHERE NOT EXISTS (
        SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id
        WHERE ra.rentable_id=r.id AND am.slug=wanted.slug AND am.is_active=true))
      -- A hotel guests can book: an active room type with an active plan (with free cancellation / meals when asked).
      AND EXISTS (SELECT 1 FROM rate_plan rp JOIN room_type rt ON rt.id=rp.room_type_id AND rt.is_active WHERE rp.rentable_id=r.id AND rp.is_active
        AND (${filters.freecancel !== '1'} OR rp.free_cancel_hours IS NOT NULL) AND (${filters.breakfast !== '1'} OR rp.meal_plan<>'EP'))
    ORDER BY r.id`;
  // Distance from the landmark in JS (no PostGIS needed): a city has hundreds of hotels, not millions.
  for (const row of rows) {
    const pin = parsePoint(row.location);
    row.distance_km = landmark && pin ? Math.round(distanceKm(pin, landmark) * 10) / 10 : null;
    // Map pin: the hotel when the owner shows its address, else the area centre.
    row.pin = (row.show_exact_address ? pin : null) ?? parsePoint(row.centre);
  }
  const candidates = landmark ? rows.filter(row => row.distance_km != null && row.distance_km <= NEAR_KM) : rows;
  const dated = Boolean(filters.checkin);
  const stay = dated ? { checkIn: filters.checkin, checkOut: filters.checkout, rooms: filters.rooms, adults: filters.adults, childAges: filters.children } : null;
  const offers = dated ? await hotelSearchOffers(database, candidates.map(row => ({ id: row.id, pet_policy: row.pet_policy })), {
    ...stay, pets: filters.pets, freeCancel: filters.freecancel === '1', breakfast: filters.breakfast === '1',
  }) : null;
  const guests = `${filters.adults} adult${filters.adults === 1 ? '' : 's'}${filters.children.length ? `, ${filters.children.length} child${filters.children.length === 1 ? '' : 'ren'}` : ''}`;
  const cards = [];
  for (const row of candidates) {
    const offer = offers?.get(row.id) ?? null;
    if (dated && !offer) continue;
    const price = offer ? offer.totalMinor / 100 : row.from_minor == null ? null : Number(row.from_minor) / 100;
    if ((filters.min != null || filters.max != null) && price == null) continue;
    const perNight = offer ? price / offer.nights / filters.rooms : price;
    if (filters.min != null && perNight < filters.min || filters.max != null && perNight > filters.max) continue;
    const photos = normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME, title: row.title, place: `${row.area_name}, ${row.city_name}` });
    const query = stay ? `?${new URLSearchParams({ checkin: stay.checkIn, checkout: stay.checkOut, rooms: String(stay.rooms), adults: String(stay.adults), ...(stay.childAges.length ? { children: stay.childAges.join(',') } : {}), ...(filters.pets ? { pets: String(filters.pets) } : {}) })}` : '';
    cards.push({
      id: row.id, vertical: STAY_VERTICAL, rentalUnit: 'night', href: `${listingPath(row.slug, row.public_code)}${query}`, selection: stay,
      title: row.title, area: `${row.area_name}, ${row.city_name}`, highlight: row.highlight, categoryName: row.category_name,
      starRating: row.star_rating, couples: row.policies?.couples === true, localId: row.policies?.localId === true,
      distanceKm: row.distance_km, landmark: landmark ? landmark.name : null,
      location: row.pin,
      offer: offer ? { roomTypeName: offer.roomTypeName, planName: offer.planName, mealPlan: offer.mealPlan, meals: MEALS[offer.mealPlan] ?? null,
        freeUntil: offer.freeUntil, roomsLeft: offer.roomsLeft <= 3 ? offer.roomsLeft : null, nights: offer.nights, taxMinor: offer.taxMinor } : null,
      price, priceMinor: offer?.totalMinor ?? null, isFromPrice: !offer,
      unit: offer ? `${offer.nights} night${offer.nights === 1 ? '' : 's'}, ${filters.rooms > 1 ? `${filters.rooms} rooms, ` : ''}${guests}` : 'night',
      priceNote: offer ? 'Total for your stay, taxes included. Availability can change.' : 'Per room per night, before taxes. Add dates for the total.',
      rating: row.rating_avg == null ? null : Number(row.rating_avg), reviewCount: Number(row.review_count), badge: row.physically_verified ? 'verified' : null,
      photos, photo: photos[0] ?? null, photoCount: photos.length, createdAt: new Date(row.created_at).toISOString(),
    });
  }
  if (!category || category.rentalUnit === 'unit_night') cards.push(...await apartmentCards({ filters, city, area, category, amenities, landmark, couples, localId, term, database }));
  sortDiscoveryCards(cards, filters.sort === 'distance' && !landmark ? 'recommended' : filters.sort);
  const total = cards.length, totalPages = Math.max(1, Math.ceil(total / 12)), page = Math.min(filters.page, totalPages);
  return { items: cards.slice((page - 1) * 12, page * 12), total, totalPages, page, errors: [], landmark: landmark ? { slug: landmark.slug, name: landmark.name, km: NEAR_KM } : null };
}

/**
 * Story 3.11: whole apartments in the stay vertical (all stays, or the Whole apartment tab). Dated searches
 * keep only apartments free for the dates (turnover included) that take the party, nights rules and pets,
 * and show the full-stay total (nights, cleaning, pets and the service fee). Hotel-only filters exclude them.
 */
async function apartmentCards({ filters, city, area, category, amenities, landmark, couples, localId, term, database }) {
  if (couples || localId || filters.freecancel === '1' || filters.breakfast === '1') return [];
  const rows = await database`
    SELECT r.id,r.slug,r.public_code,r.title,r.highlight,r.photos,r.created_at,r.rating_avg,r.review_count,r.pet_policy,r.location,a.centre,
      (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)) AS physically_verified,
      a.name AS area_name,c.name AS city_name,cat.name AS category_name, least(ap.weekday_minor, ap.weekend_minor) AS from_minor,
      ap.bedrooms, ap.max_occupants, ap.cleaning_fee_minor
    FROM rentable r JOIN apartment_profile ap ON ap.rentable_id=r.id
    JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id
    JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    JOIN vertical v ON v.code=cat.vertical_code AND ${visibleVertical(database)} AND v.code=${STAY_VERTICAL}
    WHERE r.status='live' AND r.rental_unit::text='unit_night' AND u.role='client' AND u.account_status='active'
      AND c.is_active=true AND a.is_active=true AND cat.is_active=true AND ${APARTMENT_PRICED(database)}
      AND (${!city} OR c.slug=${city}) AND (${!area} OR a.slug=${area}) AND (${!category} OR cat.id=${category?.id ?? null}::uuid)
      AND (${!landmark} OR (c.id=${landmark?.cityId ?? null}::uuid AND r.location IS NOT NULL))
      AND (${!filters.q} OR a.name ILIKE ${term} OR c.name ILIKE ${term} OR r.title ILIKE ${term})
      AND (${!filters.pets} OR ${petsFit(database, database`r.house_rules->>'petsAllowed'`, filters.pets)})
      AND (${!filters.rating} OR r.rating_avg>=${filters.rating || 0}::numeric)
      AND (${filters.verified !== '1'} OR (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv
        WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)))
      AND NOT EXISTS (SELECT 1 FROM unnest(${amenities}::text[]) wanted(slug) WHERE NOT EXISTS (
        SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id
        WHERE ra.rentable_id=r.id AND am.slug=wanted.slug AND am.is_active=true))
    ORDER BY r.id`;
  for (const row of rows) {
    const pin = parsePoint(row.location);
    row.distance_km = landmark && pin ? Math.round(distanceKm(pin, landmark) * 10) / 10 : null;
  }
  const candidates = landmark ? rows.filter(row => row.distance_km != null && row.distance_km <= NEAR_KM) : rows;
  const dated = Boolean(filters.checkin);
  const stay = dated ? { checkIn: filters.checkin, checkOut: filters.checkout, adults: filters.adults, childAges: filters.children } : null;
  const offers = dated ? await apartmentSearchOffers(database, candidates, { ...stay, pets: filters.pets }) : null;
  const guests = `${filters.adults} adult${filters.adults === 1 ? '' : 's'}${filters.children.length ? `, ${filters.children.length} child${filters.children.length === 1 ? '' : 'ren'}` : ''}`;
  const cards = [];
  for (const row of candidates) {
    const offer = offers?.get(row.id) ?? null;
    if (dated && !offer) continue;
    const price = offer ? offer.totalMinor / 100 : Number(row.from_minor) / 100;
    const perNight = offer ? price / offer.nights : price;
    if (filters.min != null && perNight < filters.min || filters.max != null && perNight > filters.max) continue;
    const photos = normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME, title: row.title, place: `${row.area_name}, ${row.city_name}` });
    const query = stay ? `?${new URLSearchParams({ checkin: stay.checkIn, checkout: stay.checkOut, adults: String(stay.adults), ...(stay.childAges.length ? { children: stay.childAges.join(',') } : {}), ...(filters.pets ? { pets: String(filters.pets) } : {}) })}` : '';
    cards.push({
      id: row.id, vertical: STAY_VERTICAL, rentalUnit: 'unit_night', href: `${listingPath(row.slug, row.public_code)}${query}`, selection: stay,
      title: row.title, area: `${row.area_name}, ${row.city_name}`, highlight: row.highlight, categoryName: row.category_name,
      bedrooms: row.bedrooms, maxOccupants: row.max_occupants, distanceKm: row.distance_km, landmark: landmark ? landmark.name : null,
      location: parsePoint(row.centre),
      offer: offer ? { nights: offer.nights, cleaningMinor: offer.cleaningMinor, petMinor: offer.petMinor, feeMinor: offer.feeMinor } : null,
      price, priceMinor: offer?.totalMinor ?? null, isFromPrice: !offer,
      unit: offer ? `${offer.nights} night${offer.nights === 1 ? '' : 's'}, whole apartment, ${guests}` : 'night',
      priceNote: offer ? `Total for your stay${offer.cleaningMinor ? ', cleaning' : ''}${offer.petMinor ? ', pet fee' : ''} and service fee included. Availability can change.`
        : `Whole apartment per night${Number(row.cleaning_fee_minor) ? ', plus a one-off cleaning fee' : ''}. Add dates for the total.`,
      rating: row.rating_avg == null ? null : Number(row.rating_avg), reviewCount: Number(row.review_count), badge: row.physically_verified ? 'verified' : null,
      photos, photo: photos[0] ?? null, photoCount: photos.length, createdAt: new Date(row.created_at).toISOString(),
    });
  }
  return cards;
}

/** Undated landing pages need enough live places before they are indexable. */
/**
 * Every landing route (city × category or vertical × area or intent) with at
 * least 3 live listings, for the sitemap. One read, counted in memory with the
 * same rules as countDiscoveryRoute: asking per route was 1,500+ requests.
 */
export async function getLandingRoutes(database = sql) {
  const registry = await getDiscoveryRegistry(database);
  const rows = await database`SELECT r.city_id,r.area_id,r.category_id,r.rental_unit::text AS unit,cat.vertical_code AS vertical,
      COALESCE((SELECT array_agg(ra.category_id::text) FROM rentable_resource_activity ra WHERE ra.rentable_id=r.id), '{}') AS activities,
      COALESCE((SELECT array_agg(am.slug) FROM rentable_amenity ram JOIN amenity am ON am.id=ram.amenity_id WHERE ram.rentable_id=r.id AND am.is_active=true), '{}') AS amenities,
      (SELECT hp.policies FROM hotel_profile hp WHERE hp.rentable_id=r.id) AS policies, r.location
    FROM rentable r
    JOIN city c ON c.id=r.city_id JOIN area a ON a.id=r.area_id JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    JOIN vertical v ON v.code=cat.vertical_code AND v.status='public'
    WHERE r.status='live' AND c.is_active=true AND a.is_active=true AND cat.is_active=true AND u.role='client' AND u.account_status='active'`;
  const scopes = [
    ...registry.categories.map((row) => row.slug),
    ...registry.verticals.map((row) => row.slug).filter((slug) => !registry.categories.some((row) => row.slug === slug)),
  ];
  const routes = [];
  for (const city of registry.cities) {
    const inCity = rows.filter((row) => row.city_id === city.id);
    if (inCity.length < 3) continue;
    for (const scope of scopes) {
      const base = [city.slug, scope];
      for (const parts of [
        base,
        ...registry.areas.filter((a) => a.cityId === city.id).map((a) => [...base, 'area', a.slug]),
        ...DISCOVERY_INTENTS.map((i) => [...base, 'intent', i.slug]),
      ]) {
        const route = resolveDiscoveryRoute(registry, parts);
        if (!route) continue;
        const vertical = route.verticalCode ?? DEFAULT_VERTICAL;
        const count = inCity.filter((row) => row.vertical === vertical
          && (!route.category || row.category_id === route.category.id || (row.unit === 'hour' && row.activities.includes(route.category.id)))
          && (!route.area || row.area_id === route.area.id)
          && (!route.intent?.amenity || row.amenities.includes(route.intent.amenity))
          && (!route.intent?.policy || row.policies?.[route.intent.policy] === true)).length;
        if (count >= 3) routes.push({ path: route.path, count });
      }
    }
  }
  // Landmark pages (/hotels/near/{slug}): hotels within NEAR_KM, same 3-place floor.
  for (const landmark of registry.landmarks ?? []) {
    const count = rows.filter((row) => row.vertical === STAY_VERTICAL && row.city_id === landmark.cityId && parsePoint(row.location)
      && distanceKm(parsePoint(row.location), landmark) <= NEAR_KM).length;
    if (count >= 3) routes.push({ path: `/hotels/near/${landmark.slug}`, count });
  }
  return routes;
}

export async function countDiscoveryRoute(route, database = sql) {
  const vertical = route.verticalCode ?? DEFAULT_VERTICAL;
  const [row] = await database`SELECT count(*)::int AS n FROM rentable r
    JOIN city c ON c.id=r.city_id JOIN area a ON a.id=r.area_id JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    JOIN vertical v ON v.code=cat.vertical_code AND v.status='public' AND v.code=${vertical}
    WHERE r.status='live' AND c.is_active=true AND a.is_active=true AND cat.is_active=true AND u.role='client' AND u.account_status='active'
    AND r.city_id=${route.city.id} AND (${!route.category} OR r.category_id=${route.category?.id ?? null}::uuid
      OR (r.rental_unit::text='hour' AND EXISTS (SELECT 1 FROM rentable_resource_activity ra WHERE ra.rentable_id=r.id AND ra.category_id=${route.category?.id ?? null}::uuid)))
    AND (${!route.area} OR r.area_id=${route.area?.id ?? null}::uuid)
    AND (${!route.intent?.amenity} OR EXISTS (SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id WHERE ra.rentable_id=r.id AND am.is_active=true AND am.slug=${route.intent?.amenity ?? ''}))
    AND (${!route.intent?.policy} OR EXISTS (SELECT 1 FROM hotel_profile hp WHERE hp.rentable_id=r.id AND hp.policies->>${route.intent?.policy ?? 'couples'}='true'))`;
  return row.n;
}

/**
 * "Where" autocomplete (hotel plan §4.4): cities, areas and landmarks from the
 * cached registry, hotels by name from one indexed-prefix read. Places first,
 * so a guest typing "Sur" sees Surat before a hotel called "Surya".
 */
export async function suggestDestinations(q, vertical = STAY_VERTICAL, database = sql) {
  const registry = await getDiscoveryRegistry(database);
  const text = String(q ?? '').trim().toLowerCase().slice(0, 60);
  if (text.length < 2 || !registry.verticals.some(r => r.code === vertical)) return { cities: [], areas: [], landmarks: [], hotels: [] };
  const hit = (name) => name.toLowerCase().split(/[\s,()-]+/).some(word => word.startsWith(text)) || name.toLowerCase().startsWith(text);
  const cityOf = new Map(registry.cities.map(c => [c.id, c]));
  const term = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
  const hotels = await database`SELECT r.slug,r.public_code,r.title,a.name AS area_name,c.name AS city_name
    FROM rentable r JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    JOIN vertical v ON v.code=cat.vertical_code AND ${visibleVertical(database)} AND v.code=${vertical}
    WHERE r.status='live' AND u.role='client' AND u.account_status='active' AND c.is_active AND a.is_active AND cat.is_active AND r.title ILIKE ${term}
    ORDER BY r.review_count DESC, r.title LIMIT 5`;
  return {
    cities: registry.cities.filter(c => hit(c.name)).slice(0, 5).map(c => ({ slug: c.slug, name: c.name })),
    areas: registry.areas.filter(a => hit(a.name) && cityOf.has(a.cityId)).slice(0, 5)
      .map(a => ({ slug: a.slug, name: a.name, city: cityOf.get(a.cityId).slug, cityName: cityOf.get(a.cityId).name })),
    landmarks: (registry.landmarks ?? []).filter(l => hit(l.name) && cityOf.has(l.cityId)).slice(0, 5)
      .map(l => ({ slug: l.slug, name: l.name, kind: l.kind, city: cityOf.get(l.cityId).slug, cityName: cityOf.get(l.cityId).name })),
    hotels: hotels.map(h => ({ name: h.title, place: `${h.area_name}, ${h.city_name}`, href: listingPath(h.slug, h.public_code) })),
  };
}
