import { Router } from 'express';
import * as account from '@/controllers/account.controller.js';
import * as records from '@/controllers/records.controller.js';
import * as reviews from '@/controllers/reviews.controller.js';
import * as support from '@/controllers/support.controller.js';
import * as notifications from '@/controllers/notifications.controller.js';
import { requireRole } from '@/middlewares/auth.middleware.js';
import { authLimiter } from '@/middlewares/rateLimit.middleware.js';
import { formFields, singleFile } from '@/middlewares/upload.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { recordIdParam, historyQuery } from '@/validations/records.validation.js';
import { supportIdParam, supportListQuery } from '@/validations/support.validation.js';
import { orderIdParam, reviewIdParam } from '@/validations/common.validation.js';

const router = Router();
const customer = requireRole('customer');

/* ---------------------------------------------------------------- *
 * Account
 * ---------------------------------------------------------------- */
router.get('/account', customer, account.read);
router.get('/account/onboarding', customer, account.onboarding);
router.post('/account/profile', customer, formFields(), account.updateProfile);
router.post('/account/photo', customer, authLimiter, singleFile('photo'), account.updatePhoto);
/** Two steps: the new number proves it can receive a code before it replaces the old one. */
router.post(
  '/account/phone/request',
  customer,
  authLimiter,
  formFields(),
  account.startPhoneChange,
);
router.post(
  '/account/phone/confirm',
  customer,
  authLimiter,
  formFields(),
  account.finishPhoneChange,
);
/** DPDP export or erasure. Queued for an admin, never instant. */
router.post('/account/privacy', customer, formFields(), account.privacyRequest);

/* ---------------------------------------------------------------- *
 * Bookings
 * ---------------------------------------------------------------- */
router.get('/records', customer, validate({ query: historyQuery }), records.history);
router.get('/records/:id', customer, validate({ params: recordIdParam }), records.detail);
router.get('/records/:id/summary', customer, validate({ params: recordIdParam }), records.summary);
router.post('/records/rebook', customer, formFields(), records.rebook);
/** Cancellation is previewed first, always — never cancelled in one call. */
router.post('/records/cancellation/preview', customer, records.previewCancellation);
router.post('/records/cancellation', customer, records.cancel);

/* ---------------------------------------------------------------- *
 * Reviews
 * ---------------------------------------------------------------- */
router.get(
  '/reviews/order/:orderId',
  customer,
  validate({ params: orderIdParam }),
  reviews.forOrder,
);
router.get('/reviews/:reviewId', customer, validate({ params: reviewIdParam }), reviews.detail);
router.post('/reviews', customer, formFields(), reviews.submit);
router.post('/reviews/report', customer, formFields(), reviews.reportByCustomer);

/* ---------------------------------------------------------------- *
 * Support
 * ---------------------------------------------------------------- */
router.get('/support', customer, validate({ query: supportListQuery }), support.list);
router.post('/support', customer, formFields(), support.open);
router.get('/support/:id', customer, validate({ params: supportIdParam }), support.detail);
router.get('/support/:id/thread', customer, validate({ params: supportIdParam }), support.thread);
router.post('/support/:id/reply', customer, formFields(), support.replyAsCustomer);

/* ---------------------------------------------------------------- *
 * Notifications
 * ---------------------------------------------------------------- */
router.get('/notifications', customer, notifications.list);
router.post('/notifications/read', customer, formFields(), notifications.markRead);

export default router;
