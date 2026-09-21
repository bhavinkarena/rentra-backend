import { sql } from '@/config/database.js';
import { readNotification, manageNotification } from '@/services/notifications/actions.js';
import { customerNotifications, notificationMonitor } from '@/services/notifications/records.js';
import { getSession } from '@/services/auth/dal.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

export const list = asyncHandler(async (_req, res) =>
  ok(res, await customerNotifications(sql, await getSession())),
);

export const markRead = runAction(readNotification, { style: 'form' });

/**
 * Admin delivery monitor. Retry and reconcile are one endpoint because they
 * are one decision — the operator picks the operation, and an unknown send
 * cannot be retried at all, only reconciled against the provider's SID.
 */
export const monitor = asyncHandler(async (req, res) =>
  ok(res, await notificationMonitor(sql, req.admin.id, Number(req.query.page ?? 1))),
);

export const manage = runAction(manageNotification);
