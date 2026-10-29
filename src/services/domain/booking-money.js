import { BOOKING_POLICY, BOOKING_SLOTS } from './booking-policy.js';
import { isWeekendLocalDate, normalizeVisitDates } from './booking-dates.js';

function integer(value, name = 'Amount') {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
}

function safeNumber(value) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds safe integer range');
  return Number(value);
}

/** Explicit legacy boundary. Existing DB prices/booking amounts remain rupees. */
export function legacyRupeesToMinor(rupees) {
  return safeNumber(BigInt(integer(rupees, 'Legacy whole rupees')) * 100n);
}

/** Owner-entered INR, parsed as decimal text rather than rounded binary floats. */
export function parseINRMinor(value) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) throw new RangeError('Enter an INR amount with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  return safeNumber(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

/** Half up to the nearest paise, without floating-point multiplication. */
export function applyBasisPoints(amountMinor, basisPoints) {
  integer(amountMinor);
  integer(basisPoints, 'Basis points');
  if (basisPoints > 10_000) throw new RangeError('Basis points exceed 100%');
  return safeNumber((BigInt(amountMinor) * BigInt(basisPoints) + 5_000n) / 10_000n);
}

export function calculateVisitPriceMinor({ baseRentMinor, depositMinor, guests, includedGuests, capacity, extraGuestChargeMinor, feeBps, petMinor = 0 }) {
  [baseRentMinor, depositMinor, extraGuestChargeMinor].forEach((value) => integer(value));
  [guests, includedGuests, capacity].forEach((value) => integer(value, 'Guest count'));
  if (guests < 1 || capacity < 1 || includedGuests > capacity || guests > capacity) {
    throw new RangeError('Guest count exceeds the configured capacity');
  }
  const extraGuestsMinor = safeNumber(BigInt(Math.max(0, guests - includedGuests)) * BigInt(extraGuestChargeMinor));
  return visitMoneyMinor({ baseRentMinor, extraGuestsMinor, petMinor, depositMinor, feeBps });
}

/** Fee, total and illustrative advance for one visit's rent. The one place these rules live. */
// Story 3.9: `petMinor` is a paid extra inside the visit rent; it appears only when charged, so pet-free visits keep their shape.
export function visitMoneyMinor({ baseRentMinor, extraGuestsMinor = 0, petMinor = 0, depositMinor, feeBps = BOOKING_POLICY.platformFeeBps, feeMinor: givenFee }) {
  [baseRentMinor, extraGuestsMinor, petMinor, depositMinor].forEach((value) => integer(value));
  const rentMinor = safeNumber(BigInt(baseRentMinor) + BigInt(extraGuestsMinor) + BigInt(petMinor));
  const feeMinor = givenFee ?? applyBasisPoints(rentMinor, feeBps);
  const totalMinor = safeNumber(BigInt(rentMinor) + BigInt(feeMinor));
  const illustrativeAdvanceMinor = safeNumber(BigInt(applyBasisPoints(rentMinor, BOOKING_POLICY.illustrativeAdvanceBps)) + BigInt(feeMinor));
  return {
    currency: BOOKING_POLICY.currency,
    baseRentMinor, extraGuestsMinor, ...(petMinor ? { petMinor } : {}), rentMinor, feeMinor, totalMinor, depositMinor,
    brokerageMinor: 0,
    illustrativeAdvanceMinor,
    illustrativeBalanceMinor: totalMinor - illustrativeAdvanceMinor,
  };
}

/**
 * Story 2.2: one Rentra service fee per order, rounded half up once on the
 * whole rental base, then split over its parts by largest remainder (ties to
 * the earlier part) so the parts always add up to the order fee.
 */
export function allocateOrderFee(baseMinors, feeBps) {
  baseMinors.forEach((value) => integer(value));
  const total = baseMinors.reduce((sum, value) => sum + BigInt(value), 0n);
  const fee = BigInt(applyBasisPoints(safeNumber(total), feeBps));
  if (total === 0n) return baseMinors.map(() => 0);
  const exact = baseMinors.map((value) => BigInt(value) * fee);
  const parts = exact.map((value) => value / total);
  let left = fee - parts.reduce((sum, value) => sum + value, 0n);
  const order = exact.map((value, index) => ({ index, rest: value % total }))
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  for (const { index } of order) {
    if (left <= 0n) break;
    parts[index] += 1n;
    left -= 1n;
  }
  return parts.map(safeNumber);
}

/**
 * Story 2.7: split `totalMinor` over parts in proportion to their weights, by
 * stable largest remainder (ties to the earlier part). Zero-weight parts get
 * zero; a positive total over all-zero weights is an error, never a guess.
 */
export function allocateByWeights(totalMinor, weights) {
  integer(totalMinor);
  weights.forEach((value) => integer(value, 'Weight'));
  const sum = weights.reduce((acc, value) => acc + BigInt(value), 0n);
  if (sum === 0n) {
    if (totalMinor > 0) throw new RangeError('ALLOCATION_WEIGHTS_ZERO');
    return weights.map(() => 0);
  }
  const exact = weights.map((value) => BigInt(value) * BigInt(totalMinor));
  const parts = exact.map((value) => value / sum);
  let left = BigInt(totalMinor) - parts.reduce((acc, value) => acc + value, 0n);
  const order = exact
    .map((value, index) => ({ index, rest: value % sum, weight: weights[index] }))
    .filter((row) => row.weight > 0)
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  for (const { index } of order) {
    if (left <= 0n) break;
    parts[index] += 1n;
    left -= 1n;
  }
  return parts.map(safeNumber);
}

/** Story 2.7: a policy percentage of the whole paid amount, rounded down to the paisa, split like the payment. */
export function refundOfPaid(paidParts, pct) {
  const keys = Object.keys(paidParts);
  const paid = keys.reduce((acc, key) => acc + BigInt(integer(paidParts[key])), 0n);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new RangeError('Refund percentage must be 0-100');
  const total = safeNumber((paid * BigInt(pct)) / 100n);
  const parts = allocateByWeights(total, keys.map((key) => paidParts[key]));
  return Object.fromEntries(keys.map((key, index) => [key, parts[index]]));
}

/** Re-prices visits with the order-level fee; everything else about each visit is unchanged. */
export function withOrderFee(visits, feeBps) {
  const fees = allocateOrderFee(visits.map((visit) => visit.rentMinor), feeBps);
  return visits.map((visit, index) => ({
    ...visit,
    ...visitMoneyMinor({ baseRentMinor: visit.baseRentMinor, extraGuestsMinor: visit.extraGuestsMinor, petMinor: visit.petMinor, depositMinor: visit.depositMinor, feeMinor: fees[index] }),
  }));
}

const TOTAL_FIELDS = ['baseRentMinor', 'extraGuestsMinor', 'rentMinor', 'feeMinor', 'totalMinor', 'depositMinor', 'brokerageMinor', 'illustrativeAdvanceMinor', 'illustrativeBalanceMinor'];
/** Sum per-visit money into quote totals. */
export function sumVisitTotals(visits) {
  const fields = visits.some((visit) => visit.petMinor) ? [...TOTAL_FIELDS, 'petMinor'] : TOTAL_FIELDS;
  return Object.fromEntries(fields.map((field) => [
    field, safeNumber(visits.reduce((sum, visit) => sum + BigInt(visit[field] ?? 0), 0n)),
  ]));
}

/**
 * Pure price breakdown from trusted server data, not a persisted/accepted quote.
 * No collection, tax, payment state or inventory availability is inferred here.
 * Full-day overrides must be explicit; day/night overrides are never added.
 */
export function priceVisitsMinor({ dates, slot, guests, rate, overridesByDate = {}, weekendDays, feeBps = BOOKING_POLICY.platformFeeBps, petMinors = [] }) {
  if (!BOOKING_SLOTS.includes(slot) || !rate) throw new RangeError('Slot pricing is not configured');
  integer(rate.weekdayMinor);
  integer(rate.weekendMinor);
  const visits = normalizeVisitDates(dates).map((date, index) => {
    const override = Object.hasOwn(overridesByDate, date) ? overridesByDate[date]?.[slot] : null;
    const weekend = isWeekendLocalDate(date,weekendDays);
    const baseRentMinor = override ?? (weekend ? rate.weekendMinor : rate.weekdayMinor);
    return {
      date, slot, guests,
      priceSource: override != null ? 'override' : weekend ? 'weekend' : 'weekday',
      ...calculateVisitPriceMinor({ ...rate, baseRentMinor, guests, feeBps, petMinor: petMinors[index] ?? 0 }),
    };
  });
  const priced = withOrderFee(visits, feeBps);
  return { currency: BOOKING_POLICY.currency, pricingVersion: BOOKING_POLICY.version, visits: priced, totals: sumVisitTotals(priced) };
}

export function formatINRMinor(amountMinor) {
  integer(amountMinor);
  // Format the integer rupee part separately so even large safe integers keep
  // their exact paise; dividing a near-limit amount by 100 loses precision.
  const whole = Math.floor(amountMinor / 100);
  const paise = amountMinor % 100;
  const formatted = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(whole);
  return paise ? `${formatted}.${String(paise).padStart(2, '0')}` : formatted;
}
