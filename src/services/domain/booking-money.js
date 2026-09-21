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

export function calculateVisitPriceMinor({ baseRentMinor, depositMinor, guests, includedGuests, capacity, extraGuestChargeMinor }) {
  [baseRentMinor, depositMinor, extraGuestChargeMinor].forEach((value) => integer(value));
  [guests, includedGuests, capacity].forEach((value) => integer(value, 'Guest count'));
  if (guests < 1 || capacity < 1 || includedGuests > capacity || guests > capacity) {
    throw new RangeError('Guest count exceeds the configured capacity');
  }
  const extraGuestsMinor = safeNumber(BigInt(Math.max(0, guests - includedGuests)) * BigInt(extraGuestChargeMinor));
  const rentMinor = safeNumber(BigInt(baseRentMinor) + BigInt(extraGuestsMinor));
  const feeMinor = applyBasisPoints(rentMinor, BOOKING_POLICY.platformFeeBps);
  const totalMinor = safeNumber(BigInt(rentMinor) + BigInt(feeMinor));
  const illustrativeAdvanceMinor = safeNumber(BigInt(applyBasisPoints(rentMinor, BOOKING_POLICY.illustrativeAdvanceBps)) + BigInt(feeMinor));
  return {
    currency: BOOKING_POLICY.currency,
    baseRentMinor, extraGuestsMinor, rentMinor, feeMinor, totalMinor, depositMinor,
    brokerageMinor: 0,
    illustrativeAdvanceMinor,
    illustrativeBalanceMinor: totalMinor - illustrativeAdvanceMinor,
  };
}

/**
 * Pure price breakdown from trusted server data, not a persisted/accepted quote.
 * No collection, tax, payment state or inventory availability is inferred here.
 * Full-day overrides must be explicit; day/night overrides are never added.
 */
export function priceVisitsMinor({ dates, slot, guests, rate, overridesByDate = {} }) {
  if (!BOOKING_SLOTS.includes(slot) || !rate) throw new RangeError('Slot pricing is not configured');
  integer(rate.weekdayMinor);
  integer(rate.weekendMinor);
  const visits = normalizeVisitDates(dates).map((date) => {
    const override = Object.hasOwn(overridesByDate, date) ? overridesByDate[date]?.[slot] : null;
    const weekend = isWeekendLocalDate(date);
    const baseRentMinor = override ?? (weekend ? rate.weekendMinor : rate.weekdayMinor);
    return {
      date, slot, guests,
      priceSource: override != null ? 'override' : weekend ? 'weekend' : 'weekday',
      ...calculateVisitPriceMinor({ ...rate, baseRentMinor, guests }),
    };
  });
  const fields = ['baseRentMinor', 'extraGuestsMinor', 'rentMinor', 'feeMinor', 'totalMinor', 'depositMinor', 'brokerageMinor', 'illustrativeAdvanceMinor', 'illustrativeBalanceMinor'];
  const totals = Object.fromEntries(fields.map((field) => [
    field, safeNumber(visits.reduce((sum, visit) => sum + BigInt(visit[field]), 0n)),
  ]));
  return { currency: BOOKING_POLICY.currency, pricingVersion: BOOKING_POLICY.version, visits, totals };
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
