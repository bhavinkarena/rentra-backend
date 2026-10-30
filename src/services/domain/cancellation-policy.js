import { z } from 'zod';

/**
 * Story 2.6 (FR-9/FR-10): owner-configured, percentage-only cancellation.
 *
 * windows: descending `hoursBefore`, the last one 0. A window applies to a
 * request made MORE than `hoursBefore` hours before the booked check-in; at an
 * exact cutoff the later (at/after) window applies. At or after check-in,
 * `atOrAfterCheckInPct` applies (0 means no refund). Early departure is an
 * optional owner offer for unused nights. A no-show alone never refunds.
 * Percentages apply to whatever basis the refund engine uses (Story 2.7).
 */
export const MAX_WINDOWS = 6;
export const MAX_HOURS = 720;

// A blank field is an error, never 0%.
const blankIsNaN = (v) => (v === '' || v === null ? Number.NaN : v);
const pct = z.preprocess(blankIsNaN, z.coerce.number().int().min(0).max(100));
export const cancellationPolicySchema = z
  .object({
    version: z.literal(1).default(1),
    windows: z
      .array(z.object({ hoursBefore: z.preprocess(blankIsNaN, z.coerce.number().int().min(0).max(MAX_HOURS)), pct }))
      .min(1)
      .max(MAX_WINDOWS),
    atOrAfterCheckInPct: pct.default(0),
    earlyDeparture: z
      .object({ offered: z.coerce.boolean().default(false), pct: pct.default(0) })
      .default({ offered: false, pct: 0 }),
  })
  .superRefine((policy, context) => {
    const hours = policy.windows.map((w) => w.hoursBefore);
    if (hours.at(-1) !== 0)
      context.addIssue({ code: 'custom', path: ['windows'], message: 'The last window must run until check-in (0 hours).' });
    if (hours.some((h, i) => i > 0 && h >= hours[i - 1]))
      context.addIssue({ code: 'custom', path: ['windows'], message: 'Each window must start fewer hours before check-in than the one above it.' });
  });

/** Parse a policy from a form (JSON text) or an object; throws ZodError. */
export const parseCancellationPolicy = (value) =>
  cancellationPolicySchema.parse(typeof value === 'string' ? JSON.parse(value) : value);

const policy = (windows, atOrAfterCheckInPct = 0) => ({
  version: 1,
  windows: windows.map(([hoursBefore, p]) => ({ hoursBefore, pct: p })),
  atOrAfterCheckInPct,
  earlyDeparture: { offered: false, pct: 0 },
});

/** Quick-fill presets. Only the resulting windows are stored. */
export const CANCELLATION_PRESETS = Object.freeze({
  day: {
    flexible: policy([[72, 100], [0, 50]]),
    moderate: policy([[168, 100], [72, 50], [0, 0]]),
    strict: policy([[168, 50], [0, 0]]),
  },
  hour: {
    flexible: policy([[4, 100], [0, 0]]),
    moderate: policy([[24, 100], [6, 50], [0, 0]]),
    strict: policy([[48, 50], [0, 0]]),
  },
  night: {
    flexible: policy([[24, 100], [0, 0]]),
    moderate: policy([[72, 100], [0, 0]]),
    strict: policy([[168, 100], [0, 0]]),
    non_refundable: policy([[0, 0]]),
  },
});

/**
 * The preset family of a booking model. Story 3.10: whole apartments (unit_night) are nightly stays and
 * use the hotel night presets (flexible 24 h, moderate 3 days, strict 7 days, non-refundable), not 'day'.
 */
export const presetFamily = (rentalUnit) =>
  rentalUnit === 'hour' ? 'hour' : rentalUnit === 'night' || rentalUnit === 'unit_night' ? 'night' : 'day';

/** Existing preset tier for a slot, hourly or apartment property. */
export function policyFromTier(tier, rentalUnit) {
  const set = CANCELLATION_PRESETS[rentalUnit === 'night' ? 'day' : presetFamily(rentalUnit)];
  return structuredClone(set[tier] ?? set.moderate);
}

/** Existing hotel rate plan columns: free before the deadline, then nothing (user decision). */
export function policyFromHotelPlan({ freeCancelHours }) {
  return freeCancelHours == null ? policy([[0, 0]]) : policy([[freeCancelHours, 100], [0, 0]]);
}

/** Refund percentage for a request `remainingMs` before check-in (≤ 0 means at or after). */
export function refundPct(policyValue, remainingMs) {
  if (!Number.isFinite(remainingMs)) throw new RangeError('Invalid clock');
  if (remainingMs <= 0) return policyValue.atOrAfterCheckInPct;
  return policyValue.windows.find((w) => remainingMs > w.hoursBefore * 3_600_000)?.pct ?? 0;
}

/** Hours before check-in until which the whole amount comes back, or null when never. */
export function freeCancelHoursOf(policyValue) {
  const free = policyValue.windows.filter((w) => w.pct === 100);
  return free.length ? Math.min(...free.map((w) => w.hoursBefore)) : null;
}

/** The preset name these windows equal, so screens can show it; otherwise 'custom'. */
export function presetName(policyValue, rentalUnit) {
  const set = CANCELLATION_PRESETS[presetFamily(rentalUnit)];
  // Compare values, not JSON text: jsonb does not keep key order.
  const key = (p) => JSON.stringify([p.windows.map((w) => [w.hoursBefore, w.pct]), p.atOrAfterCheckInPct,
    Boolean(p.earlyDeparture?.offered), p.earlyDeparture?.pct ?? 0]);
  return Object.entries(set).find(([, p]) => key(p) === key(policyValue))?.[0] ?? 'custom';
}

/** The listing policy (or hotel default) in force, falling back to its preset tier. */
export function listingCancellationPolicy(listing) {
  const stored = listing.cancellation_policy ?? listing.cancellationPolicy;
  if (stored) return stored;
  const unit = listing.rental_unit ?? listing.rentalUnit;
  return unit === 'night'
    ? structuredClone(CANCELLATION_PRESETS.night.moderate)
    : unit === 'unit_night'
      ? policyFromTier(listing.cancellation_tier ?? listing.cancellationTier ?? 'moderate', unit)
    : policyFromTier(listing.cancellation_tier ?? listing.cancellationTier, unit);
}
