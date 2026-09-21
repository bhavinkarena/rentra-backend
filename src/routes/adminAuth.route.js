import { Router } from 'express';
import * as adminAuth from '@/controllers/adminAuth.controller.js';
import { requireAdmin } from '@/middlewares/auth.middleware.js';
import { adminLoginLimiter } from '@/middlewares/rateLimit.middleware.js';
import { formFields } from '@/middlewares/upload.middleware.js';

const router = Router();

/** Tighter limit than the other logins: this account releases payouts. */
router.post('/login', adminLoginLimiter, formFields(), adminAuth.login);
router.post('/logout', adminAuth.logout);
router.get('/me', requireAdmin, adminAuth.me);

export default router;
