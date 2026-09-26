import { Router } from 'express';
import * as admin from '@/controllers/admin.controller.js';
import * as clients from '@/controllers/clients.controller.js';
import * as propertyReviews from '@/controllers/propertyReviews.controller.js';
import { listingQueueQuery } from '@/services/admin/listings.js';
import { z } from 'zod';
import { uuid } from '@/validations/common.validation.js';

const visitParams = z.object({ id: uuid, visitId: uuid });
import * as customers from '@/controllers/customers.controller.js';
import * as payments from '@/controllers/payments.controller.js';
import * as records from '@/controllers/records.controller.js';
import * as reviews from '@/controllers/reviews.controller.js';
import * as support from '@/controllers/support.controller.js';
import * as notifications from '@/controllers/notifications.controller.js';
import { requireAdmin, requirePortalCapability } from '@/middlewares/auth.middleware.js';
import { formFields, evidencePhotos } from '@/middlewares/upload.middleware.js';
import { uploadLimiter } from '@/middlewares/rateLimit.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import {
  applicationIdParam,
  userIdParam,
  documentIdParam,
  decisionsQuery,
  clientIdParam,
  lifecyclePreviewQuery,
} from '@/validations/admin.validation.js';
import { clientListQuery } from '@/services/admin/clients.js';
import { customerListQuery } from '@/services/admin/customers.js';
import { applicationQueueQuery } from '@/services/admin/applications.js';
import {
  recordIdParam,
  recordAttachmentParams,
  operationalHistoryQuery,
} from '@/validations/records.validation.js';
import { supportIdParam, supportListQuery } from '@/validations/support.validation.js';

/**
 * Super Admin. Every route below the mount point requires the separate admin
 * cookie — a client or customer session is never accepted here, not even for
 * a read, because role confusion on the account that releases payouts is not
 * a bug worth risking.
 */
const router = Router();
router.use(requireAdmin);
router.use(requirePortalCapability('admin'));

/** Nothing under /admin should ever be cached or indexed. */
router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* ---------------------------------------------------------------- *
 * Partner approval queue
 * ---------------------------------------------------------------- */
router.get('/applications', validate({ query: applicationQueueQuery }), admin.queue);
router.get('/properties', validate({ query: listingQueueQuery }), propertyReviews.list);
router.get('/properties/:id', validate({ params: clientIdParam }), propertyReviews.detail);
router.post(
  '/properties/:id/assign',
  validate({ params: clientIdParam }),
  formFields(),
  propertyReviews.assign,
);
router.post(
  '/properties/:id/decision',
  validate({ params: clientIdParam }),
  formFields(),
  propertyReviews.decide,
);
// Verification and publication (CP07): every command re-checks the reviewed revision.
router.post(
  '/properties/:id/verifications',
  validate({ params: clientIdParam }),
  formFields(),
  propertyReviews.schedule,
);
for (const [path, handler] of [
  ['reschedule', propertyReviews.reschedule],
  ['cancel', propertyReviews.cancel],
  ['outcome', propertyReviews.outcome],
]) {
  router.post(
    `/properties/:id/verifications/:visitId/${path}`,
    validate({ params: visitParams }),
    formFields(),
    handler,
  );
}
router.post(
  '/properties/:id/publish',
  validate({ params: clientIdParam }),
  formFields(),
  propertyReviews.publish,
);
// Admin restriction and documented corrections (CP08): version-guarded, audited.
for (const [path, handler] of [
  ['hide', propertyReviews.hide],
  ['restore', propertyReviews.restore],
  ['correction', propertyReviews.correct],
]) {
  router.post(
    `/properties/:id/${path}`,
    validate({ params: clientIdParam }),
    formFields(),
    handler,
  );
}
router.get('/applications/stats', admin.stats);
router.get('/applications/decisions', validate({ query: decisionsQuery }), admin.decisions);
router.get('/applications/:id', validate({ params: applicationIdParam }), admin.application);
router.post(
  '/applications/:id/assign',
  validate({ params: applicationIdParam }),
  formFields(),
  admin.assign,
);
router.post('/applications/approve', formFields(), admin.approve);
router.post('/applications/more-info', formFields(), admin.moreInfo);
router.post('/applications/reject', formFields(), admin.reject);

/* ---------------------------------------------------------------- *
 * Client directory and lifecycle (CP03). Suspend/reinstate require the
 * reviewed lifecycle version; stale or invalid transitions answer 409.
 * ---------------------------------------------------------------- */
router.get('/clients', validate({ query: clientListQuery }), clients.list);
router.get('/clients/:id', validate({ params: clientIdParam }), clients.detail);
router.get(
  '/clients/:id/lifecycle-preview',
  validate({ params: clientIdParam, query: lifecyclePreviewQuery }),
  clients.preview,
);
router.post(
  '/clients/:id/suspend',
  validate({ params: clientIdParam }),
  formFields(),
  clients.suspend,
);
router.post(
  '/clients/:id/reinstate',
  validate({ params: clientIdParam }),
  formFields(),
  clients.reinstate,
);

/* ---------------------------------------------------------------- *
 * Customer directory and account controls (CP04). Every command takes a
 * reason and the reviewed `expectedVersion`; stale commands answer 409.
 * ---------------------------------------------------------------- */
router.get('/customers', validate({ query: customerListQuery }), customers.list);
router.get('/customers/:id', validate({ params: clientIdParam }), customers.detail);
router.post(
  '/customers/:id/restrict',
  validate({ params: clientIdParam }),
  formFields(),
  customers.restrict,
);
router.post(
  '/customers/:id/reinstate',
  validate({ params: clientIdParam }),
  formFields(),
  customers.reinstate,
);
router.post(
  '/customers/:id/sessions/revoke',
  validate({ params: clientIdParam }),
  formFields(),
  customers.revokeSessions,
);
router.post(
  '/customers/:id/profile',
  validate({ params: clientIdParam }),
  formFields(),
  customers.correctProfile,
);

/* ---------------------------------------------------------------- *
 * KYC review
 * ---------------------------------------------------------------- */
router.get('/users/:userId/documents', validate({ params: userIdParam }), admin.documents);
router.get('/documents/:id/file', validate({ params: documentIdParam }), admin.documentFile);
router.post('/documents/review', formFields(), admin.decideDocument);

/* ---------------------------------------------------------------- *
 * Payments configuration
 * ---------------------------------------------------------------- */
router.get('/payments/configuration', payments.configuration);
router.post('/payments/configuration', formFields(), payments.saveConfiguration);

/* ---------------------------------------------------------------- *
 * Bookings, reviews, support, notifications — the admin view of each
 * ---------------------------------------------------------------- */
router.get('/records', validate({ query: operationalHistoryQuery }), records.history);
router.get('/records/:id', validate({ params: recordIdParam }), records.detail);
router.get('/records/:id/summary', validate({ params: recordIdParam }), records.summary);
router.get(
  '/records/:id/attachments/:attachmentId',
  validate({ params: recordAttachmentParams }),
  records.attachment,
);
router.post('/records/visit', uploadLimiter, evidencePhotos(), records.adminTransition);
router.post('/records/incident', uploadLimiter, evidencePhotos(), records.adminIncident);
router.post('/records/incident/close', formFields(), records.closeIncident);
router.post('/records/evidence/correct', formFields(), records.correctEvidence);

router.get('/reviews', reviews.queue);
router.post('/reviews/moderate', formFields(), reviews.moderate);
router.post('/reviews/reports/resolve', formFields(), reviews.resolveReport);

router.get('/support', validate({ query: supportListQuery }), support.list);
router.get('/support/:id', validate({ params: supportIdParam }), support.detail);
router.get('/support/:id/thread', validate({ params: supportIdParam }), support.thread);
router.post('/support/:id/reply', formFields(), support.replyAsAdmin);

router.get('/notifications', notifications.monitor);
router.post('/notifications/manage', formFields(), notifications.manage);

/* ---------------------------------------------------------------- *
 * Privacy queue and operations
 * ---------------------------------------------------------------- */
router.get('/privacy', admin.privacyQueue);
router.post('/privacy/review', formFields(), admin.startPrivacy);

router.get('/operations', admin.operations);

export default router;
