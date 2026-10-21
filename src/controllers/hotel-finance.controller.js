import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import {
  commissionCommand,
  listCommissionRules,
  listTaxSlabs,
  replaceTaxSlabs,
} from '@/services/admin/hotel-finance.js';
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
