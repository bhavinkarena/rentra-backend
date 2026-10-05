import { sql } from '@/config/database.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { readAdminDashboard, readDecisionHistory } from '@/services/admin/dashboard.js';

export const dashboard = asyncHandler(async (req, res) =>
  ok(res, await readAdminDashboard(sql, req.admin.id, req.valid.query)),
);
export const decisionHistory = asyncHandler(async (req, res) =>
  ok(res, await readDecisionHistory(sql, req.valid.query)),
);
