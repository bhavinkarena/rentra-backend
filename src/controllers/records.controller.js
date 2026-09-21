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
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { badRequest } from '@/utils/apiError.js';

/**
 * Booking records, viewable by three different kinds of actor.
 *
 * `kind` is taken from the mounted route, never from the request — a customer
 * hitting /records/... is resolved as a customer even if they send
 * `?kind=admin`. `bookingActor` then re-derives the actor from the session and
 * refuses if it does not match, so the route prefix is a convenience and not
 * the security boundary.
 */
const KINDS = ['customer', 'owner', 'admin'];

const kindOf = (req) => {
  const kind = req.baseUrl.includes('/admin/')
    ? 'admin'
    : req.baseUrl.includes('/partner/')
      ? 'owner'
      : 'customer';
  if (!KINDS.includes(kind)) throw badRequest('UNKNOWN_ACTOR', 'Unknown record scope.');
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
  const file = await bookingSummaryResponse(
    kindOf(req),
    req.params.id,
    req.query.calendar === '1',
  );

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
