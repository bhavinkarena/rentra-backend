import { sql } from '@/config/database.js';
import {
  openSupport,
  replyCustomerSupport,
  replyAdminSupport,
} from '@/services/support/actions.js';
import { listSupportRequests, readSupportRequest } from '@/services/support/service.js';
import { supportRecordPage } from '@/services/support/page.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

const kindOf = (req) => (req.baseUrl.includes('/admin/') ? 'admin' : 'customer');

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
