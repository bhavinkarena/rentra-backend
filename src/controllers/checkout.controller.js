import { sql } from '@/config/database.js';
import {
  holdCustomerCheckout,
  startCustomerTestPayment,
  verifyCustomerTestPayment,
  customerCheckoutStatus,
  refreshCustomerTestPayment,
  releaseCustomerCheckout,
} from '@/services/booking/checkout-actions.js';
import {
  readCheckoutReview,
  readOwnedCheckoutReview,
  recentCustomerCheckouts,
} from '@/services/booking/checkout-review.js';
import { getSession } from '@/services/auth/dal.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Checkout, in the order it actually happens:
 *
 *   hold    → takes the dates out of circulation for a short window
 *   review  → what the guest is about to pay for, re-priced
 *   start   → opens a gateway order against the held quote
 *   verify  → confirms the gateway's signed result
 *   status  → poll, for the tab that came back from the payment page
 *   refresh → reconcile with the gateway when the callback never arrived
 *   release → give the dates back
 *
 * Every one of these re-checks ownership inside the service layer. The hold is
 * the thing that expires, so `status` and `refresh` exist precisely because a
 * browser that closed mid-payment must not silently lose a paid booking.
 */
export const hold = runAction(holdCustomerCheckout, { style: 'input' });
export const start = asyncHandler(async (req, res) =>
  ok(res, await startCustomerTestPayment(req.params.orderId)),
);
export const verify = runAction(verifyCustomerTestPayment, { style: 'input' });
export const status = asyncHandler(async (req, res) =>
  ok(res, await customerCheckoutStatus(req.params.orderId)),
);
export const refresh = asyncHandler(async (req, res) =>
  ok(res, await refreshCustomerTestPayment(req.params.orderId)),
);
export const release = asyncHandler(async (req, res) =>
  ok(res, await releaseCustomerCheckout(req.params.orderId)),
);

export const reviewQuote = asyncHandler(async (req, res) =>
  ok(res, await readCheckoutReview(sql, await getSession(), req.params.quoteId)),
);

export const reviewOrder = asyncHandler(async (req, res) =>
  ok(res, await readOwnedCheckoutReview(sql, await getSession(), req.params.orderId)),
);

export const recent = asyncHandler(async (_req, res) =>
  ok(res, await recentCustomerCheckouts(sql, await getSession())),
);
