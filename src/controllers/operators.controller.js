import { sql } from '@/config/database.js';
import { currentAdminSession } from '@/services/auth/admin.js';
import {
  listOperators,
  readOperator,
  operatorCommand,
  enrollOperator,
} from '@/services/admin/operators.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
const actor = async (req) => ({
  kind: 'admin',
  id: req.admin.id,
  sessionId: (await currentAdminSession())?.sessionId,
});
export const list = asyncHandler(async (req, res) =>
  ok(res, await listOperators(sql, await actor(req), req.query)),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await readOperator(sql, await actor(req), req.params.id)),
);
export const command = asyncHandler(async (req, res) =>
  ok(res, await operatorCommand(sql, await actor(req), req.params.id, req.body)),
);
export const enrollment = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return ok(res, await enrollOperator(sql, req.body));
});
