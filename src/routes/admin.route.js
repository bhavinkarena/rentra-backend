import { Router } from 'express';
import * as admin from '@/controllers/admin.controller.js';
import * as payments from '@/controllers/payments.controller.js';
import * as records from '@/controllers/records.controller.js';
import * as reviews from '@/controllers/reviews.controller.js';
import * as support from '@/controllers/support.controller.js';
import * as notifications from '@/controllers/notifications.controller.js';
import { requireAdmin } from '@/middlewares/auth.middleware.js';
import { formFields } from '@/middlewares/upload.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { applicationIdParam, userIdParam, decisionsQuery } from '@/validations/admin.validation.js';
import { recordIdParam, historyQuery } from '@/validations/records.validation.js';
import { supportIdParam, supportListQuery } from '@/validations/support.validation.js';

/**
 * Super Admin. Every route below the mount point requires the separate admin
 * cookie — a client or customer session is never accepted here, not even for
 * a read, because role confusion on the account that releases payouts is not
 * a bug worth risking.
 */
const router = Router();
router.use(requireAdmin);

/** Nothing under /admin should ever be cached or indexed. */
router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

/* ---------------------------------------------------------------- *
 * Partner approval queue
 * ---------------------------------------------------------------- */
router.get('/applications', admin.queue);
router.get('/applications/stats', admin.stats);
router.get('/applications/decisions', validate({ query: decisionsQuery }), admin.decisions);
router.get('/applications/:id', validate({ params: applicationIdParam }), admin.application);
router.post('/applications/approve', formFields(), admin.approve);
router.post('/applications/more-info', formFields(), admin.moreInfo);
router.post('/applications/reject', formFields(), admin.reject);
router.post('/clients/suspend', formFields(), admin.suspend);

/* ---------------------------------------------------------------- *
 * KYC review
 * ---------------------------------------------------------------- */
router.get('/users/:userId/documents', validate({ params: userIdParam }), admin.documents);
router.post('/documents/review', formFields(), admin.decideDocument);

/* ---------------------------------------------------------------- *
 * Payments configuration
 * ---------------------------------------------------------------- */
router.get('/payments/configuration', payments.configuration);
router.post('/payments/configuration', formFields(), payments.saveConfiguration);

/* ---------------------------------------------------------------- *
 * Bookings, reviews, support, notifications — the admin view of each
 * ---------------------------------------------------------------- */
router.get('/records', validate({ query: historyQuery }), records.history);
router.get('/records/:id', validate({ params: recordIdParam }), records.detail);
router.get('/records/:id/summary', validate({ params: recordIdParam }), records.summary);
router.post('/records/visit', formFields(), records.adminTransition);

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
