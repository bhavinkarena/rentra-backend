import { sql } from '@/config/database.js';
import {
  changeLifecycle,
  listClients,
  previewLifecycle,
  readClient,
} from '@/services/admin/clients.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** Admin client directory and lifecycle (CP03). Capability checks run in the router. */
export const list = asyncHandler(async (req, res) =>
  ok(res, await listClients(sql, req.valid?.query ?? req.query)),
);

export const detail = asyncHandler(async (req, res) =>
  ok(res, await readClient(sql, req.params.id)),
);

export const preview = asyncHandler(async (req, res) =>
  ok(res, await previewLifecycle(sql, req.params.id, req.valid?.query?.action ?? req.query.action)),
);

const command = (action) =>
  asyncHandler(async (req, res) =>
    ok(
      res,
      await changeLifecycle(sql, {
        adminId: req.admin.id,
        clientId: req.params.id,
        action,
        input: req.body,
        ip: req.ip ?? null,
      }),
    ),
  );

export const suspend = command('suspend');
export const reinstate = command('reinstate');
