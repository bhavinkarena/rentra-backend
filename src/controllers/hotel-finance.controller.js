import { listPayoutModes, payoutModeCommand } from '@/services/finance/payout-modes.js';
import {
  assignOwnerRecovery,
  listRecoveryCandidates,
  previewOwnerRecovery,
} from '@/services/finance/owner-recovery.js';
import {
  checkRepaymentLink,
  createRepaymentLink,
  resolveRepaymentLink,
} from '@/services/finance/owner-repayment.js';
import { confirmNoticeReceipt } from '@/services/finance/owner-repayment-notice.js';
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

// Story 2.17: Test-only owner recovery obligations (admin.payments.*).
const testTransport = () =>
  process.env.NODE_ENV === 'test' ? globalThis.__rentraPaymentFetcher : undefined;
const noStore = (res) => res.set('Cache-Control', 'private, no-store');
export const ownerRecoveries = asyncHandler(async (_req, res) =>
  ok(noStore(res), await listRecoveryCandidates(sql, await bookingActor('admin'))),
);
export const ownerRecovery = asyncHandler(async (req, res) =>
  ok(
    noStore(res),
    await previewOwnerRecovery(sql, await bookingActor('admin'), req.params.sourceId),
  ),
);
export const ownerRecoveryAssign = asyncHandler(async (req, res) =>
  ok(
    noStore(res),
    await assignOwnerRecovery(sql, await bookingActor('admin'), req.params.sourceId, req.body),
  ),
);
export const ownerRecoveryRepaymentLink = asyncHandler(async (req, res) =>
  ok(
    noStore(res),
    await createRepaymentLink(sql, await bookingActor('admin'), req.params.sourceId, req.body, {
      fetcher: testTransport(),
    }),
  ),
);
export const ownerRecoveryRepaymentCheck = asyncHandler(async (req, res) =>
  ok(
    noStore(res),
    await checkRepaymentLink(sql, await bookingActor('admin'), req.params.sourceId, {
      fetcher: testTransport(),
    }),
  ),
);
export const ownerRecoveryRepaymentResolve = asyncHandler(async (req, res) =>
  ok(
    noStore(res),
    await resolveRepaymentLink(sql, await bookingActor('admin'), req.params.sourceId, req.body, {
      fetcher: testTransport(),
    }),
  ),
);
/** Story 2.19: finance admin confirms when the owner actually received the repayment notice. */
export const ownerRecoveryNoticeReceipt = asyncHandler(async (req, res) =>
  ok(
    noStore(res),
    await confirmNoticeReceipt(sql, await bookingActor('admin'), req.params.sourceId, req.body),
  ),
);
