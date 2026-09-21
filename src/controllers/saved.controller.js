import {
  loadSavedPlaces,
  loadGuestSavedPlaces,
  updateSavedPlace,
  mergeGuestSavedPlaces,
} from '@/services/customer/saved-actions.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Saved places work for signed-out guests too, which is why these routes are
 * public and the actor is resolved inside the service.
 *
 * The `scope` in the write paths is a hash of the session, not a user id: it
 * is how the client proves the list it is editing belongs to the session it
 * still thinks it has. If the account changed underneath, the scope no longer
 * matches and the service returns `accountChanged` instead of writing to the
 * wrong person's list.
 */
export const mine = asyncHandler(async (_req, res) => ok(res, await loadSavedPlaces()));

export const guest = asyncHandler(async (req, res) =>
  ok(res, await loadGuestSavedPlaces(req.body?.entries ?? req.body)),
);

export const update = asyncHandler(async (req, res) =>
  ok(res, await updateSavedPlace(req.body?.scope, req.body?.input)),
);

/** Called once after login, to fold a guest list into the account's. */
export const merge = asyncHandler(async (req, res) =>
  ok(res, await mergeGuestSavedPlaces(req.body?.scope, req.body?.input)),
);
