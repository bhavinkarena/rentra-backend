import { sql } from '@/config/database.js';
import {
  getApplicationQueue,
  getQueueStats,
  getApplicationForReview,
  getRecentDecisions,
} from '@/services/db/admin-queries.js';
import {
  approveApplication,
  requestMoreInfo,
  rejectApplication,
  suspendClient,
  reviewDocument,
} from '@/services/auth/admin-actions.js';
import { listDocuments } from '@/services/auth/documents.js';
import { readPrivacyQueue } from '@/services/customer/privacy-admin.js';
import { startPrivacyReview } from '@/services/customer/privacy-actions.js';
import { readOperations } from '@/services/operations/overview.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { notFound } from '@/utils/apiError.js';

/** The partner approval queue and its SLA counters. */
export const queue = asyncHandler(async (_req, res) => ok(res, await getApplicationQueue()));
export const stats = asyncHandler(async (_req, res) => ok(res, await getQueueStats()));
export const decisions = asyncHandler(async (req, res) =>
  ok(res, await getRecentDecisions(Number(req.query.limit ?? 10))),
);

export const application = asyncHandler(async (req, res) => {
  const record = await getApplicationForReview(req.params.id);
  if (!record) throw notFound('APPLICATION_NOT_FOUND', 'No such application.');
  return ok(res, record);
});

/** The applicant's KYC documents, for the review panel. */
export const documents = asyncHandler(async (req, res) =>
  ok(res, await listDocuments({ ownerType: 'user', ownerId: req.params.userId })),
);

/** Decisions. Each one is audited inside the action, with the admin as actor. */
export const approve = runAction(approveApplication);
export const moreInfo = runAction(requestMoreInfo);
export const reject = runAction(rejectApplication);
export const suspend = runAction(suspendClient);
export const decideDocument = runAction(reviewDocument);

/** DPDP request queue. */
export const privacyQueue = asyncHandler(async (req, res) =>
  ok(res, await readPrivacyQueue(sql, req.admin.id, Number(req.query.offset ?? 0))),
);
export const startPrivacy = runAction(startPrivacyReview, { style: 'form' });

/**
 * Operations overview — worker heartbeats, payment configuration, delivery
 * health. 503 rather than 500 when it cannot be assembled: this is the screen
 * an operator opens *because* something is wrong, and it should say so plainly.
 */
export const operations = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return ok(res, await readOperations(sql, req.admin.id));
});
