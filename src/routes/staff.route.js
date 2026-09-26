import { Router } from 'express';
import * as staff from '@/controllers/staff.controller.js';
import { authLimiter, uploadLimiter } from '@/middlewares/rateLimit.middleware.js';
import { evidencePhotos, formFields } from '@/middlewares/upload.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { recordAttachmentParams, recordIdParam } from '@/validations/records.validation.js';

/**
 * Caretakers (CP16). Separate cookie and audience from owners, customers and
 * admins. Reads need `staff.assigned-visits.read`; recording evidence needs
 * the owner's `staff.assigned-visits.evidence` grant. Nothing here reaches
 * money, pricing, KYC or team administration.
 */
const router = Router();

router.post('/invite', authLimiter, formFields(), staff.invite);
router.post('/join/code', authLimiter, formFields(), staff.joinCode);
router.post('/join', authLimiter, formFields(), staff.join);
router.post('/login/code', authLimiter, formFields(), staff.loginCode);
router.post('/login', authLimiter, formFields(), staff.login);
router.post('/logout', staff.logout);

router.get('/me', staff.requireStaff(), staff.me);
router.get('/visits', staff.requireStaff(), staff.visits);
router.get('/visits/:id', staff.requireStaff(), validate({ params: recordIdParam }), staff.visit);
router.get(
  '/visits/:id/attachments/:attachmentId',
  staff.requireStaff(),
  validate({ params: recordAttachmentParams }),
  staff.attachment,
);
router.post(
  '/visits/transition',
  staff.requireStaff('staff.assigned-visits.evidence'),
  uploadLimiter,
  evidencePhotos(),
  staff.transition,
);

export default router;
