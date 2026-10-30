import { allocateByWeights, refundOfPaid } from './booking-money.js';

/**
 * Story 4.4: cumulative incident remedy maths. Pure; integer paise.
 *   paid      – verified paid per component {rent, fee, tax} for the chosen visits
 *   counted   – every counted earlier refund per component (verified + in-flight + case)
 *   visits    – [{ rentMinor, paidOut }] for spreading the owner share over payouts
 *   recoveredMinor – what the owner already repaid on the chosen visits
 * A lower target never claws back: the additional amount is never negative.
 * Tax is never attributed to owner or Rentra: it is its own line, treatment pending accounting.
 */
export function incidentRemedy({ paid, counted, targetPct, responsibility, visits = [], recoveredMinor = 0 }) {
  const rent = paid.rent ?? 0, fee = paid.fee ?? 0, tax = paid.tax ?? 0;
  const paidMinor = rent + fee + tax;
  const target = refundOfPaid({ rent, fee, tax }, targetPct);
  const targetMinor = target.rent + target.fee + target.tax;
  const priorOwner = counted.rent ?? 0, priorFee = counted.fee ?? 0, priorTax = counted.tax ?? 0;
  const countedMinor = priorOwner + priorFee + priorTax;
  const additionalDueMinor = Math.max(0, targetMinor - countedMinor);
  // The additional guest money splits like the payment; its tax part stays out of both shares.
  const [addOwner, addFee, addTax] = allocateByWeights(additionalDueMinor, [rent, fee, tax]);
  let ownerTotal, reassignedFromRentraMinor = 0;
  if (responsibility === 'owner_funded' && additionalDueMinor > 0) {
    // The owner bears the whole cumulative target (excluding tax), including Rentra's earlier fee share.
    ownerTotal = Math.max(target.rent + target.fee, priorOwner);
    reassignedFromRentraMinor = Math.min(priorFee, Math.max(0, ownerTotal - priorOwner - addOwner - addFee));
    ownerTotal = priorOwner + addOwner + addFee + reassignedFromRentraMinor;
  } else if (responsibility === 'owner_funded') {
    // Nothing more is paid: no fee moves; the owner keeps the earlier owner share.
    ownerTotal = priorOwner;
  } else {
    ownerTotal = priorOwner + addOwner;
  }
  const rentraTotal = priorOwner + priorFee + addOwner + addFee - ownerTotal;
  const shares = visits.some((v) => v.rentMinor > 0) ? allocateByWeights(ownerTotal, visits.map((v) => v.rentMinor)) : [];
  const paidOutShare = shares.reduce((acc, share, i) => acc + (visits[i].paidOut ? share : 0), 0);
  return {
    paidMinor,
    targetMinor,
    targetByComponent: target,
    additionalDueMinor,
    providerCall: additionalDueMinor > 0,
    taxMinor: priorTax + addTax,
    owner: {
      totalMinor: ownerTotal,
      increaseMinor: ownerTotal - priorOwner,
      exceedsProceedsMinor: Math.max(0, ownerTotal - rent),
    },
    rentra: { totalMinor: rentraTotal, retainedFeeMinor: fee - Math.min(fee, rentraTotal) },
    reassignedFromRentraMinor,
    projectedRecoveryMinor: Math.max(0, paidOutShare - recoveredMinor),
  };
}
