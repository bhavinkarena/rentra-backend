import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  caseEntitlement,
  caseReference,
  createdAudience,
  defaultRefundBasis,
  uncancellableReason,
  visibleTo,
} from '../../src/services/domain/booking-cases.js';

const now = '2026-09-27T06:00:00.000Z';
const visit = (extra = {}) => ({
  state: 'confirmed',
  hours_known: true,
  starts_at: '2026-10-07T03:30:00.000Z',
  amount_rent_minor: 100000,
  amount_fee_minor: 8000,
  amount_deposit_minor: 0,
  policy_snapshot: {
    version: 'customer-v1',
    cancellationTier: 'strict',
    cancellation: {
      bands: [
        [7, 0.5],
        [0, 0],
      ],
      noShow: 0,
      feeOnFullRefund: false,
    },
  },
  ...extra,
});

test('CP14 update audiences never leak across owner and customer', () => {
  assert.equal(visibleTo('admin', 'internal'), true);
  assert.deepEqual(
    ['internal', 'client', 'customer', 'everyone'].map((a) => visibleTo('owner', a)),
    [false, true, false, true],
  );
  assert.deepEqual(
    ['internal', 'client', 'customer', 'everyone'].map((a) => visibleTo('customer', a)),
    [false, false, true, true],
  );
  assert.equal(visibleTo('stranger', 'everyone'), false);
  assert.equal(createdAudience('owner'), 'client');
  assert.equal(createdAudience('customer'), 'customer');
  assert.equal(createdAudience('admin'), 'internal');
  assert.match(caseReference('0f8e9d2c-1234-4abc-8def-001122334455'), /^CASE-0F8E9D2C12$/);
});

test('CP14 cancellable visits are confirmed, reconciled and not yet started', () => {
  assert.equal(uncancellableReason(visit(), now), null);
  assert.match(uncancellableReason(visit({ state: 'cancelled' }), now), /Already cancelled/);
  assert.match(uncancellableReason(visit({ state: 'requested' }), now), /payment/);
  assert.match(uncancellableReason(visit({ state: 'handed_over' }), now), /handed over/);
  assert.match(uncancellableReason(visit({ hours_known: false }), now), /reconciliation/);
  assert.match(uncancellableReason(visit({ starts_at: now }), now), /started/);
});

test('CP14 refund basis: policy applies the accepted snapshot, full returns every component', () => {
  assert.equal(defaultRefundBasis('owner_cancellation'), 'full');
  assert.equal(defaultRefundBasis('change_request'), 'policy');
  const policy = caseEntitlement(visit(), 'policy', now);
  assert.deepEqual(
    { rent: policy.rent, fee: policy.fee, rate: policy.rate },
    { rent: 50000, fee: 0, rate: 0.5 },
  );
  const full = caseEntitlement(visit(), 'full', now);
  assert.deepEqual(
    { rent: full.rent, fee: full.fee, deposit: full.deposit, rate: full.rate },
    { rent: 100000, fee: 8000, deposit: 0, rate: 1 },
  );
  assert.throws(
    () => caseEntitlement(visit({ policy_snapshot: null }), 'policy', now),
    /POLICY_UNSUPPORTED/,
  );
  assert.throws(() => caseEntitlement(visit(), 'generous', now), /BASIS_UNSUPPORTED/);
});
