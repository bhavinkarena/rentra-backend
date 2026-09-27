/**
 * CP21 payout destination rules. Pure: no database or session access.
 *
 * A destination version records what the owner declared. Rentra keeps only the
 * last four digits of a bank account; a name or last-four comparison is a staff
 * hint, never verification. "verified" needs provider evidence, which no
 * registered provider produces yet.
 */
export const VERIFICATION_AVAILABLE = false;

export function maskUpi(upiId) {
  if (typeof upiId !== 'string' || !upiId.includes('@')) return null;
  const [local, domain] = upiId.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

export function maskedDestination(d) {
  return d.method === 'bank' ? `Bank •••• ${d.account_last4 ?? d.accountLast4} · ${d.ifsc}` : `UPI ${maskUpi(d.upi_id ?? d.upiId)}`;
}

/** Compare the declared holder with the KYC name: same, different or unknown. */
export function nameCheck(kycName, holderName) {
  const a = String(kycName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const b = String(holderName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!a || !b) return 'unknown';
  return a === b ? 'same' : 'different';
}

export const STATE_LABELS = Object.freeze({
  draft: 'Draft — not submitted',
  submitted: 'Submitted — verification unavailable, payouts disabled',
  verified: 'Verified by the payout provider',
  failed: 'Failed — submit a new destination',
  superseded: 'Replaced by a newer version',
});

/** Money may move only to a verified destination; everything else explains why not. */
export function payoutReadiness(current) {
  if (!current) return { ready: false, reason: 'No payout destination submitted yet.' };
  if (current.state === 'verified') return { ready: true, reason: null };
  if (current.state === 'failed') return { ready: false, reason: 'The destination failed review. Submit a new destination.' };
  return {
    ready: false,
    reason: VERIFICATION_AVAILABLE
      ? 'Waiting for the payout provider to verify this destination.'
      : 'Bank verification is not available yet, so payouts stay disabled. Your details are recorded; nothing is sent.',
  };
}
