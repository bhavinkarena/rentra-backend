import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import {
  financeStatement,
  financeAllocation,
  financePayouts,
  financePayout,
  financeCsv,
} from '@/services/finance/statements.js';
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
  const text = await financeCsv(sql, await actor(req), req.query);
  res.set('Cache-Control', 'private, no-store');
  res.attachment('rentra-statement.csv').type('text/csv').send(text);
});
