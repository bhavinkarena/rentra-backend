import 'server-only';
import { sql } from './index.js';
import { previewBookingQuote } from '../booking/quotes.js';
import { listingPath } from '../domain/listing-url.js';
import { savedListingHref } from '../domain/saved-places.js';
import { validRouteSlug, sortDiscoveryCards } from '../domain/discovery.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';

export async function getDiscoveryRegistry(database = sql) {
  const [cities, areas, categories, amenities] = await Promise.all([
    database`SELECT id,slug,name FROM city WHERE is_active=true ORDER BY name,id`,
    database`SELECT a.id,a.city_id AS "cityId",a.slug,a.name FROM area a JOIN city c ON c.id=a.city_id WHERE c.is_active=true ORDER BY a.name,a.id`,
    database`SELECT id,slug,name FROM category WHERE is_active=true ORDER BY name,id`,
    database`SELECT slug,label_en AS name FROM amenity WHERE is_active=true AND is_filterable=true ORDER BY sort_order,slug`,
  ]);
  return { cities: cities.filter(r => validRouteSlug(r.slug)), areas: areas.filter(r => validRouteSlug(r.slug)), categories: categories.filter(r => validRouteSlug(r.slug)), amenities };
}

const unavailable = new Set(['INVENTORY_NOT_READY', 'INVENTORY_REMEDIATION_REQUIRED', 'SCHEDULE_UNAVAILABLE', 'LISTING_UNAVAILABLE', 'UNSUPPORTED_INVENTORY', 'SLOT_UNAVAILABLE', 'CAPACITY_EXCEEDED', 'AVAILABILITY_CONFLICT', 'NOT_FOUND']);

/** Filter every candidate before global sorting/pagination; never paginate before availability. */
export async function searchDiscovery(filters, route = null, database = sql, registry = null) {
  registry ??= await getDiscoveryRegistry(database);
  const city = route?.city?.slug || filters.city;
  const category = route?.category?.slug || filters.category;
  const area = route?.area?.slug || filters.area;
  const errors = [];
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
  // Escape SQL LIKE wildcards so a location term is literal user text.
  const term = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
  let cursor = '00000000-0000-0000-0000-000000000000';
  const cards = [];
  while (true) {
    const rows = await database`
      SELECT r.id,r.slug,r.public_code,r.title,r.capacity,r.bedrooms,r.highlight,r.photos,r.created_at,
        (r.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM verification_visit vv WHERE vv.rentable_id=r.id AND vv.mode='physical' AND vv.outcome='passed' AND vv.completed_at IS NOT NULL)) AS physically_verified,
        a.name AS area_name,c.name AS city_name,p.weekday,p.weekend
      FROM rentable r JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id
      JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
      LEFT JOIN rentable_price p ON p.rentable_id=r.id AND p.slot=${filters.slot}
      WHERE r.status='live' AND u.role='client' AND u.account_status='active' AND c.is_active=true AND cat.is_active=true
        AND r.id>${cursor}::uuid AND r.capacity>=${filters.guests}
        AND (${!city} OR c.slug=${city}) AND (${!area} OR a.slug=${area}) AND (${!category} OR cat.slug=${category})
        AND (${!filters.q} OR a.name ILIKE ${term} OR c.name ILIKE ${term} OR r.title ILIKE ${term})
        AND (${!filters.cancellation} OR r.cancellation_tier::text=${filters.cancellation})
        AND NOT EXISTS (SELECT 1 FROM unnest(${amenities}::text[]) wanted(slug) WHERE NOT EXISTS (
          SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id
          WHERE ra.rentable_id=r.id AND am.slug=wanted.slug AND am.is_active=true))
      ORDER BY r.id LIMIT 100`;
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = await Promise.all(rows.slice(offset, offset + 4).map(async row => {
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
        const photos = normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME });
        return { id: row.id, href: savedListingHref(listingPath(row.slug, row.public_code), selection), selection,
          title: row.title, area: `${row.area_name}, ${row.city_name}`, capacity: row.capacity, bedrooms: row.bedrooms,
          highlight: row.highlight, price, priceMinor: totals?.totalMinor ?? null, isFromPrice: !totals, unit: totals ? `${filters.dates.length} visit${filters.dates.length === 1 ? '' : 's'}` : filters.slot.replace('_', ' '),
          priceNote: totals ? `Includes platform fee. Refundable deposit ₹${(totals.depositMinor / 100).toLocaleString('en-IN')} separate. Availability can change.` : 'Base rent; guest charges, platform fee and refundable deposit extra. Select dates for a total.',
          rating: null, reviewCount: 0, badge: row.physically_verified ? 'verified' : null, photo: photos[0] ?? null, photoCount: photos.length,
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

/** Undated landing pages need enough live places before they are indexable. */
export async function countDiscoveryRoute(route, database = sql) {
  const [row] = await database`SELECT count(*)::int AS n FROM rentable r
    JOIN city c ON c.id=r.city_id JOIN category cat ON cat.id=r.category_id JOIN "user" u ON u.id=r.client_id
    WHERE r.status='live' AND c.is_active=true AND cat.is_active=true AND u.role='client' AND u.account_status='active'
    AND r.city_id=${route.city.id} AND r.category_id=${route.category.id}
    AND (${!route.area} OR r.area_id=${route.area?.id ?? null}::uuid)
    AND (${!route.intent?.amenity} OR EXISTS (SELECT 1 FROM rentable_amenity ra JOIN amenity am ON am.id=ra.amenity_id WHERE ra.rentable_id=r.id AND am.is_active=true AND am.slug=${route.intent?.amenity ?? ''}))`;
  return row.n;
}
