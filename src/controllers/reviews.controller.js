import { sql } from '@/config/database.js';
import {
  submitCustomerReview,
  moderateCustomerReview,
  ownerReviewReply,
  customerReviewReport,
  ownerReviewReport,
  resolveReviewReport,
} from '@/services/reviews/actions.js';
import { reviewOrder, reviewQueue, publicReview } from '@/services/reviews/service.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { getSession } from '@/services/auth/dal.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** What the guest may review for one order, and what they already wrote. */
export const forOrder = asyncHandler(async (req, res) =>
  ok(res, await reviewOrder(sql, await getSession(), req.params.orderId)),
);

/** One review, for the form that reports it. */
export const detail = asyncHandler(async (req, res) =>
  ok(res, await publicReview(sql, req.params.reviewId)),
);

/** Moderation queue. The actor decides what is visible in it, not the caller. */
export const queue = asyncHandler(async (req, res) => {
  const kind = req.baseUrl.includes('/admin/') ? 'admin' : 'owner';
  return ok(res, await reviewQueue(sql, await bookingActor(kind), Number(req.query.page ?? 1)));
});

export const submit = runAction(submitCustomerReview);
export const moderate = runAction(moderateCustomerReview);
export const reply = runAction(ownerReviewReply);
export const reportByCustomer = runAction(customerReviewReport);
export const reportByOwner = runAction(ownerReviewReport);
export const resolveReport = runAction(resolveReviewReport);
