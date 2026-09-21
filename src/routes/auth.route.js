import { Router } from 'express';
import * as auth from '@/controllers/auth.controller.js';
import { attachUser, requireRole } from '@/middlewares/auth.middleware.js';
import { authLimiter } from '@/middlewares/rateLimit.middleware.js';
import { formFields } from '@/middlewares/upload.middleware.js';

/**
 * Client (property owner) authentication.
 *
 * `formFields()` accepts a multipart body with no files, so the frontend can
 * post the same FormData it already builds for these forms without having to
 * JSON-encode it first. JSON bodies work on the same routes.
 */
const router = Router();

router.post('/otp/request', authLimiter, formFields(), auth.requestOtp);
router.post('/otp/verify', authLimiter, formFields(), auth.verifyOtp);

router.post(
  '/phone/request',
  authLimiter,
  requireRole('client'),
  formFields(),
  auth.requestPhoneOtp,
);
router.post(
  '/phone/confirm',
  authLimiter,
  requireRole('client'),
  formFields(),
  auth.confirmPhoneOtp,
);

router.post('/logout', auth.signOut);

/** Public: returns `{ user: null }` rather than 401 when signed out. */
router.get('/me', attachUser, auth.me);

router.post('/locked-cta', auth.lockedCta);

export default router;
