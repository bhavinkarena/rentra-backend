/**
 * CP19 payment investigation rules. Pure: no database or provider access.
 *
 * Only a verified provider fact is money. Simulated and legacy records are
 * labelled as such and are never offered a provider re-fetch.
 */

/** Show which Test key was pinned without exposing more than its tail. */
export function maskKeyId(keyId) {
  if (typeof keyId !== 'string' || !keyId) return null;
  const match = /^(rzp_(?:test|live)_)([A-Za-z0-9]+)$/.exec(keyId);
  return match ? `${match[1]}…${match[2].slice(-4)}` : 'masked';
}

const UNRESOLVED_EXECUTION = ['dispatched', 'unknown', 'linked'];

export function paymentStatus(p) {
  const reconcilable =
    p.provider === 'razorpay' &&
    p.environment === 'test' &&
    p.mode === 'real' &&
    Boolean(p.executionState) &&
    p.executionState !== 'ready' &&
    p.state !== 'succeeded';
  const attention =
    (p.refundsUncertain ?? 0) > 0 ||
    (p.eventsFailed ?? 0) > 0 ||
    (p.attemptsUnknown ?? 0) > 0 ||
    (p.state !== 'succeeded' && (UNRESOLVED_EXECUTION.includes(p.executionState) || Boolean(p.executionFailure)));
  const status = (key, label) => ({ key, label, reconcilable, attention });
  if (p.mode === 'simulated' || p.environment === 'simulated') return status('simulated', 'Simulated — no money moved');
  if (p.mode === 'legacy_unknown') return status('legacy', 'Legacy record — not evidence of collection');
  if (p.state === 'succeeded') {
    if ((p.refundsUncertain ?? 0) > 0) return status('needs_review', 'Captured · refund outcome uncertain');
    if ((p.refundPendingMinor ?? 0) > 0) return status('refund_pending', 'Captured · refund pending');
    if ((p.capturedMinor ?? 0) > 0 && (p.refundedMinor ?? 0) >= p.capturedMinor) return status('refunded', 'Captured and fully refunded');
    return status('settled', 'Captured and verified');
  }
  if (p.state === 'failed' || p.state === 'cancelled') return status('closed', `Payment ${p.state}`);
  if (reconcilable || UNRESOLVED_EXECUTION.includes(p.executionState)) return status('awaiting_provider', 'Outcome not yet verified');
  return status('not_started', 'Checkout not started');
}
