import { CANCELLATION_TIERS } from './pricing.js';

/** Versioned customer-v1 policy: elapsed 24-hour days before the precise visit start. */
export function cancellationEntitlement(visit, now) {
  if (visit.policy_snapshot?.version !== 'customer-v1') throw new Error('POLICY_UNSUPPORTED');
  const tier = visit.policy_snapshot.cancellationTier;
  const policy = visit.policy_snapshot.cancellation || CANCELLATION_TIERS[tier];
  if (!policy || !visit.hours_known || !visit.starts_at) throw new Error('POLICY_UNSUPPORTED');
  const remaining = +new Date(visit.starts_at) - +new Date(now);
  if (remaining <= 0) throw new Error('VISIT_STARTED');
  const rate = policy.bands.find(([days]) => remaining >= days * 86400000)?.[1] ?? 0;
  const rent = Number(visit.amount_rent_minor), fee = Number(visit.amount_fee_minor);
  // Avoid floating point paise and round fractional paise down, bounded by paid components later.
  return { rent: Number(BigInt(rent) * BigInt(Math.round(rate * 10000)) / 10000n),
    fee: (visit.policy_snapshot.cancellation ? policy.feeOnFullRefund : tier === 'flexible') && rate === 1 ? fee : 0, deposit: Number(visit.amount_deposit_minor),
    rate, tier, startsAt: new Date(visit.starts_at).toISOString() };
}
