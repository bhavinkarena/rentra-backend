import { BOOKING_POLICY } from './booking-policy.js';

/**
 * Pure pricing + refund rules. No React, no DB, no network.
 *
 * Imported by the checkout page, the Razorpay webhook handler AND the worker.
 * This is the single reason the repo is not split in two: a refund rule that
 * disagrees with itself across two codebases is the one bug a money flow
 * cannot survive.
 */

/** Slot model — a farmhouse sells a day picnic and an overnight separately. */
export const SLOTS = {
  day: { id: 'day', label: 'Day picnic', window: '9:00 AM – 6:00 PM' },
  night: { id: 'night', label: 'Overnight', window: '6:00 PM – 10:00 AM' },
  full_day: { id: 'full_day', label: 'Full day', window: '24 hours' },
};

export const PLATFORM_FEE_RATE = BOOKING_POLICY.platformFeeBps / 10_000;
export const ADVANCE_RATE = BOOKING_POLICY.illustrativeAdvanceBps / 10_000;

/** Cancellation tiers. Refund is computed, never negotiated in chat. */
export const CANCELLATION_TIERS = {
  flexible: { label: 'Flexible', bands: [[7, 1], [3, 1], [0, 0.5]], noShow: 0 },
  moderate: { label: 'Moderate', bands: [[7, 1], [3, 0.5], [0, 0]], noShow: 0 },
  strict: { label: 'Strict', bands: [[7, 0.5], [3, 0], [0, 0]], noShow: 0 },
};

// Legacy callers and columns use whole rupees. New customer booking services
// must use booking-money.js; never reinterpret these existing return values.
const paise = (n) => Math.round(n);

/**
 * @param {object} input
 * @param {number} input.baseRent      rent for the chosen slot, in rupees
 * @param {number} [input.deposit]     refundable security deposit
 * @param {number} [input.extraGuests] guests beyond the included count
 * @param {number} [input.extraGuestCharge]
 * @returns {{rent:number, fee:number, deposit:number, advanceDue:number,
 *            balanceDue:number, total:number, brokerage:number}}
 */
export function calculateBookingPrice({
  baseRent,
  deposit = 0,
  extraGuests = 0,
  extraGuestCharge = 0,
}) {
  const rent = paise(baseRent + extraGuests * extraGuestCharge);
  const fee = paise(rent * PLATFORM_FEE_RATE);

  // Advance = a slice of rent PLUS the whole platform fee, so Rentra's
  // revenue is never at risk if the balance is later paid in cash.
  const advanceDue = paise(rent * ADVANCE_RATE + fee);
  const balanceDue = rent + fee - advanceDue;

  return {
    rent,
    fee,
    deposit,
    advanceDue,
    balanceDue,
    total: rent + fee,
    brokerage: 0, // always zero, always shown — it is the entire positioning
  };
}

/**
 * @param {object} input
 * @param {'flexible'|'moderate'|'strict'} input.tier
 * @param {number} input.daysUntilCheckIn
 * @param {number} input.rent
 * @param {number} input.fee
 * @param {number} [input.deposit]
 * @param {boolean} [input.noShow]
 * @returns {{refund:number, nonRefundable:number, rentRefundRate:number,
 *            feeRefunded:boolean, depositRefunded:number}}
 */
export function calculateRefund({
  tier,
  daysUntilCheckIn,
  rent,
  fee,
  deposit = 0,
  noShow = false,
}) {
  const policy = CANCELLATION_TIERS[tier] ?? CANCELLATION_TIERS.moderate;
  let rate = policy.noShow;

  if (!noShow) {
    for (const [minDays, bandRate] of policy.bands) {
      if (daysUntilCheckIn >= minDays) {
        rate = bandRate;
        break;
      }
    }
  }

  // The platform fee comes back only on a full flexible-tier cancellation.
  const feeRefunded = tier === 'flexible' && rate === 1;
  const rentRefund = paise(rent * rate);

  return {
    // The deposit is ALWAYS returned in full. It is not a penalty instrument.
    refund: rentRefund + (feeRefunded ? fee : 0) + deposit,
    nonRefundable: rent - rentRefund + (feeRefunded ? 0 : fee),
    rentRefundRate: rate,
    feeRefunded,
    depositRefunded: deposit,
  };
}

/** Owner cancelled a confirmed booking: full refund, no exceptions. */
export function ownerCancellationRefund({ rent, fee, deposit = 0 }) {
  return { refund: rent + fee + deposit, nonRefundable: 0, penaltyOnOwner: true };
}

/**
 * The slot a listing should lead with: the cheapest one it actually sells.
 *
 * Shared by the page, its metadata and its OG card so all three quote the
 * same number — a card promising ₹6,500 and a page opening at ₹7,500 is a
 * bait-and-switch even when it is an accident. Leading with the cheapest is
 * also the same rule the listing card follows in never showing the weekend
 * peak first.
 *
 * @param {Record<string, {weekday:number, weekend:number}>} prices
 */
export function cheapestSlot(prices) {
  const entries = Object.entries(prices ?? {}).filter(([, p]) => p?.weekday != null);
  if (!entries.length) return null;
  return entries.reduce((best, cur) => (cur[1].weekday < best[1].weekday ? cur : best))[0];
}

export const formatINR = (n) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
