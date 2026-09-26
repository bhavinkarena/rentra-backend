import { sql } from '@/config/database.js';
import {
  inviteStaff,
  listTeam,
  reissueStaffLink,
  revokeStaff,
  updateStaffAccess,
} from '@/services/auth/staff-team.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** The owner's own caretakers only; every service call is scoped by `req.user.id`. */
export const list = asyncHandler(async (req, res) => ok(res, await listTeam(sql, req.user.id)));
export const invite = asyncHandler(async (req, res) =>
  ok(res, await inviteStaff(sql, req.user.id, req.body)),
);
export const link = asyncHandler(async (req, res) =>
  ok(res, await reissueStaffLink(sql, req.user.id, req.params.id)),
);
export const access = asyncHandler(async (req, res) =>
  ok(res, await updateStaffAccess(sql, req.user.id, req.params.id, req.body)),
);
export const revoke = asyncHandler(async (req, res) =>
  ok(res, await revokeStaff(sql, req.user.id, req.params.id, req.body)),
);
