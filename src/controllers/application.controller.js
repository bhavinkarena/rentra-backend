import {
  getOrCreateApplication,
  saveDetails,
  savePayout,
  saveConsent,
  submitApplication,
  withdrawApplication,
} from '@/services/auth/application.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Partner onboarding — the application a Client fills in before approval.
 *
 * Every route here is behind `requireRole('client')`, NOT `requireActiveClient`:
 * the whole point of this surface is that the account is not active yet.
 */
export const read = asyncHandler(async (req, res) =>
  ok(res, await getOrCreateApplication(req.user.id)),
);

export const details = runAction(saveDetails);
export const payout = runAction(savePayout);
export const consent = runAction(saveConsent);
export const submit = runAction(submitApplication, { style: 'none' });
export const withdraw = runAction(withdrawApplication, { style: 'none' });
