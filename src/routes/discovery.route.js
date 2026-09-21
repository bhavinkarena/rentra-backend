import { Router } from 'express';
import * as discovery from '@/controllers/discovery.controller.js';
import { validate } from '@/middlewares/validate.middleware.js';
import {
  codeParam,
  liveListingsQuery,
  nearbyQuery,
  searchQuery,
  routePathQuery,
} from '@/validations/discovery.validation.js';
import { slug, idParam } from '@/validations/common.validation.js';
import { z } from 'zod';

/**
 * Public discovery. No session is read on any of these, which is what makes
 * them safe to cache in front of the API.
 *
 * The one exception in spirit is `availability`, which is explicitly
 * no-store — see the controller for why a cached calendar is worse than none.
 */
const router = Router();

router.get('/listings', validate({ query: liveListingsQuery }), discovery.listings);
router.get('/listings/nearby', validate({ query: nearbyQuery }), discovery.nearby);
router.get('/search', validate({ query: searchQuery }), discovery.search);
router.get('/registry', discovery.registry);
router.get('/route-count', validate({ query: routePathQuery }), discovery.routeCount);

router.get('/cities', discovery.cities);
router.get(
  '/cities/:citySlug/areas',
  validate({ params: z.object({ citySlug: slug }) }),
  discovery.areas,
);
router.get(
  '/cities/:citySlug/areas/:areaSlug/count',
  validate({ params: z.object({ citySlug: slug, areaSlug: slug }) }),
  discovery.areaCount,
);
router.get('/sitemap', discovery.sitemap);

router.get('/listings/:code', validate({ params: codeParam }), discovery.detail);
router.get('/listings/:code/next-dates', validate({ params: codeParam }), discovery.nextDates);
router.get('/listings/:code/availability', validate({ params: codeParam }), discovery.availability);
router.get('/listings/:id/similar', validate({ params: idParam }), discovery.similar);

export default router;
