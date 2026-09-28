import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import {
  listContent,
  readContent,
  contentCommand,
  publicContent,
} from '@/services/content/service.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
export const list = asyncHandler(async (req, res) =>
  ok(res, await listContent(sql, await bookingActor('admin'))),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await readContent(sql, await bookingActor('admin'), req.params.kind, req.query)),
);
export const command = asyncHandler(async (req, res) =>
  ok(res, await contentCommand(sql, await bookingActor('admin'), req.params.kind, req.body)),
);
export const published = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  return ok(res, await publicContent(sql, req.params.kind, req.params.version || null));
});
