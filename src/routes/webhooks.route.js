import { Router } from 'express';
import * as webhooks from '@/controllers/webhooks.controller.js';
import { rawBody } from '@/middlewares/rawBody.middleware.js';

/**
 * External callers only. Mounted before the JSON body parser so the signature
 * can be checked against the exact bytes Razorpay sent, and outside the
 * session middleware because there is no cookie to read.
 */
const router = Router();

router.post('/razorpay', rawBody, webhooks.razorpay);

export default router;
