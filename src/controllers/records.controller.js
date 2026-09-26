import {
  bookingRecordPage,
  bookingHistoryPage,
  bookingActor,
} from '@/services/booking/record-page.js';
import { bookingSummaryResponse } from '@/services/booking/record-download.js';
import {
  recordOwnerVisit,
  recordAdminVisit,
  bookAgain,
} from '@/services/booking/lifecycle-actions.js';
import {
  previewCustomerCancellation,
  cancelCustomerVisits,
} from '@/services/booking/cancellation-actions.js';
import {
  reportOwnerIncident,
  reportAdminIncident,
  closeAdminIncident,
  correctAdminEvidence,
  visitAttachmentFile,
} from '@/services/booking/evidence-actions.js';
import { Readable } from 'node:stream';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { badRequest, notFound } from '@/utils/apiError.js';
import { recordKindFromBaseUrl } from '@/services/booking/record-scope.js';

/**
 * Booking records, viewable by three different kinds of actor.
 *
 * `kind` is taken from the mounted route, never from the request — a customer
 * hitting /records/... is resolved as a customer even if they send
 * `?kind=admin`. `bookingActor` then re-derives the actor from the session and
 * refuses if it does not match, so the route prefix is a convenience and not
 * the security boundary.
 */
const kindOf = (req) => {
  const kind = recordKindFromBaseUrl(req.baseUrl);
  if (!kind) throw badRequest('UNKNOWN_ACTOR', 'Unknown record scope.');
  return kind;
};

export const history = asyncHandler(async (req, res) =>
  ok(res, await bookingHistoryPage(kindOf(req), req.query)),
);

export const detail = asyncHandler(async (req, res) =>
  ok(res, await bookingRecordPage(kindOf(req), req.params.id)),
);

/**
 * The printable summary. `?calendar=1` returns the .ics calendar variant.
 *
 * This one route answers with bytes, not the JSON envelope: the browser saves
 * it straight to a file, and wrapping a text/calendar body in `{ data: ... }`
 * would hand the user a .ics that no calendar app can read.
 */
export const summary = asyncHandler(async (req, res) => {
  const file = await bookingSummaryResponse(kindOf(req), req.params.id, req.query.calendar === '1');

  res.status(file.status);
  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('X-Content-Type-Options', 'nosniff');
  if (file.filename) {
    res.set('Content-Disposition', `attachment; filename="${file.filename}"`);
  }
  return res.send(file.body);
});

export const actor = asyncHandler(async (req, res) => ok(res, await bookingActor(kindOf(req))));

/** Visit lifecycle — handover and return, recorded by the owner or an admin. */
export const ownerTransition = runAction(recordOwnerVisit);
export const adminTransition = runAction(recordAdminVisit);
export const rebook = runAction(bookAgain);

/** Cancellation: always previewed before it is executed, never in one call. */
export const previewCancellation = runAction(previewCustomerCancellation, { style: 'input' });
export const cancel = runAction(cancelCustomerVisits, { style: 'input' });

/** CP13: incidents, admin closure and admin evidence corrections. */
export const ownerIncident = runAction(reportOwnerIncident);
export const adminIncident = runAction(reportAdminIncident);
export const closeIncident = runAction(closeAdminIncident);
export const correctEvidence = runAction(correctAdminEvidence);

/**
 * One private visit photo. Bytes, not the envelope; a foreign or guessed id is
 * 404 so its existence is not confirmed. The read is audited in the service.
 */
export const attachment = asyncHandler(async (req, res) => {
  const kind = kindOf(req);
  if (kind === 'customer') throw notFound('ATTACHMENT_NOT_FOUND', 'Not found.');
  const file = await visitAttachmentFile(
    kind,
    req.params.id,
    req.params.attachmentId,
    req.ip ?? null,
  );
  if (file.status === 404) throw notFound('ATTACHMENT_NOT_FOUND', 'Not found.');
  if (file.status === 502)
    return res.error(502, 'Photo unavailable.', { code: 'ATTACHMENT_UNAVAILABLE' });
  res.set('Content-Type', file.contentType);
  res.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.set('Content-Disposition', `inline; filename="${file.filename}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return Readable.fromWeb(file.body).pipe(res);
});
