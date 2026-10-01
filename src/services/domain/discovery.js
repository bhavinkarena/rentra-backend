import { addLocalDays, consecutiveVisitDates, normalizeVisitDates, propertyToday } from './booking-dates.js';
import { DEFAULT_VERTICAL, VERTICAL_PATTERN } from './verticals.js';

/** Landing titles for a whole vertical in a city, e.g. /surat/entertainment. */
export const VERTICAL_LANDING_TITLES = { farmhouse: 'Farmhouses', entertainment: 'Sports and play venues' };

export const SEARCH_SORTS = { recommended: 'Recommended', price_asc: 'Price: low to high', price_desc: 'Price: high to low', newest: 'Newest' };
export const DISCOVERY_INTENTS = [
  { slug: 'day-picnic', vertical: 'farmhouse', label: 'Day picnic', slot: 'day', description: 'Browse day visits. Select dates to check current hours, capacity and availability.' },
  { slug: 'with-pool', vertical: 'farmhouse', label: 'With pool', amenity: 'swimming_pool', description: 'Places with a swimming pool listed by the owner. Check pool rules on the listing.' },
  { slug: 'bonfire-allowed', vertical: 'farmhouse', label: 'Bonfire allowed', amenity: 'bonfire', description: 'Places with the bonfire amenity. Confirm seasonal restrictions with the owner.' },
  { slug: 'pre-wedding-shoot', vertical: 'farmhouse', label: 'Pre-wedding shoot', amenity: 'open_lawn', description: 'Explore places with open lawns for a possible shoot. Shoot permission and any additional charges require owner confirmation.' },
  { slug: 'corporate-offsite', vertical: 'farmhouse', label: 'Corporate offsite', amenity: 'banquet_lawn', description: 'Explore places with banquet lawns. Confirm event permission, equipment and arrangements with the owner.' },
  { slug: 'night-games', vertical: 'entertainment', label: 'Night games', amenity: 'floodlights', description: 'Venues with floodlights listed by the owner. Check the evening hours on each venue.' },
  { slug: 'air-conditioned', vertical: 'entertainment', label: 'Air-conditioned', amenity: 'air_conditioned', description: 'Indoor venues listed as air-conditioned by the owner.' },
  { slug: 'equipment-on-rent', vertical: 'entertainment', label: 'Equipment on rent', amenity: 'equipment_rental', description: 'Venues that rent out bats, rackets or balls. Charges are set by each venue.' },
];
/** Intents of one vertical; farmhouse unless told otherwise, so older callers keep their five chips. */
export const intentsFor = (vertical = DEFAULT_VERTICAL) => DISCOVERY_INTENTS.filter(row => (row.vertical ?? DEFAULT_VERTICAL) === vertical);
export const validRouteSlug = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
export const areaDiscoveryPath = (city, category, area) => `/${city}/${category}/area/${area}`;
export const intentDiscoveryPath = (city, category, intent) => `/${city}/${category}/intent/${intent}`;

/**
 * Explicit namespaces make an area named with-pool unambiguous. Legacy paths prefer intents.
 * The second segment is a category (/surat/box-cricket) or, failing that, a public
 * vertical (/surat/entertainment: every activity). A category's vertical comes from
 * the registry; older registries without one mean farmhouse. Intents only exist
 * within their own vertical.
 */
export function resolveDiscoveryRoute(registry, segments) {
  const [citySlug, categorySlug, ...tail] = segments;
  if (!segments.every(validRouteSlug)) return null;
  const city = registry.cities.find(row => row.slug === citySlug);
  const category = registry.categories.find(row => row.slug === categorySlug);
  const vertical = category ? null : (registry.verticals ?? []).find(row => row.slug === categorySlug);
  if (!city || (!category && !vertical) || tail.length > 2) return null;
  const verticalCode = vertical?.code ?? category.vertical ?? DEFAULT_VERTICAL;
  const scope = category ?? { slug: vertical.slug, name: VERTICAL_LANDING_TITLES[vertical.code] ?? vertical.name };
  const base = `/${citySlug}/${categorySlug}`;
  const own = { city, ...(category ? { category } : { vertical }), verticalCode };
  if (!tail.length) return { ...own, path: base, title: `${scope.name} in ${city.name}` };
  const intentSlug = tail.length === 1 ? tail[0] : tail[0] === 'intent' ? tail[1] : null;
  const intent = DISCOVERY_INTENTS.find(row => row.slug === intentSlug && (row.vertical ?? DEFAULT_VERTICAL) === verticalCode);
  if (intent) return { ...own, intent, path: intentDiscoveryPath(citySlug, categorySlug, intent.slug), title: `${intent.label} · ${scope.name} in ${city.name}` };
  if (tail.length === 2 && tail[0] !== 'area') return null;
  const areaSlug = tail.at(-1);
  const area = registry.areas.find(row => row.cityId === city.id && row.slug === areaSlug);
  return area ? { ...own, area, path: areaDiscoveryPath(citySlug, categorySlug, area.slug), title: `${scope.name} in ${area.name}, ${city.name}` } : null;
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
    vertical: value('vertical') || DEFAULT_VERTICAL,
    start: '', duration: null, players: null, indoor: null,
  };
  if (!VERTICAL_PATTERN.test(filters.vertical)) { errors.push('Choose a supported vertical.'); filters.vertical = DEFAULT_VERTICAL; }
  const timeBooked = filters.vertical !== DEFAULT_VERTICAL;
  if (timeBooked) {
    // Time-booked search: one date, an optional earliest start, a duration and players.
    // Farmhouse-only parameters (slot, mode, several dates) are ignored, not rejected,
    // so a link shared from the other tab still opens.
    const start = value('start');
    if (start && !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) errors.push('Choose a start time as HH:mm.');
    else filters.start = start;
    filters.duration = number('duration', null, 30, 720);
    filters.players = number('players', null, 1, 500);
    const indoor = value('indoor');
    if (indoor && !['true', 'false'].includes(indoor)) errors.push('Choose indoor or outdoor.');
    filters.indoor = indoor === 'true' ? true : indoor === 'false' ? false : null;
    filters.slot = '';
    filters.mode = 'single';
    filters.guests = filters.players ?? 1;
  }
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
  if (timeBooked) {
    const day = date || (dates ? dates.split(',')[0] : '');
    try {
      if (day) filters.dates = normalizeVisitDates([day]);
      if (filters.dates.some(d => d < today || d > addLocalDays(today, 365))) errors.push('Choose a date within the next 365 days.');
    } catch { errors.push('Choose a valid date.'); }
  } else try {
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
  const timeBooked = values.vertical && values.vertical !== DEFAULT_VERTICAL;
  if (timeBooked) params.set('vertical', values.vertical);
  const keys = timeBooked
    ? ['q', 'city', 'area', 'category', 'date', 'start', 'duration', 'players', 'indoor', 'min', 'max', 'cancellation', 'sort', 'page', 'amenities']
    : ['q', 'city', 'area', 'category', 'mode', 'slot', 'guests', 'min', 'max', 'cancellation', 'sort', 'page', 'dates', 'amenities'];
  if (timeBooked && values.dates?.length && values.date == null) values.date = values.dates[0];
  for (const key of keys) {
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
