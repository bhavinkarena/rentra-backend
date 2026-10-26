import { CANCELLATION_TIERS } from './pricing.js';
import { refundPct } from './cancellation-policy.js';
import { refundOfPaid } from './booking-money.js';

/**
 * Versioned customer-v1 policy: elapsed time before the precise visit start.
 * Bands are 24-hour days, or hours when the snapshot says `bandUnit: 'hours'`
 * (time-booked venues). Snapshots without the key keep the day meaning.
 */
export function cancellationEntitlement(visit, now) {
  if (visit.policy_snapshot?.version !== 'customer-v1') throw new Error('POLICY_UNSUPPORTED');
  const tier = visit.policy_snapshot.cancellationTier;
  const policy = visit.policy_snapshot.cancellation || CANCELLATION_TIERS[tier];
  if (!policy || !visit.hours_known || !visit.starts_at) throw new Error('POLICY_UNSUPPORTED');
  const remaining = +new Date(visit.starts_at) - +new Date(now);
  const windows = visit.policy_snapshot.cancellationPolicy;
  let rate;
  if (windows) {
    // Story 2.6: the booked percentage windows; an exact cutoff takes the at/after window.
    const pct = refundPct(windows, remaining);
    if (remaining <= 0 && pct === 0) throw new Error('VISIT_STARTED');
    rate = pct / 100;
  } else {
    if (remaining <= 0) throw new Error('VISIT_STARTED');
    const unitMs = policy.bandUnit === 'hours' ? 3_600_000 : 86_400_000;
    rate = policy.bands.find(([units]) => remaining >= units * unitMs)?.[1] ?? 0;
  }
  const rent = Number(visit.amount_rent_minor), fee = Number(visit.amount_fee_minor);
  if (windows) {
    // Story 2.7 (FR-9/AD-9): the booked percentage of everything paid (rent and the Rentra fee),
    // split in proportion to what was paid, so owner and Rentra share the refund proportionally.
    const parts = refundOfPaid({ rent, fee }, Math.round(rate * 100));
    return { ...parts, deposit: Number(visit.amount_deposit_minor), rate, tier, basis: 'full_paid',
      startsAt: new Date(visit.starts_at).toISOString() };
  }
  // Avoid floating point paise and round fractional paise down, bounded by paid components later.
  return { rent: Number(BigInt(rent) * BigInt(Math.round(rate * 10000)) / 10000n),
    // Booked windows: a full refund returns the fee too (the full-paid basis is Story 2.7).
    fee: (windows ? true : visit.policy_snapshot.cancellation ? policy.feeOnFullRefund : tier === 'flexible') && rate === 1 ? fee : 0, deposit: Number(visit.amount_deposit_minor),
    rate, tier, startsAt: new Date(visit.starts_at).toISOString() };
}
