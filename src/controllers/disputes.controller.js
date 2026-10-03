import { Readable } from 'node:stream';
import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { recordKindFromBaseUrl } from '@/services/booking/record-scope.js';
import {
  createDispute,
  listDisputes,
  readDispute,
  disputeContext,
  replyDispute,
  manageDispute,
  disputeAttachment,
} from '@/services/disputes/service.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
const actor = (req) => bookingActor(recordKindFromBaseUrl(req.baseUrl));
export const list = asyncHandler(async (req, res) =>
  ok(res, await listDisputes(sql, await actor(req), req.query)),
);
export const context = asyncHandler(async (req, res) =>
  ok(res, await disputeContext(sql, await actor(req), req.params.orderId)),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await readDispute(sql, await actor(req), req.params.id)),
);
export const create = asyncHandler(async (req, res) =>
  ok(
    res,
    await createDispute(
      sql,
      await actor(req),
      req.body,
      (req.files || []).map((f) => ({ size: f.size, arrayBuffer: async () => f.buffer })),
    ),
  ),
);
export const reply = asyncHandler(async (req, res) => {
  const files = (req.files || []).map((f) => ({ size: f.size, arrayBuffer: async () => f.buffer }));
  return ok(
    res,
    await replyDispute(sql, await actor(req), { ...req.body, id: req.params.id }, files),
  );
});
export const manage = asyncHandler(async (req, res) =>
  ok(res, await manageDispute(sql, await actor(req), { ...req.body, id: req.params.id })),
);
export const attachment = asyncHandler(async (req, res) => {
  const file = await disputeAttachment(sql, await actor(req), req.params.id, req.params.fileId);
  res.set({
    'Content-Type': file.mimeType,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="dispute-evidence.${{ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.mimeType] || 'bin'}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
  });
  return Readable.fromWeb(file.body).pipe(res);
});
