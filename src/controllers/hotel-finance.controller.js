import { listPayoutModes, payoutModeCommand } from '@/services/finance/payout-modes.js';
import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import {
  commissionCommand,
  listCommissionRules,
  listTaxSlabs,
  replaceTaxSlabs,
} from '@/services/admin/hotel-finance.js';
import {
  previewPayoutRun,
  executePayoutRun,
  settlePayoutRun,
  listPayoutRuns,
} from '@/services/finance/hotel-payouts.js';
import { changeServiceFee, listServiceFees } from '@/services/finance/service-fee.js';
import { getAdminHotelAnalytics } from '@/services/analytics/hotel-analytics.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** Hotel commission rules and tax slabs (hotel plan, Phase 4). */
export const commission = asyncHandler(async (_req, res) =>
  ok(res, await listCommissionRules(sql, await bookingActor('admin'))),
);
export const commissionSave = asyncHandler(async (req, res) =>
  ok(res, await commissionCommand(sql, await bookingActor('admin'), req.body)),
);
export const taxSlabs = asyncHandler(async (_req, res) =>
  ok(res, await listTaxSlabs(sql, await bookingActor('admin'))),
);
export const taxSlabsSave = asyncHandler(async (req, res) =>
  ok(res, await replaceTaxSlabs(sql, await bookingActor('admin'), req.body)),
);

/** Weekly payout runs and hotel analytics (hotel plan, Phase 8). */
export const payoutRunPreview = asyncHandler(async (req, res) =>
  ok(res, await previewPayoutRun(sql, (await bookingActor('admin')).id, req.query)),
);
export const payoutRunExecute = asyncHandler(async (req, res) =>
  ok(res, await executePayoutRun(sql, (await bookingActor('admin')).id, req.body)),
);
export const payoutRunSettle = asyncHandler(async (req, res) =>
  ok(
    res,
    await settlePayoutRun(sql, (await bookingActor('admin')).id, {
      runId: req.params.id,
      utr: req.body?.utr,
    }),
  ),
);
export const payoutRunsList = asyncHandler(async (_req, res) =>
  ok(res, await listPayoutRuns(sql, (await bookingActor('admin')).id)),
);
export const hotelAnalytics = asyncHandler(async (req, res) =>
  ok(res, await getAdminHotelAnalytics(sql, (await bookingActor('admin')).id, req.query)),
);

/** Story 2.2: the one guest-paid Rentra service fee (global and owner-wide overrides). */
export const serviceFees = asyncHandler(async (_req, res) => ok(res, await listServiceFees(sql)));
export const serviceFeeChange = asyncHandler(async (req, res) =>
  ok(res, await changeServiceFee(sql, { adminId: req.admin.id, input: req.body, ip: req.ip })),
);

export const payoutModes = asyncHandler(async (_req, res) =>
  ok(res, await listPayoutModes(sql, await bookingActor('admin'))),
);
export const payoutModeSave = asyncHandler(async (req, res) =>
  ok(res, await payoutModeCommand(sql, await bookingActor('admin'), req.body)),
);
