import { sql } from '@/config/database.js';
import {
  readClientUpdate,
  clientTasks,
  listClientUpdates,
  markClientUpdatesRead,
  readClientPreferences,
  saveClientPreferences,
  navigationCounts,
} from '@/services/auth/client-inbox.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** The signed-in client's own updates and tasks; every query is scoped by `req.user.id`. */
export const detail = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await readClientUpdate(sql, req.user.id, req.params.id));
});
export const list = asyncHandler(async (req, res) =>
  ok(res, await listClientUpdates(sql, req.user.id, req.query)),
);
export const unread = asyncHandler(async (req, res) =>
  ok(res, await navigationCounts(sql, req.user)),
);
export const read = asyncHandler(async (req, res) =>
  ok(res, await markClientUpdatesRead(sql, req.user.id, req.body)),
);
export const preferences = asyncHandler(async (req, res) =>
  ok(res, await readClientPreferences(sql, req.user.id)),
);
export const savePreferences = asyncHandler(async (req, res) =>
  ok(res, await saveClientPreferences(sql, req.user.id, req.body)),
);
export const tasks = asyncHandler(async (req, res) => ok(res, await clientTasks(sql, req.user.id)));
