import { sql } from '@/config/database.js';
import {
  changeCustomerLifecycle,
  correctCustomerProfile,
  listCustomers,
  readCustomer,
  revokeCustomerSessions,
} from '@/services/admin/customers.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** Admin customer directory and account controls (CP04). Capability checks run in the router. */
export const list = asyncHandler(async (req, res) =>
  ok(res, await listCustomers(sql, req.valid?.query ?? req.query)),
);

export const detail = asyncHandler(async (req, res) =>
  ok(res, await readCustomer(sql, req.params.id)),
);

const command = (run, action) =>
  asyncHandler(async (req, res) =>
    ok(
      res,
      await run(sql, {
        adminId: req.admin.id,
        customerId: req.params.id,
        action,
        input: req.body,
        ip: req.ip ?? null,
      }),
    ),
  );

export const restrict = command(changeCustomerLifecycle, 'suspend');
export const reinstate = command(changeCustomerLifecycle, 'reinstate');
export const revokeSessions = command(revokeCustomerSessions);
export const correctProfile = command(correctCustomerProfile);
