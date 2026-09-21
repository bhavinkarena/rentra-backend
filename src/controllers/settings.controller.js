import { saveAccountSettings, savePayoutDestination } from '@/services/auth/settings.js';
import { runAction } from '@/utils/runAction.js';

/**
 * Reachable by any signed-in Client, approved or not — deliberately.
 *
 * A Client sent back for a payout-name mismatch has to be able to fix exactly
 * that, and by definition they are not active yet. Gating this behind approval
 * would make the one problem it exists to solve unfixable.
 */
export const account = runAction(saveAccountSettings);
export const payout = runAction(savePayoutDestination);
