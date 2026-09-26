import { cancellationEntitlement } from './cancellation.js';

/**
 * CP14 booking case rules. Pure: no database or session access.
 *
 * A case never edits accepted booking terms. Its only money-moving outcome is
 * the existing visit cancellation, with refunds capped by verified captures.
 */
export const CASE_TYPES = Object.freeze([
  'owner_cancellation',
  'customer_cancellation',
  'change_request',
  'no_show',
  'late_arrival',
  'operational',
]);
export const OWNER_CASE_TYPES = Object.freeze(['owner_cancellation', 'no_show', 'late_arrival', 'operational']);
export const ADMIN_SOURCES = Object.freeze(['support', 'phone', 'email', 'internal']);
export const AUDIENCES = Object.freeze(['internal', 'client', 'customer', 'everyone']);
export const OUTCOMES = Object.freeze(['visits_cancelled', 'declined', 'no_change']);
export const REFUND_BASES = Object.freeze(['policy', 'full']);

export const CASE_LABELS = Object.freeze({
  owner_cancellation: 'Owner cancellation',
  customer_cancellation: 'Customer cancellation request',
  change_request: 'Date or guest change',
  no_show: 'No-show',
  late_arrival: 'Late arrival',
  operational: 'Operational issue',
});
export const OUTCOME_LABELS = Object.freeze({
  visits_cancelled: 'Visits cancelled',
  declined: 'Declined',
  no_change: 'Resolved without booking changes',
});

/** Rentra's recorded default: the guest is not at fault when the owner cancels. */
export const defaultRefundBasis = (type) => (type === 'owner_cancellation' ? 'full' : 'policy');

export function caseReference(id) {
  return `CASE-${String(id).replaceAll('-', '').slice(0, 10).toUpperCase()}`;
}

/** Who may read an update: admins read everything; owners and customers read their own audience. */
export function visibleTo(viewer, audience) {
  if (viewer === 'admin') return true;
  if (viewer === 'owner') return audience === 'client' || audience === 'everyone';
  if (viewer === 'customer') return audience === 'customer' || audience === 'everyone';
  return false;
}

/** The first update's audience follows the requester, so nobody hears of a request meant for someone else. */
export const createdAudience = (requesterKind) =>
  requesterKind === 'owner' ? 'client' : requesterKind === 'customer' ? 'customer' : 'internal';

/** Why a visit cannot be cancelled by a case, or null when it can. */
export function uncancellableReason(visit, now) {
  if (visit.state === 'cancelled') return 'Already cancelled';
  if (visit.state === 'requested') return 'Awaiting verified payment; nothing to cancel yet';
  if (visit.state !== 'confirmed') return `Visit is ${String(visit.state).replaceAll('_', ' ')}; record the outcome instead`;
  if (!visit.hours_known || !visit.starts_at) return 'Visit hours need reconciliation first';
  if (+new Date(visit.starts_at) <= +new Date(now)) return 'Visit has started; record a no-show or late-arrival outcome instead';
  return null;
}

/**
 * Entitlement for one cancellable visit. `policy` applies the accepted snapshot
 * exactly as a customer cancellation would; `full` returns every component.
 * Both are later capped by what was actually captured and not yet refunded.
 */
export function caseEntitlement(visit, basis, now) {
  if (basis === 'full') {
    return {
      rent: Number(visit.amount_rent_minor),
      fee: Number(visit.amount_fee_minor),
      deposit: Number(visit.amount_deposit_minor),
      rate: 1,
      tier: visit.policy_snapshot?.cancellationTier ?? null,
    };
  }
  if (basis !== 'policy') throw new Error('BASIS_UNSUPPORTED');
  return cancellationEntitlement(visit, now);
}
