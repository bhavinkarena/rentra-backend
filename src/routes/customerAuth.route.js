import { Router } from 'express';
import * as customerAuth from '@/controllers/customerAuth.controller.js';
import { authLimiter } from '@/middlewares/rateLimit.middleware.js';
import { formFields } from '@/middlewares/upload.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { idParam } from '@/validations/common.validation.js';
import { z } from 'zod';

const router = Router();

/**
 * `begin` stores what the guest was about to book in a short-lived signed
 * cookie before sending them to the OTP screen, so the selection survives the
 * login round trip.
 */
router.post('/begin', customerAuth.begin);
router.post('/otp/request', authLimiter, formFields(), customerAuth.requestOtp);
router.post('/otp/verify', authLimiter, formFields(), customerAuth.verifyOtp);
router.post('/switch', customerAuth.switchRole);
router.post('/logout', customerAuth.signOut);

router.get(
  '/selection/:rentableId',
  validate({ params: z.object({ rentableId: idParam.shape.id }) }),
  customerAuth.restoreSelection,
);

export default router;
