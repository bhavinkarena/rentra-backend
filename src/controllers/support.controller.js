import { Readable } from 'node:stream';
import { sql } from '@/config/database.js';
import {
  openSupport,
  replyCustomerSupport,
  replyAdminSupport,
  openOwnerSupport,
  replyOwnerSupport,
  manageSupport,
} from '@/services/support/actions.js';
import {
  listSupportRequests,
  readSupportRequest,
  supportAttachment,
} from '@/services/support/service.js';
import { supportRecordPage } from '@/services/support/page.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { recordKindFromBaseUrl } from '@/services/booking/record-scope.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { badRequest } from '@/utils/apiError.js';

const kindOf = (req) => {
  const kind = recordKindFromBaseUrl(req.baseUrl);
  if (!['admin', 'customer', 'owner'].includes(kind)) {
    throw badRequest('UNKNOWN_ACTOR', 'Unknown support scope.');
  }
  return kind;
};

export const list = asyncHandler(async (req, res) =>
  ok(res, await listSupportRequests(sql, await bookingActor(kindOf(req)), req.query)),
);

export const detail = asyncHandler(async (req, res) =>
  ok(res, await supportRecordPage(kindOf(req), req.params.id)),
);

/** The raw conversation, without the page wrapper. Used for polling a thread. */
export const thread = asyncHandler(async (req, res) =>
  ok(res, await readSupportRequest(sql, await bookingActor(kindOf(req)), req.params.id)),
);

/**
 * Opening a request redirects to the new conversation on success, so this
 * returns `redirect` rather than a body — see runAction.
 */
export const open = runAction(openSupport);
export const replyAsCustomer = runAction(replyCustomerSupport);
export const replyAsAdmin = runAction(replyAdminSupport);

export const openAsOwner = runAction(openOwnerSupport);
export const replyAsOwner = runAction(replyOwnerSupport);
export const manage = runAction(manageSupport);
export const attachment = asyncHandler(async (req, res) => {
  const file = await supportAttachment(
    sql,
    await bookingActor(kindOf(req)),
    req.params.id,
    req.params.attachmentId,
  );
  res.set({
    'Content-Type': file.mimeType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment; filename="support-photo"',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
  });
  return Readable.fromWeb(file.body).pipe(res);
});
