import {
  ownerEarnings,
  ownerEarningsCsv,
  earningsFilters,
} from '@/services/finance/owner-earnings.js';
import { statementFilters } from '@/services/finance/statements.js';
import { listOwnerRepayments, verifyOwnerRepayment } from '@/services/finance/owner-repayment.js';
import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import {
  financeStatement,
  financeAllocation,
  financePayouts,
  financePayout,
  financeCsv,
} from '@/services/finance/statements.js';
import {
  getOwnerHotelEarnings,
  getOwnerPayoutStatement,
  getCommissionInvoice,
} from '@/services/finance/hotel-payouts.js';
import { getOwnerHotelAnalytics } from '@/services/analytics/hotel-analytics.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
const actor = (req) => bookingActor(req.baseUrl.includes('/admin') ? 'admin' : 'owner');
export const statement = asyncHandler(async (req, res) =>
  ok(res, await financeStatement(sql, await actor(req), req.query)),
);
export const allocation = asyncHandler(async (req, res) =>
  ok(res, await financeAllocation(sql, await actor(req), req.params.id)),
);
export const payouts = asyncHandler(async (req, res) =>
  ok(res, await financePayouts(sql, await actor(req), req.query)),
);
export const payout = asyncHandler(async (req, res) =>
  ok(res, await financePayout(sql, await actor(req), req.params.id)),
);
export const csv = asyncHandler(async (req, res) => {
  const viewer = await actor(req);
  const text =
    viewer.kind === 'owner'
      ? await ownerEarningsCsv(sql, viewer, req.query)
      : await financeCsv(sql, viewer, req.query);
  const period =
    viewer.kind === 'owner' ? earningsFilters(req.query).month : statementFilters(req.query).period;
  res.set('Cache-Control', 'private, no-store');
  res.attachment(`rentra-statement-${period}.csv`).type('text/csv').send(text);
});

export const earnings = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await ownerEarnings(sql, await actor(req), req.query));
});
export const earningsPrint = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await ownerEarnings(sql, await actor(req), req.query, { all: true }));
});

/** Hotel plan, Phase 8: hotel earnings, payout statements, commission invoices, analytics (owner only). */
export const hotelEarnings = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await getOwnerHotelEarnings(sql, (await bookingActor('owner')).id, req.query));
});
export const hotelPayoutStatement = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await getOwnerPayoutStatement(sql, (await bookingActor('owner')).id, req.params.id));
});
export const commissionInvoice = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await getCommissionInvoice(sql, (await bookingActor('owner')).id, req.params.id));
});
export const hotelAnalytics = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await getOwnerHotelAnalytics(sql, (await bookingActor('owner')).id, req.query));
});

const testTransport = () =>
  process.env.NODE_ENV === 'test' ? globalThis.__rentraPaymentFetcher : undefined;
/** Story 2.18: the owner's own Test repayment links. */
export const repayments = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await listOwnerRepayments(sql, (await bookingActor('owner')).id));
});
export const repaymentVerify = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const owner = await bookingActor('owner');
  ok(
    res,
    await verifyOwnerRepayment(sql, owner.id, req.params.id, req.body, {
      fetcher: testTransport(),
    }),
  );
});
