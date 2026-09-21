import { Readable } from 'node:stream';
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
import { profileCompletion } from '@/services/auth/profile.js';
import { readDocumentFile } from '@/services/auth/document-file.js';
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

  /**
   * The completion state is derived, never stored, so it is computed here
   * rather than sent as raw parts for the reviewer's screen to recompute —
   * the queue and the applicant's own stepper must agree on what is done.
   */
  return ok(res, {
    ...record,
    completion: profileCompletion(record.user, record.app, record.documents ?? []),
  });
});

/** The applicant's KYC documents, for the review panel. */
export const documents = asyncHandler(async (req, res) =>
  ok(res, await listDocuments({ ownerType: 'user', ownerId: req.params.userId })),
);

/**
 * One document's bytes, proxied through us. Answers with the file itself, not
 * the JSON envelope — the reviewer's browser renders it inline.
 */
export const documentFile = asyncHandler(async (req, res) => {
  const file = await readDocumentFile(req.admin.id, req.params.id, {
    ip: req.ip ?? null,
  });

  if (file.status === 404) throw notFound('DOCUMENT_NOT_FOUND', 'Not found.');
  if (file.status === 502) {
    return res.error(502, 'Document unavailable.', { code: 'DOCUMENT_UNAVAILABLE' });
  }

  res.set('Content-Type', file.contentType);
  /** Never cached anywhere: not the browser, not a CDN, not a proxy. */
  res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.set('Content-Disposition', `inline; filename="${file.filename}"`);
  /** Belt and braces against this ever being embedded elsewhere. */
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');

  return Readable.fromWeb(file.body).pipe(res);
});

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
