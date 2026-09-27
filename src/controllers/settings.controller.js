import { saveAccountSettings } from '@/services/auth/settings.js';
import {
  changePayoutDestination,
  payoutDestinationPage,
  submitPayoutDraft,
} from '@/services/payouts/destination-actions.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Reachable by any signed-in Client, approved or not — deliberately.
 *
 * A Client sent back for a payout-name mismatch has to be able to fix exactly
 * that, and by definition they are not active yet. Gating this behind approval
 * would make the one problem it exists to solve unfixable.
 */
export const account = runAction(saveAccountSettings);
/** CP21: versioned payout destinations (preview → submit; a stale sign-in saves a draft). */
export const payoutPage = asyncHandler(async (_req, res) => ok(res, await payoutDestinationPage()));
export const payout = runAction(changePayoutDestination);
export const payoutDraft = runAction(submitPayoutDraft);
