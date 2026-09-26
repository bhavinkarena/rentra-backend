import { sql } from '@/config/database.js';
import {
  listPropertyReviews,
  readPropertyReview,
  assignPropertyReview,
  decidePropertyReview,
} from '@/services/admin/listings.js';
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
