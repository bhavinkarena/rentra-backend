import { Router } from 'express';
import * as application from '@/controllers/application.controller.js';
import * as documents from '@/controllers/documents.controller.js';
import * as listings from '@/controllers/listings.controller.js';
import * as settings from '@/controllers/settings.controller.js';
import * as booking from '@/controllers/booking.controller.js';
import * as records from '@/controllers/records.controller.js';
import * as reviews from '@/controllers/reviews.controller.js';
import { requireRole, requireActiveClient } from '@/middlewares/auth.middleware.js';
import { uploadLimiter } from '@/middlewares/rateLimit.middleware.js';
import { formFields, manyFiles, singleFile, fileFields } from '@/middlewares/upload.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { listingIdParam, listingsPageQuery } from '@/validations/listings.validation.js';
import { recordIdParam, historyQuery } from '@/validations/records.validation.js';

/**
 * Everything a property owner does.
 *
 * Note the two different gates. Onboarding, settings and documents use
 * `requireRole('client')` — a Client who is logged in but not yet approved is
 * still inside the product, working the stepper, and locking them out of the
 * screens that fix their own rejection reason would be a dead end.
 * `requireActiveClient` is Gate 1, and guards publishing and the calendar.
 */
const router = Router();
const client = requireRole('client');

/* ---------------------------------------------------------------- *
 * Onboarding application
 * ---------------------------------------------------------------- */
router.get('/application', client, application.read);
router.post('/application/details', client, formFields(), application.details);
router.post('/application/payout', client, formFields(), application.payout);
router.post('/application/consent', client, formFields(), application.consent);
router.post('/application/submit', client, application.submit);
router.post('/application/withdraw', client, application.withdraw);

/* ---------------------------------------------------------------- *
 * KYC documents
 * ---------------------------------------------------------------- */
router.get('/documents', client, documents.list);
router.post(
  '/documents',
  client,
  uploadLimiter,
  /** An ID document is front and back, under distinct field names. */
  fileFields([
    { name: 'front', maxCount: 1 },
    { name: 'back', maxCount: 1 },
  ]),
  documents.upload,
);
router.delete('/documents', client, formFields(), documents.remove);

/* ---------------------------------------------------------------- *
 * Account settings — reachable before approval, deliberately
 * ---------------------------------------------------------------- */
router.post('/settings/account', client, formFields(), settings.account);
router.post('/settings/payout', client, formFields(), settings.payout);

/* ---------------------------------------------------------------- *
 * Wizard reference data
 * ---------------------------------------------------------------- */
router.get('/catalogue/amenities', client, listings.amenities);
router.get('/catalogue/categories', client, listings.categories);
router.get('/catalogue/places', client, listings.places);

/* ---------------------------------------------------------------- *
 * Listings
 * ---------------------------------------------------------------- */
router.get('/listings/summary', client, listings.summary);
router.get('/listings', client, validate({ query: listingsPageQuery }), listings.page);
router.post('/listings', client, formFields(), listings.create);
router.get('/listings/:id', client, validate({ params: listingIdParam }), listings.detail);

/** One route per wizard step: each step saves independently. */
for (const [step, handler] of [
  ['basics', listings.basics],
  ['location', listings.location],
  ['capacity', listings.capacity],
  ['amenities', listings.amenitiesStep],
  ['rules', listings.rules],
  ['pricing', listings.pricing],
  ['terms', listings.terms],
]) {
  router.post(
    `/listings/:id/${step}`,
    client,
    validate({ params: listingIdParam }),
    formFields(),
    handler,
  );
}

router.post('/listings/:id/photos', client, uploadLimiter, manyFiles('photos'), listings.addPhotos);
router.delete('/listings/:id/photos', client, formFields(), listings.removePhoto);
router.patch('/listings/:id/photos/order', client, formFields(), listings.reorderPhotos);
router.post(
  '/listings/:id/ownership-document',
  client,
  uploadLimiter,
  singleFile('file'),
  listings.ownershipDocument,
);
router.post('/listings/:id/submit', client, formFields(), listings.submit);
router.post('/listings/:id/pause', requireActiveClient, formFields(), listings.togglePause);

/* ---------------------------------------------------------------- *
 * Booking calendar — Gate 1
 * ---------------------------------------------------------------- */
router.get(
  '/listings/:id/calendar',
  requireActiveClient,
  validate({ params: listingIdParam }),
  booking.calendarPage,
);
router.get(
  '/listings/:id/calendar/state',
  requireActiveClient,
  validate({ params: listingIdParam }),
  booking.calendarState,
);
router.post('/listings/:id/calendar/schedule', requireActiveClient, formFields(), booking.schedule);
router.post(
  '/listings/:id/calendar/price-override',
  requireActiveClient,
  formFields(),
  booking.priceOverride,
);
router.post(
  '/listings/:id/calendar/open-dates',
  requireActiveClient,
  formFields(),
  booking.openDates,
);
router.post('/listings/:id/calendar/block', requireActiveClient, formFields(), booking.block);
router.post('/listings/:id/calendar/unblock', requireActiveClient, formFields(), booking.unblock);

/* ---------------------------------------------------------------- *
 * Bookings against the owner's places
 * ---------------------------------------------------------------- */
router.get('/records', requireActiveClient, validate({ query: historyQuery }), records.history);
router.get(
  '/records/:id',
  requireActiveClient,
  validate({ params: recordIdParam }),
  records.detail,
);
router.get(
  '/records/:id/summary',
  requireActiveClient,
  validate({ params: recordIdParam }),
  records.summary,
);
router.post('/records/visit', requireActiveClient, formFields(), records.ownerTransition);

/* ---------------------------------------------------------------- *
 * Reviews on the owner's places
 * ---------------------------------------------------------------- */
router.get('/reviews', requireActiveClient, reviews.queue);
router.post('/reviews/reply', requireActiveClient, formFields(), reviews.reply);
router.post('/reviews/report', requireActiveClient, formFields(), reviews.reportByOwner);

export default router;
