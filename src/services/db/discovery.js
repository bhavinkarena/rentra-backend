import 'server-only';
import { sql } from './index.js';
import { previewBookingQuote } from '../booking/quotes.js';
import { listingPath } from '../domain/listing-url.js';
import { savedListingHref } from '../domain/saved-places.js';
import { validRouteSlug, sortDiscoveryCards, resolveDiscoveryRoute, DISCOVERY_INTENTS } from '../domain/discovery.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';
import { DEFAULT_VERTICAL } from '../domain/verticals.js';
import { getSearchTimeSlots } from '../booking/time-slots.js';

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
  const cached = registryCache.get(database);
  if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.value;
  const [cities, areas, categories, amenities, verticals] = await Promise.all([
    database`SELECT id,slug,name FROM city WHERE is_active=true ORDER BY sort_order,name,id`,
    database`SELECT a.id,a.city_id AS "cityId",a.slug,a.name FROM area a JOIN city c ON c.id=a.city_id WHERE c.is_active=true AND a.is_active=true ORDER BY a.sort_order,a.name,a.id`,
    database`SELECT c.id,c.slug,c.name,c.vertical_code AS vertical,c.icon_key AS "iconKey",c.default_rental_unit::text AS "rentalUnit"
      FROM category c JOIN vertical v ON v.code=c.vertical_code AND v.status='public'
      WHERE c.is_active=true ORDER BY v.sort_order,c.sort_order,c.name,c.id`,
    database`SELECT a.slug,a.label_en AS name,
        COALESCE(json_agg(av.vertical_code ORDER BY av.vertical_code) FILTER (WHERE av.vertical_code IS NOT NULL), '[]'::json) AS verticals
      FROM amenity a LEFT JOIN amenity_vertical av ON av.amenity_id=a.id
      WHERE a.is_active=true AND a.is_filterable=true GROUP BY a.id ORDER BY a.sort_order,a.slug`,
    database`SELECT code,slug,name,sort_order AS "sortOrder" FROM vertical WHERE status='public' ORDER BY sort_order,code`,
  ]);
  const value = { verticals, cities: cities.filter(r => validRouteSlug(r.slug)), areas: areas.filter(r => validRouteSlug(r.slug)), categories: categories.filter(r => validRouteSlug(r.slug)), amenities };
  registryCache.set(database, { at: Date.now(), value });
  return value;
}

const unavailable = new Set(['INVENTORY_NOT_READY', 'INVENTORY_REMEDIATION_REQUIRED', 'SCHEDULE_UNAVAILABLE', 'LISTING_UNAVAILABLE', 'UNSUPPORTED_INVENTORY', 'SLOT_UNAVAILABLE', 'CAPACITY_EXCEEDED', 'AVAILABILITY_CONFLICT', 'NOT_FOUND']);

/** Filter every candidate before global sorting/pagination; never paginate before availability. */
export async function searchDiscovery(filters, route = null, database = sql, registry = null) {
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
  if (errors.length) return { items: [], total: 0, page: 1, totalPages: 1, errors };
  const amenities = [...new Set([...filters.amenities, ...(route?.intent?.amenity ? [route.intent.amenity] : [])])];
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
          selection = { rentableId: row.id, dates: filters.dates, slot: filters.slot, guests: filters.guests };
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
      COALESCE((SELECT array_agg(am.slug) FROM rentable_amenity ram JOIN amenity am ON am.id=ram.amenity_id WHERE ram.rentable_id=r.id AND am.is_active=true), '{}') AS amenities
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
          && (!route.intent?.amenity || row.amenities.includes(route.intent.amenity))).length;
        if (count >= 3) routes.push({ path: route.path, count });
      }
    }
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
    AND (${!route.intent?.amenity} OR EXISTS (SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id WHERE ra.rentable_id=r.id AND am.is_active=true AND am.slug=${route.intent?.amenity ?? ''}))`;
  return row.n;
}
