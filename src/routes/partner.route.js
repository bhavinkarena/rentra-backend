import { z } from 'zod';
import { ownerToday, todaySection } from '@/services/auth/owner-today.js';
import { saveListingHours } from '@/services/booking/calendar-actions.js';
import { runAction } from '@/utils/runAction.js';
import { sql } from '@/services/db';
import * as disputes from '@/controllers/disputes.controller.js';
import * as finance from '@/controllers/finance.controller.js';
import * as support from '@/controllers/support.controller.js';
import { supportListQuery } from '@/validations/support.validation.js';
import { Router } from 'express';
import * as application from '@/controllers/application.controller.js';
import * as documents from '@/controllers/documents.controller.js';
import * as listings from '@/controllers/listings.controller.js';
import * as settings from '@/controllers/settings.controller.js';
import * as booking from '@/controllers/booking.controller.js';
import * as records from '@/controllers/records.controller.js';
import * as reviews from '@/controllers/reviews.controller.js';
import * as updates from '@/controllers/updates.controller.js';
import * as team from '@/controllers/team.controller.js';
import {
  requireRole,
  requireActiveClient,
  requirePortalCapability,
} from '@/middlewares/auth.middleware.js';
import { uploadLimiter } from '@/middlewares/rateLimit.middleware.js';
import {
  formFields,
  manyFiles,
  singleFile,
  fileFields,
  evidencePhotos,
} from '@/middlewares/upload.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { listingIdParam, listingsPageQuery } from '@/validations/listings.validation.js';
import {
  recordIdParam,
  recordAttachmentParams,
  operationalHistoryQuery,
} from '@/validations/records.validation.js';

/**
 * Everything a property owner does.
 *
 * Note the two different gates. Onboarding, settings and documents use
 * `requireRole('client')` — a Client who is logged in but not yet approved is
 * still inside the product, working the stepper, and locking them out of the
 * screens that fix their own rejection reason would be a dead end.
 * `requireActiveClient` is Gate 1, and guards publishing and the calendar.
 */
import { readGuide, saveGuide, setupGuide } from '@/services/auth/owner-guide.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
const router = Router();
const client = requireRole('client');
router.use(requirePortalCapability('client'));

/* ---------------------------------------------------------------- *
 * Onboarding application
 * ---------------------------------------------------------------- */
router.get(
  '/today',
  requireActiveClient,
  validate({ query: z.object({ section: todaySection.optional() }) }),
  asyncHandler(async (req, res) => ok(res, await ownerToday(sql, req.user.id, req.query.section))),
);
router.get(
  '/guide-state',
  client,
  asyncHandler(async (req, res) => ok(res, await readGuide(sql, req.user.id))),
);
router.post(
  '/guide-state',
  client,
  asyncHandler(async (req, res) => ok(res, await saveGuide(sql, req.user.id, req.body))),
);
router.get(
  '/setup-guide',
  requireActiveClient,
  asyncHandler(async (req, res) => ok(res, await setupGuide(sql, req.user.id))),
);

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
router.get('/settings/payout', client, settings.payoutPage);
router.post('/settings/payout', client, formFields(), settings.payout);
router.post('/settings/payout/draft', client, formFields(), settings.payoutDraft);

/* ---------------------------------------------------------------- *
 * Wizard reference data
 * ---------------------------------------------------------------- */
router.get('/catalogue/amenities', client, listings.amenities);
router.get('/catalogue/categories', client, listings.categories);
router.get('/catalogue/verticals', client, listings.verticals);
router.get('/catalogue/places', client, listings.places);

/* ---------------------------------------------------------------- *
 * Listings
 * ---------------------------------------------------------------- */
router.get('/listings/summary', client, listings.summary);
router.get('/listings', client, validate({ query: listingsPageQuery }), listings.page);
router.post('/listings', client, formFields(), listings.create);
router.get('/listings/:id', client, validate({ params: listingIdParam }), listings.detail);
router.get(
  '/listings/:id/overview',
  client,
  validate({ params: listingIdParam }),
  listings.overview,
);

/** One route per wizard step: each step saves independently. */
for (const [step, handler] of [
  ['basics', listings.basics],
  ['type', listings.type],
  ['availability', listings.availability],
  ['location', listings.location],
  ['capacity', listings.capacity],
  ['venue', listings.venue],
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

router.get(
  '/listings/:id/hours',
  client,
  validate({ params: listingIdParam }),
  booking.calendarPage,
);
router.post(
  '/listings/:id/hours',
  client,
  validate({ params: listingIdParam }),
  formFields(),
  (req, res, next) => {
    req.body.rentableId = req.params.id;
    next();
  },
  runAction(saveListingHours),
);
router.get(
  '/listings/:id/preview-data',
  client,
  validate({ params: listingIdParam }),
  listings.previewData,
);
router.post(
  '/listings/:id/price-preview',
  client,
  validate({ params: listingIdParam }),
  formFields(),
  listings.pricePreview,
);
router.delete(
  '/listings/:id',
  client,
  validate({ params: listingIdParam }),
  formFields(),
  listings.removeDraft,
);
router.post(
  '/listings/:id/photos/sign',
  client,
  validate({ params: listingIdParam }),
  formFields(),
  listings.photoSign,
);
router.post(
  '/listings/:id/photos/attach',
  client,
  validate({ params: listingIdParam }),
  formFields(),
  listings.photoAttach,
);
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
router.post(
  '/listings/:id/submit',
  client,
  validate({ params: listingIdParam }),
  formFields(),
  listings.submit,
);
router.post('/listings/:id/pause', requireActiveClient, formFields(), listings.togglePause);

/* ---------------------------------------------------------------- *
 * Booking calendar — Gate 1
 * ---------------------------------------------------------------- */
router.get('/calendar', requireActiveClient, booking.portfolioCalendar);
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
 * Updates inbox and tasks (CP15). Updates also serve clients still in
 * onboarding: their application decisions arrive here.
 * ---------------------------------------------------------------- */
router.get('/updates', client, updates.list);
router.get('/updates/unread', client, updates.unread);
router.get('/nav-counts', client, updates.unread);
router.post('/updates/read', client, formFields(), updates.read);
router.get('/updates/preferences', client, updates.preferences);
router.post('/updates/preferences', client, formFields(), updates.savePreferences);
router.get('/tasks', requireActiveClient, updates.tasks);

/* ---------------------------------------------------------------- *
 * Team: caretakers the owner invites (CP16). Active owners only; the
 * caretaker's own routes live under /staff.
 * ---------------------------------------------------------------- */
router.get('/team', requireActiveClient, team.list);
router.post('/team/invite', requireActiveClient, formFields(), team.invite);
router.post('/team/:id/link', requireActiveClient, validate({ params: listingIdParam }), team.link);
router.post(
  '/team/:id/access',
  requireActiveClient,
  validate({ params: listingIdParam }),
  formFields(),
  team.access,
);
router.post(
  '/team/:id/revoke',
  requireActiveClient,
  validate({ params: listingIdParam }),
  formFields(),
  team.revoke,
);

/* ---------------------------------------------------------------- *
 * Bookings against the owner's places
 * ---------------------------------------------------------------- */
router.get(
  '/records',
  requireActiveClient,
  validate({ query: operationalHistoryQuery }),
  records.history,
);
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
router.get(
  '/records/:id/attachments/:attachmentId',
  requireActiveClient,
  validate({ params: recordAttachmentParams }),
  records.attachment,
);
router.post(
  '/records/visit',
  requireActiveClient,
  uploadLimiter,
  evidencePhotos(),
  records.ownerTransition,
);
router.post(
  '/records/incident',
  requireActiveClient,
  uploadLimiter,
  evidencePhotos(),
  records.ownerIncident,
);
router.post('/records/cases', requireActiveClient, formFields(), records.ownerCreateCase);
router.post('/records/cases/update', requireActiveClient, formFields(), records.ownerCaseUpdate);

/* ---------------------------------------------------------------- *
 * Reviews on the owner's places
 * ---------------------------------------------------------------- */
router.get('/reviews/:reviewId', requireActiveClient, reviews.operationalDetail);
router.get('/reviews', requireActiveClient, reviews.queue);
router.post('/reviews/reply', requireActiveClient, formFields(), reviews.reply);
router.post('/reviews/report', requireActiveClient, formFields(), reviews.reportByOwner);

router.get('/support', validate({ query: supportListQuery }), support.list);
router.post('/support', formFields(), support.openAsOwner);
router.get('/support/:id', support.detail);
router.get('/support/:id/thread', support.thread);
router.post(
  '/support/:id/reply',
  uploadLimiter,
  evidencePhotos(),
  (req, res, next) => {
    req.body.id = req.params.id;
    next();
  },
  support.replyAsOwner,
);
router.get('/support/:id/attachments/:attachmentId', support.attachment);
router.use('/finance', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
router.get('/finance/statement.csv', requireActiveClient, finance.csv);
router.get('/finance/allocations/:id', requireActiveClient, finance.allocation);
router.get('/finance/payouts/:id', requireActiveClient, finance.payout);
router.get('/finance/payouts', requireActiveClient, finance.payouts);
router.get('/finance', requireActiveClient, finance.statement);
router.use('/disputes', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
router.get('/disputes/context/:orderId', requireActiveClient, disputes.context);
router.get('/disputes/:id/attachments/:fileId', requireActiveClient, disputes.attachment);
router.get('/disputes/:id', requireActiveClient, disputes.detail);
router.get('/disputes', requireActiveClient, disputes.list);
router.post('/disputes', requireActiveClient, formFields(), disputes.create);
router.post(
  '/disputes/:id/reply',
  requireActiveClient,
  uploadLimiter,
  evidencePhotos(),
  disputes.reply,
);
export default router;
