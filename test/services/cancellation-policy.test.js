import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCELLATION_PRESETS,
  parseCancellationPolicy,
  policyFromHotelPlan,
  policyFromTier,
  presetName,
  refundPct,
  freeCancelHoursOf,
} from '../../src/services/domain/cancellation-policy.js';

const H = 3_600_000;

test('Story 2.6 windows: contiguous, percentage-only, at/after equality, after check-in', () => {
  const p = parseCancellationPolicy({
    windows: [{ hoursBefore: 168, pct: 100 }, { hoursBefore: 72, pct: 50 }, { hoursBefore: 0, pct: 10 }],
    atOrAfterCheckInPct: 0,
    earlyDeparture: { offered: true, pct: 0 },
  });
  assert.equal(refundPct(p, 168 * H + 1), 100);
  assert.equal(refundPct(p, 168 * H), 50, 'exactly at the cutoff the later window applies');
  assert.equal(refundPct(p, 72 * H + 1), 50);
  assert.equal(refundPct(p, 72 * H), 10);
  assert.equal(refundPct(p, 1), 10);
  assert.equal(refundPct(p, 0), 0, 'at check-in');
  assert.equal(refundPct(p, -5 * H), 0, 'after check-in');
  assert.equal(p.earlyDeparture.pct, 0, 'early departure may be offered at 0%');
  assert.equal(freeCancelHoursOf(p), 168);
});

test('Story 2.6 validation: gaps, overlaps, order, limits and amounts refused', () => {
  const bad = [
    { windows: [{ hoursBefore: 24, pct: 100 }] }, // does not reach check-in
    { windows: [{ hoursBefore: 0, pct: 100 }, { hoursBefore: 24, pct: 50 }] }, // ascending
    { windows: [{ hoursBefore: 24, pct: 100 }, { hoursBefore: 24, pct: 50 }, { hoursBefore: 0, pct: 0 }] }, // duplicate cutoff
    { windows: [{ hoursBefore: 900, pct: 100 }, { hoursBefore: 0, pct: 0 }] }, // over 720 h
    { windows: [{ hoursBefore: 0, pct: 120 }] }, // not a percentage
    { windows: [{ hoursBefore: 0, pct: '' }] }, // blank is not 0%
    { windows: Array.from({ length: 7 }, (_, i) => ({ hoursBefore: 6 - i, pct: 0 })) }, // over 6 windows
  ];
  for (const value of bad) assert.throws(() => parseCancellationPolicy(value), undefined, JSON.stringify(value));
});

test('Story 2.6 migration mapping: tiers and hotel plans become windows; presets are quick-fill only', () => {
  assert.deepEqual(policyFromTier('moderate', 'slot'), CANCELLATION_PRESETS.day.moderate);
  assert.equal(refundPct(policyFromTier('moderate', 'slot'), 100 * H), 50);
  assert.equal(refundPct(policyFromTier('strict', 'hour'), 49 * H), 50);
  assert.deepEqual(policyFromHotelPlan({ freeCancelHours: 24 }).windows, [
    { hoursBefore: 24, pct: 100 },
    { hoursBefore: 0, pct: 0 },
  ]);
  assert.equal(refundPct(policyFromHotelPlan({ freeCancelHours: null }), 500 * H), 0);
  assert.equal(presetName(CANCELLATION_PRESETS.night.non_refundable, 'night'), 'non_refundable');
  const edited = structuredClone(CANCELLATION_PRESETS.day.flexible);
  edited.windows[1].pct = 40;
  assert.equal(presetName(edited, 'slot'), 'custom');
});
