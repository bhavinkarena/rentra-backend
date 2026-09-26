import { sql } from '@/config/database.js';
import {
  listPropertyReviews,
  readPropertyReview,
  assignPropertyReview,
  decidePropertyReview,
} from '@/services/admin/listings.js';
import {
  cancelVerification,
  publishProperty,
  recordVerificationOutcome,
  rescheduleVerification,
  scheduleVerification,
} from '@/services/admin/verification.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

export const list = asyncHandler(async (req, res) =>
  ok(res, await listPropertyReviews(sql, req.admin.id, req.valid.query)),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await readPropertyReview(sql, req.params.id)),
);
export const assign = asyncHandler(async (req, res) =>
  ok(
    res,
    await assignPropertyReview(sql, {
      id: req.params.id,
      adminId: req.admin.id,
      submissionId: req.body?.submissionId,
      action: req.body?.action,
      ip: req.ip,
    }),
  ),
);
export const decide = asyncHandler(async (req, res) => {
  const flagged = req.body?.flagged;
  return ok(
    res,
    await decidePropertyReview(sql, {
      id: req.params.id,
      adminId: req.admin.id,
      input: {
        ...req.body,
        flagged: flagged == null ? [] : Array.isArray(flagged) ? flagged : [flagged],
      },
      ip: req.ip,
    }),
  );
});

/** Verification and publication (CP07). Capability checks run in the router. */
const verificationCommand = (run) =>
  asyncHandler(async (req, res) =>
    ok(
      res,
      await run(sql, {
        adminId: req.admin.id,
        id: req.params.id,
        visitId: req.params.visitId,
        input: req.body,
        ip: req.ip,
      }),
    ),
  );
export const schedule = verificationCommand(scheduleVerification);
export const reschedule = verificationCommand(rescheduleVerification);
export const cancel = verificationCommand(cancelVerification);
export const outcome = verificationCommand(recordVerificationOutcome);
export const publish = verificationCommand(publishProperty);
