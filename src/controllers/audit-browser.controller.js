import { sql } from '@/config/database.js';
import { currentAdminSession } from '@/services/auth/admin.js';
import * as service from '@/services/admin/audit-browser.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
const actor = async (req) => ({
  kind: 'admin',
  id: req.admin.id,
  sessionId: (await currentAdminSession())?.sessionId,
});
export const list = asyncHandler(async (req, res) =>
  ok(res, await service.auditList(sql, await actor(req), req.query)),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await service.auditDetail(sql, await actor(req), req.params.id)),
);
export const jobs = asyncHandler(async (req, res) =>
  ok(res, await service.exportList(sql, await actor(req))),
);
export const create = asyncHandler(async (req, res) =>
  ok(res, await service.createExport(sql, await actor(req), req.body)),
);
export const job = asyncHandler(async (req, res) =>
  ok(res, await service.exportDetail(sql, await actor(req), req.params.id)),
);
export const retry = asyncHandler(async (req, res) =>
  ok(res, await service.retryExport(sql, await actor(req), req.params.id, req.body)),
);
const file = (receipt) =>
  asyncHandler(async (req, res) => {
    const bytes = await service.exportDownload(sql, await actor(req), req.params.id, receipt);
    res
      .set('Cache-Control', 'private, no-store')
      .set('Referrer-Policy', 'no-referrer')
      .attachment(`rentra-${receipt ? 'export-receipt' : 'export'}.json`)
      .type('application/json')
      .send(bytes);
  });
export const download = file(false),
  receipt = file(true);
