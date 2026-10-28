import { sql } from '@/config/database.js';
import { bookingActor } from '@/services/booking/record-page.js';
import { listCatalogues, readCatalogue, catalogueCommand } from '@/services/catalogues/service.js';
import { listVerticals, verticalCommand } from '@/services/catalogues/verticals.js';
import { listLandmarks, landmarkCommand } from '@/services/catalogues/landmarks.js';
import {
  listBetaGuests,
  betaGuestCommand,
  claimBetaPass,
} from '@/services/catalogues/beta-guests.js';
import { getSession } from '@/services/auth/dal.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** `verticals` (launch switch) and `landmarks` (map points) have their own rules; every other type is generic. */
export const list = asyncHandler(async (req, res) => {
  const actor = await bookingActor('admin');
  if (req.params.type === 'landmarks') return ok(res, await listLandmarks(sql, actor));
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
  if (req.params.type === 'landmarks')
    return ok(res, await landmarkCommand(sql, actor, req.params.id, req.body));
  return ok(
    res,
    req.params.type === 'verticals'
      ? await verticalCommand(sql, actor, req.params.id, req.body)
      : await catalogueCommand(sql, actor, req.params.type, req.params.id, req.body),
  );
});

/** Closed beta invites for a vertical (hotel plan, Phase 9). */
export const betaGuests = asyncHandler(async (req, res) =>
  ok(res, await listBetaGuests(sql, await bookingActor('admin'), req.params.code)),
);
export const betaGuestsCommand = asyncHandler(async (req, res) =>
  ok(res, await betaGuestCommand(sql, await bookingActor('admin'), req.params.code, req.body)),
);
/** Customer: exchange an invite for a 7-day beta pass. */
export const betaPass = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await claimBetaPass(sql, await getSession()));
});
