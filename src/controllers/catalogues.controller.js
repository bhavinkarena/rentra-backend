import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { listCatalogues, readCatalogue, catalogueCommand } from '@/services/catalogues/service.js';
import { listVerticals, verticalCommand } from '@/services/catalogues/verticals.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** `verticals` is keyed by code and has its own launch-switch rules; every other type is generic. */
export const list = asyncHandler(async (req, res) => {
  const actor = await bookingActor('admin');
  return ok(
    res,
    req.params.type === 'verticals'
      ? await listVerticals(sql, actor)
      : await listCatalogues(sql, actor, req.params.type, req.query),
  );
});
export const detail = asyncHandler(async (req, res) => {
  const actor = await bookingActor('admin');
  if (req.params.type === 'verticals') {
    const { items, canWrite } = await listVerticals(sql, actor);
    const record = items.find((row) => row.code === req.params.id);
    return ok(res, { record: record ?? null, canWrite });
  }
  return ok(res, await readCatalogue(sql, actor, req.params.type, req.params.id));
});
export const command = asyncHandler(async (req, res) => {
  const actor = await bookingActor('admin');
  return ok(
    res,
    req.params.type === 'verticals'
      ? await verticalCommand(sql, actor, req.params.id, req.body)
      : await catalogueCommand(sql, actor, req.params.type, req.params.id, req.body),
  );
});
