import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { listCatalogues, readCatalogue, catalogueCommand } from '@/services/catalogues/service.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
export const list = asyncHandler(async (req, res) =>
  ok(res, await listCatalogues(sql, await bookingActor('admin'), req.params.type, req.query)),
);
export const detail = asyncHandler(async (req, res) =>
  ok(res, await readCatalogue(sql, await bookingActor('admin'), req.params.type, req.params.id)),
);
export const command = asyncHandler(async (req, res) =>
  ok(
    res,
    await catalogueCommand(
      sql,
      await bookingActor('admin'),
      req.params.type,
      req.params.id,
      req.body,
    ),
  ),
);
