import { sql } from '@/config/database.js';
import { currentAdminSession } from '@/services/auth/admin.js';
import { getSession } from '@/services/auth/dal.js';
import {
  listPrivacyRequests,
  readPrivacyRequest,
  privacyCommand,
  privacyDownload,
} from '@/services/customer/privacy-fulfillment.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
const actor = async (req) => ({
  kind: 'admin',
  id: req.admin.id,
  sessionId: (await currentAdminSession())?.sessionId,
});
export const list = asyncHandler(async (req, res) =>
  ok(res, await listPrivacyRequests(sql, await actor(req), req.query)),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await readPrivacyRequest(sql, await actor(req), req.params.id)),
);
export const command = asyncHandler(async (req, res) =>
  ok(res, await privacyCommand(sql, await actor(req), req.params.id, req.body)),
);
function file(customer, receipt) {
  return asyncHandler(async (req, res) => {
    const bytes = await privacyDownload(
      sql,
      customer ? { kind: 'customer', session: await getSession() } : await actor(req),
      req.params.id,
      receipt,
    );
    res.set('Cache-Control', 'private, no-store').set('Referrer-Policy', 'no-referrer');
    res
      .attachment(`rentra-privacy-${receipt ? 'receipt' : 'data'}.json`)
      .type('application/json')
      .send(bytes);
  });
}
export const adminExport = file(false, false),
  adminReceipt = file(false, true),
  customerExport = file(true, false),
  customerReceipt = file(true, true);
