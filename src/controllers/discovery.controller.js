import { sql } from '@/config/database.js';
import {
  getLiveListings,
  getListingsNearby,
  getListingByCode,
  getListingIdByCode,
  getListingRefByCode,
  getNextAvailableDates,
  getSimilarListings,
  getCities,
  getAreas,
  getSitemapEntries,
  countLiveInArea,
} from '@/services/db/queries.js';
import {
  searchDiscovery,
  countDiscoveryRoute,
  getDiscoveryRegistry,
  getLandingRoutes,
} from '@/services/db/discovery.js';
import { parseDiscoveryQuery, resolveDiscoveryRoute } from '@/services/domain/discovery.js';
import { getBookingAvailability } from '@/services/booking/quotes.js';
import { getHourlyAvailability, getTimeSlots } from '@/services/booking/time-slots.js';
import {
  availabilityQuerySchema,
  hourlyAvailabilityQuerySchema,
  timesQuerySchema,
} from '@/services/schemas/zod/booking';
import { availabilityDateRange } from '@/services/domain/booking-availability.js';
import { BOOKING_POLICY } from '@/services/domain/booking-policy.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok, fail } from '@/utils/respond.js';
import { notFound, badRequest, unavailable, conflict } from '@/utils/apiError.js';

/** Public discovery. No actor, no cookies — safe to cache at the edge. */
export const listings = asyncHandler(async (req, res) =>
  ok(res, await getLiveListings(req.valid?.query ?? req.query)),
);

export const nearby = asyncHandler(async (req, res) =>
  ok(res, await getListingsNearby(req.valid?.query ?? req.query)),
);

/**
 * Search, optionally scoped to a landing route.
 *
 * `parseDiscoveryQuery` is the same normaliser the frontend uses, and it is
 * NOT optional: `searchDiscovery` expects a fully-formed filter object —
 * `amenities` as an array, `guests` and `page` as numbers, `slot` defaulted —
 * and hands you a TypeError rather than a clean error if you pass raw query
 * params. Sharing the parser is also what keeps the two surfaces agreeing on
 * what a filter means.
 *
 * `?path=/surat/farmhouse/intent/with-pool` scopes the search to that landing
 * page. A path that resolves to nothing is a 404 rather than an unscoped
 * search, so a typo does not quietly return the whole catalogue.
 */
export const search = asyncHandler(async (req, res) => {
  const registryData = await getDiscoveryRegistry(sql);
  const route = req.query.path ? resolveRoute(registryData, req.query.path) : null;

  /** `path` selects the landing route above; it is not a search filter. */
  const { path: _path, ...query } = req.query;
  const { filters, errors } = parseDiscoveryQuery({
    ...query,
    ...(route?.intent?.slot && !query.slot ? { slot: route.intent.slot } : {}),
  });

  /** Reject a bad filter before spending a query on it. */
  if (errors.length) {
    return ok(res, { items: [], total: 0, page: 1, totalPages: 1, errors, route });
  }

  const result = await searchDiscovery(filters, route, sql, registryData);
  if (result.code === 'VERTICAL_MISMATCH')
    return fail(res, {
      status: 422,
      code: result.code,
      message: result.errors[0],
      data: { ...result, route, filters },
    });
  return ok(res, { ...result, route, filters });
});

export const registry = asyncHandler(async (_req, res) => ok(res, await getDiscoveryRegistry(sql)));

/**
 * How many live places a landing route has. The SEO layer uses it to decide
 * whether a page is thin enough that it should not be indexed at all.
 */
export const routeCount = asyncHandler(async (req, res) => {
  const route = resolveRoute(await getDiscoveryRegistry(sql), req.query.path);
  return ok(res, { count: await countDiscoveryRoute(route, sql) });
});

/** Resolve a landing path into its city/category/area/intent, or 404. */
function resolveRoute(registryData, path) {
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  const route = segments.length ? resolveDiscoveryRoute(registryData, segments) : null;
  if (!route) throw notFound('ROUTE_NOT_FOUND', 'That page does not exist.');
  return route;
}

export const cities = asyncHandler(async (_req, res) => ok(res, await getCities()));
export const areas = asyncHandler(async (req, res) => ok(res, await getAreas(req.params.citySlug)));
export const sitemap = asyncHandler(async (_req, res) => {
  const [entries, routes] = await Promise.all([getSitemapEntries(), getLandingRoutes(sql)]);
  return ok(res, { ...entries, routes });
});

export const areaCount = asyncHandler(async (req, res) =>
  ok(res, { count: await countLiveInArea(req.params) }),
);

export const detail = asyncHandler(async (req, res) => {
  const listing = await getListingByCode(req.params.code);
  if (!listing) throw notFound('LISTING_NOT_FOUND', 'That place is not available.');
  return ok(res, listing);
});

export const similar = asyncHandler(async (req, res) =>
  ok(res, await getSimilarListings({ ...req.query, rentableId: req.params.id })),
);

export const nextDates = asyncHandler(async (req, res) => {
  const listingId = await getListingIdByCode(req.params.code);
  if (!listingId) throw notFound('LISTING_NOT_FOUND', 'That place is not available.');
  return ok(res, await getNextAvailableDates({ rentableId: listingId, ...req.query }));
});

/**
 * Live availability for the date picker.
 *
 * The frontend listing page is ISR-cached and must NOT bake a calendar into
 * that cache — a calendar rendered from an hour-old page invites a guest to
 * pick a Saturday that sold twenty minutes ago. So the page renders price and
 * the next bookable dates, and the picker reads this on mount.
 *
 * `no-store` for the same reason.
 */
/** Codes after which a public calendar says "not bookable yet" instead of failing. */
const ADVISORY_CODES = [
  'INVENTORY_NOT_READY',
  'INVENTORY_REMEDIATION_REQUIRED',
  'SCHEDULE_UNAVAILABLE',
  'LISTING_UNAVAILABLE',
  'UNSUPPORTED_INVENTORY',
];
/** Selection problems a guest can fix (wrong activity, too many players, unpriced). */
const TIME_SELECTION_CODES = [
  'ACTIVITY_UNAVAILABLE',
  'CAPACITY_EXCEEDED',
  'PRICE_MISSING',
  'DURATION_INVALID',
];

/**
 * Time-booked venue date strip: GET …/availability?activity=&duration=&from=&days=≤30.
 * Same advisory behaviour as the slot calendar below.
 */
async function hourlyAvailability(req, res, listingId) {
  const parsed = hourlyAvailabilityQuerySchema.safeParse(req.query);
  if (!parsed.success)
    throw badRequest('BAD_DATE_RANGE', 'Choose an activity, a duration and up to 30 days.');
  try {
    return ok(
      res,
      await getHourlyAvailability(sql, {
        rentableId: listingId,
        ...parsed.data,
        durationMinutes: parsed.data.duration,
      }),
    );
  } catch (error) {
    if (TIME_SELECTION_CODES.includes(error.code)) throw conflict(error.code, error.message);
    if (!ADVISORY_CODES.includes(error.code))
      throw unavailable('AVAILABILITY_UNAVAILABLE', 'Availability is temporarily unavailable.');
    return ok(res, {
      timeZone: BOOKING_POLICY.timeZone,
      advisory: true,
      days: {},
      message: 'The venue needs to confirm its booking hours.',
    });
  }
}

/**
 * GET /discovery/listings/:code/times?date=&activity=&duration=&guests= — the
 * start-time grid of a time-booked venue. no-store, like availability.
 */
export const times = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const parsed = timesQuerySchema.safeParse(req.query);
  if (!parsed.success)
    throw badRequest('BAD_TIMES_QUERY', 'Choose a date, an activity and a duration.');
  const ref = await getListingRefByCode(req.params.code);
  if (!ref) throw notFound('LISTING_NOT_FOUND', 'Not found.');
  if (ref.rentalUnit !== 'hour')
    throw badRequest('UNSUPPORTED_INVENTORY', 'This listing is booked by slot.');
  try {
    return ok(
      res,
      await getTimeSlots(sql, {
        rentableId: ref.id,
        ...parsed.data,
        durationMinutes: parsed.data.duration,
      }),
    );
  } catch (error) {
    if (TIME_SELECTION_CODES.includes(error.code)) throw conflict(error.code, error.message);
    if (!ADVISORY_CODES.includes(error.code))
      throw unavailable('AVAILABILITY_UNAVAILABLE', 'Times are temporarily unavailable.');
    return ok(res, {
      date: parsed.data.date,
      timeZone: BOOKING_POLICY.timeZone,
      advisory: true,
      times: [],
      message: 'The venue needs to confirm its booking hours.',
    });
  }
});

export const availability = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ref = await getListingRefByCode(req.params.code);
  if (ref?.rentalUnit === 'hour') return hourlyAvailability(req, res, ref.id);

  const parsed = availabilityQuerySchema.safeParse({
    from: req.query.from ?? undefined,
    days: req.query.days ?? undefined,
    guests: req.query.guests ?? undefined,
  });
  if (!parsed.success) throw badRequest('BAD_DATE_RANGE', 'Bad date range.');

  let range;
  try {
    range = availabilityDateRange(parsed.data);
  } catch {
    throw badRequest('BAD_DATE_RANGE', 'Bad date range.');
  }

  const listingId = await getListingIdByCode(req.params.code);
  /**
   * The same answer for "no such listing" and "not live": an unpublished
   * listing must not be discoverable by probing this endpoint.
   */
  if (!listingId) throw notFound('LISTING_NOT_FOUND', 'Not found.');

  try {
    return ok(
      res,
      await getBookingAvailability(sql, {
        rentableId: listingId,
        ...range,
        guests: parsed.data.guests,
      }),
    );
  } catch (error) {
    /**
     * An owner who has not finished the calendar is not an outage. Answer with
     * an advisory empty calendar so the picker can say so, rather than a 503
     * the guest reads as "the site is broken".
     */
    const advisory = [
      'INVENTORY_NOT_READY',
      'INVENTORY_REMEDIATION_REQUIRED',
      'SCHEDULE_UNAVAILABLE',
      'LISTING_UNAVAILABLE',
      'UNSUPPORTED_INVENTORY',
    ].includes(error.code);

    if (!advisory)
      throw unavailable('AVAILABILITY_UNAVAILABLE', 'Availability is temporarily unavailable.');

    return ok(res, {
      ...range,
      timeZone: BOOKING_POLICY.timeZone,
      advisory: true,
      days: {},
      message: 'The owner needs to confirm the booking calendar.',
    });
  }
});
