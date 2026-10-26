import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateByWeights, refundOfPaid } from '../../src/services/domain/booking-money.js';
import { cancellationEntitlement } from '../../src/services/domain/cancellation.js';

test('Story 2.7 largest remainder: exact, stable, zero-weight and all-zero rules', () => {
  for (let i = 1; i < 300; i++) {
    const weights = Array.from({ length: 1 + (i % 5) }, (_, k) => (k * 7919 + i * 104729) % 50_000);
    const total = (i * 977) % 100_000;
    if (weights.every((w) => w === 0)) continue;
    const parts = allocateByWeights(total, weights);
    assert.equal(
      parts.reduce((a, b) => a + b, 0),
      total,
    );
    parts.forEach((part, k) => {
      if (weights[k] === 0) assert.equal(part, 0, 'zero-price lines get zero');
      const exact = (total * weights[k]) / weights.reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(part - exact) < 1);
    });
  }
  assert.deepEqual(allocateByWeights(2, [5, 5, 5]), [1, 1, 0], 'ties go to the earlier line');
  assert.throws(() => allocateByWeights(1, [0, 0]), /ALLOCATION_WEIGHTS_ZERO/);
  assert.deepEqual(allocateByWeights(0, [0, 0]), [0, 0]);
});

test('Story 2.7 refund basis: the booked percentage of everything paid, owner and Rentra in proportion', () => {
  assert.deepEqual(refundOfPaid({ rent: 100_000, tax: 12_000, fee: 5_000 }, 50), {
    rent: 50_000,
    tax: 6_000,
    fee: 2_500,
  });
  const odd = refundOfPaid({ rent: 33_333, fee: 1_667 }, 33);
  assert.equal(odd.rent + odd.fee, Math.floor((35_000 * 33) / 100));
  assert.deepEqual(refundOfPaid({ rent: 10_000, fee: 500 }, 0), { rent: 0, fee: 0 });

  const visit = {
    policy_snapshot: {
      version: 'customer-v1',
      cancellationTier: 'moderate',
      cancellation: { bands: [[0, 0]], noShow: 0, feeOnFullRefund: false },
      cancellationPolicy: {
        version: 1,
        windows: [
          { hoursBefore: 24, pct: 100 },
          { hoursBefore: 0, pct: 40 },
        ],
        atOrAfterCheckInPct: 0,
        earlyDeparture: { offered: false, pct: 0 },
      },
    },
    hours_known: true,
    starts_at: '2030-01-05T03:30:00Z',
    amount_rent_minor: 100_000,
    amount_fee_minor: 5_000,
    amount_deposit_minor: 20_000,
  };
  const late = cancellationEntitlement(visit, new Date('2030-01-05T00:00:00Z'));
  assert.deepEqual([late.rent, late.fee, late.basis], [40_000, 2_000, 'full_paid']);
  assert.equal(
    late.deposit,
    20_000,
    'the deposit is reported separately; only a captured component can be refunded',
  );
  const early = cancellationEntitlement(visit, new Date('2030-01-03T00:00:00Z'));
  assert.deepEqual([early.rent, early.fee], [100_000, 5_000]);
});

test('Story 2.10 remaining-room allocation skips reserved capacity without consuming entitlement', async () => {
  const { allocateRefund } = await import('../../src/services/booking/cancellation.js');
  const source = (id, actual, reserved) => ({
    id,
    transaction_id: id,
    component: 'rent',
    actual_minor: actual,
    reserved,
  });
  const sources = [
    source('reserved', 100, 100),
    source('available', 150, 25),
    source('last', 90, 0),
  ];
  const entitlement = { rent: 160, fee: 0, deposit: 0, tax: 0 };
  const allocated = allocateRefund(sources, entitlement, { remainingOnly: true });
  assert.deepEqual(
    allocated.map((a) => [a.allocationId, a.amount]),
    [
      ['available', 125],
      ['last', 35],
    ],
  );
  assert.equal(
    allocateRefund(sources, { ...entitlement, rent: 999 }, { remainingOnly: true }).reduce(
      (sum, a) => sum + a.amount,
      0,
    ),
    215,
  );
  assert.deepEqual(
    allocateRefund(sources, { ...entitlement, rent: 0 }, { remainingOnly: true }),
    [],
  );
  assert.deepEqual(
    allocateRefund(sources, entitlement).map((a) => [a.allocationId, a.amount]),
    [['available', 35]],
    'whole-visit entitlement still deducts previous reservations',
  );
});
