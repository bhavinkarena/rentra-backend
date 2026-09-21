import { addLocalDays, consecutiveVisitDates, normalizeVisitDates, propertyToday } from './booking-dates.js';

export const SEARCH_SORTS = { recommended: 'Recommended', price_asc: 'Price: low to high', price_desc: 'Price: high to low', newest: 'Newest' };
export const DISCOVERY_INTENTS = [
  { slug: 'day-picnic', label: 'Day picnic', slot: 'day', description: 'Browse day visits. Select dates to check current hours, capacity and availability.' },
  { slug: 'with-pool', label: 'With pool', amenity: 'swimming_pool', description: 'Places with a swimming pool listed by the owner. Check pool rules on the listing.' },
  { slug: 'bonfire-allowed', label: 'Bonfire allowed', amenity: 'bonfire', description: 'Places with the bonfire amenity. Confirm seasonal restrictions with the owner.' },
  { slug: 'pre-wedding-shoot', label: 'Pre-wedding shoot', amenity: 'open_lawn', description: 'Explore places with open lawns for a possible shoot. Shoot permission and any additional charges require owner confirmation.' },
  { slug: 'corporate-offsite', label: 'Corporate offsite', amenity: 'banquet_lawn', description: 'Explore places with banquet lawns. Confirm event permission, equipment and arrangements with the owner.' },
];
export const validRouteSlug = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
export const areaDiscoveryPath = (city, category, area) => `/${city}/${category}/area/${area}`;
export const intentDiscoveryPath = (city, category, intent) => `/${city}/${category}/intent/${intent}`;

/** Explicit namespaces make an area named with-pool unambiguous. Legacy paths prefer intents. */
export function resolveDiscoveryRoute(registry, segments) {
  const [citySlug, categorySlug, ...tail] = segments;
  if (!segments.every(validRouteSlug)) return null;
  const city = registry.cities.find(row => row.slug === citySlug);
  const category = registry.categories.find(row => row.slug === categorySlug);
  if (!city || !category || tail.length > 2) return null;
  const base = `/${citySlug}/${categorySlug}`;
  if (!tail.length) return { city, category, path: base, title: `${category.name} in ${city.name}` };
  const intentSlug = tail.length === 1 ? tail[0] : tail[0] === 'intent' ? tail[1] : null;
  const intent = DISCOVERY_INTENTS.find(row => row.slug === intentSlug);
  if (intent) return { city, category, intent, path: intentDiscoveryPath(citySlug, categorySlug, intent.slug), title: `${intent.label} · ${category.name} in ${city.name}` };
  if (tail.length === 2 && tail[0] !== 'area') return null;
  const areaSlug = tail.at(-1);
  const area = registry.areas.find(row => row.cityId === city.id && row.slug === areaSlug);
  return area ? { city, category, area, path: areaDiscoveryPath(citySlug, categorySlug, area.slug), title: `${category.name} in ${area.name}, ${city.name}` } : null;
}

export function parseDiscoveryQuery(input = {}, today = propertyToday()) {
  const errors = [];
  const value = key => {
    const raw = input[key];
    if (raw == null || raw === '') return '';
    if (typeof raw !== 'string' || raw.length > 500) { errors.push(`Invalid ${key} filter.`); return ''; }
    return raw.trim();
  };
  const choose = (key, choices, fallback) => {
    const raw = value(key);
    if (raw && !choices.includes(raw)) errors.push(`Choose a supported ${key}.`);
    return choices.includes(raw) ? raw : fallback;
  };
  const number = (key, fallback, min, max) => {
    const raw = value(key);
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) { errors.push(`Choose ${key} between ${min} and ${max}.`); return fallback; }
    return Number(raw);
  };
  const filters = {
    q: value('q'), city: value('city'), area: value('area'), category: value('category'),
    mode: choose('mode', ['single', 'consecutive', 'separate'], 'single'),
    slot: choose('slot', ['day', 'night', 'full_day'], 'night'),
    guests: number('guests', 1, 1, 500), min: number('min', null, 0, 100000000), max: number('max', null, 0, 100000000),
    cancellation: choose('cancellation', ['flexible', 'moderate', 'strict'], ''),
    sort: choose('sort', Object.keys(SEARCH_SORTS), 'recommended'), page: number('page', 1, 1, 1000000),
    amenities: [], dates: [],
  };
  const amenityInput = input.amenities;
  if (filters.q.length > 100) errors.push('Use at most 100 characters for location or place.');
  const amenities = Array.isArray(amenityInput) && amenityInput.length <= 10 && amenityInput.every(v => typeof v === 'string' && v.length <= 80)
    ? amenityInput.join(',') : value('amenities');
  if (amenities) {
    filters.amenities = [...new Set(amenities.split(','))];
    if (filters.amenities.length > 10 || filters.amenities.some(a => !/^[a-z0-9_]{1,80}$/.test(a))) errors.push('Choose at most 10 valid amenities.');
  }
  const dates = value('dates'), date = value('date'), end = value('end');
  if (dates && date) errors.push('Use one date selection.');
  try {
    if (dates) filters.dates = normalizeVisitDates(dates.split(','));
    else if (date) filters.dates = filters.mode === 'consecutive' ? consecutiveVisitDates(date, end || date) : normalizeVisitDates([date]);
    else if (end) errors.push('Choose a start date.');
    if (filters.dates.length > 1 && filters.mode === 'single') {
      if (input.mode === 'single') errors.push('Single mode accepts one visit date.');
      else filters.mode = 'separate';
    }
    if (filters.mode === 'consecutive' && filters.dates.some((d, i) => i && d !== addLocalDays(filters.dates[i - 1], 1))) errors.push('Consecutive mode requires consecutive dates.');
    if (filters.dates.some(d => d < today || d > addLocalDays(today, 365))) errors.push('Choose dates within the next 365 days.');
  } catch { errors.push('Choose 1–10 valid, distinct visit dates.'); }
  if (filters.min != null && filters.max != null && filters.min > filters.max) errors.push('Minimum budget must not exceed maximum budget.');
  for (const key of ['city', 'area', 'category']) if (filters[key] && !validRouteSlug(filters[key])) errors.push(`Choose a valid ${key}.`);
  return { filters, errors };
}

export function discoveryQuery(filters, changes = {}) {
  const values = { ...filters, ...changes };
  const params = new URLSearchParams();
  for (const key of ['q', 'city', 'area', 'category', 'mode', 'slot', 'guests', 'min', 'max', 'cancellation', 'sort', 'page', 'dates', 'amenities']) {
    let value = values[key];
    if (Array.isArray(value)) value = value.join(',');
    if (value !== '' && value != null) params.set(key, String(value));
  }
  return params.toString();
}

export function sortDiscoveryCards(cards, sort) {
  return cards.sort((a, b) => {
    if (sort.startsWith('price_')) {
      if (a.price == null || b.price == null) return (a.price == null) - (b.price == null) || a.id.localeCompare(b.id);
      return (sort === 'price_asc' ? a.price - b.price : b.price - a.price) || a.id.localeCompare(b.id);
    }
    if (sort === 'newest') return String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id);
    return Number(Boolean(b.badge === 'verified')) - Number(Boolean(a.badge === 'verified')) || a.id.localeCompare(b.id);
  });
}
