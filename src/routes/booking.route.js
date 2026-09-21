import { Router } from 'express';
import * as booking from '@/controllers/booking.controller.js';
import * as checkout from '@/controllers/checkout.controller.js';
import { requireRole } from '@/middlewares/auth.middleware.js';
import { checkoutLimiter } from '@/middlewares/rateLimit.middleware.js';
import { validate } from '@/middlewares/validate.middleware.js';
import { orderIdParam, uuid } from '@/validations/common.validation.js';
import { z } from 'zod';

/**
 * Quoting is public; holding money is not.
 *
 * A guest has to be able to see a price before they have an account — asking
 * someone to sign in to find out what a weekend costs is how you lose them. So
 * `/quote` takes no session, and everything from `/checkout/hold` onward
 * requires a signed-in customer.
 */
const router = Router();
const customer = requireRole('customer');

router.post('/quote', booking.quote);

router.post('/checkout/hold', customer, checkoutLimiter, checkout.hold);
router.get(
  '/checkout/quote/:quoteId',
  customer,
  validate({ params: z.object({ quoteId: uuid }) }),
  checkout.reviewQuote,
);
router.get('/checkout/recent', customer, checkout.recent);
router.get(
  '/checkout/:orderId',
  customer,
  validate({ params: orderIdParam }),
  checkout.reviewOrder,
);
router.post(
  '/checkout/:orderId/start',
  customer,
  checkoutLimiter,
  validate({ params: orderIdParam }),
  checkout.start,
);
router.post('/checkout/verify', customer, checkout.verify);
router.get(
  '/checkout/:orderId/status',
  customer,
  validate({ params: orderIdParam }),
  checkout.status,
);
/**
 * Reconcile against the gateway when the browser never came back. Not a poll:
 * it asks Razorpay directly, so it is rate limited alongside the other
 * money-moving calls.
 */
router.post(
  '/checkout/:orderId/refresh',
  customer,
  checkoutLimiter,
  validate({ params: orderIdParam }),
  checkout.refresh,
);
router.post(
  '/checkout/:orderId/release',
  customer,
  validate({ params: orderIdParam }),
  checkout.release,
);

export default router;
