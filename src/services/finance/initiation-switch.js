import { unavailable } from '@/utils/apiError.js';

// Story 2.21: one operator switch that refuses new money initiation; reads, re-checks,
// verification of already-dispatched payments, webhooks and reconciliation keep working.
export const initiationDisabled = (env = process.env) => env?.FINANCE_INITIATION_DISABLED === 'true';

export function assertInitiationEnabled(env = process.env) {
  if (initiationDisabled(env))
    throw unavailable('FINANCE_INITIATION_DISABLED', 'New payments, refunds and payouts are paused by the finance team.');
}
