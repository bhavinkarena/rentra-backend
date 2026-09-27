import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateAdditionalRefund, refundStatus } from '@/services/domain/refund-status.js';

const base = { provider: 'razorpay', environment: 'test', mode: 'real' };

test('only a verified provider outcome reads as refunded', () => {
  assert.equal(refundStatus({ ...base, state: 'succeeded' }).key, 'refunded');
  assert.equal(refundStatus({ ...base, state: 'requested' }).command, 'send');
  assert.equal(refundStatus({ ...base, state: 'processing', dispatchedAt: 'x' }).key, 'processing');
  assert.equal(
    refundStatus({
      ...base,
      state: 'unknown',
      dispatchedAt: 'x',
      failureCode: 'PROVIDER_OUTCOME_UNKNOWN',
    }).key,
    'uncertain',
  );
  const failed = refundStatus({
    ...base,
    state: 'unknown',
    dispatchedAt: 'x',
    failureCode: 'PROVIDER_REFUND_FAILED',
  });
  assert.equal(failed.key, 'provider_failed');
  assert.equal(failed.command, 'check', 'a failed provider refund is checked, never resent');
  assert.equal(
    refundStatus({ provider: 'razorpay', environment: 'live', mode: 'real', state: 'requested' })
      .command,
    null,
  );
  assert.equal(refundStatus({ ...base, mode: 'simulated', state: 'requested' }).key, 'simulated');
});

test('additional refunds never exceed what earlier obligations left', () => {
  const sources = [
    {
      id: 'a1',
      transaction_id: 't1',
      component: 'rent',
      actual_minor: '100000',
      reserved: '60000',
    },
    { id: 'a2', transaction_id: 't1', component: 'fee', actual_minor: '8000', reserved: '0' },
  ];
  assert.deepEqual(allocateAdditionalRefund(sources, { rent: 40000, fee: 8000 }), {
    lines: [
      { allocationId: 'a1', transactionId: 't1', component: 'rent', amount: 40000 },
      { allocationId: 'a2', transactionId: 't1', component: 'fee', amount: 8000 },
    ],
    exceeded: {},
  });
  assert.deepEqual(allocateAdditionalRefund(sources, { rent: 40001 }).exceeded, { rent: 40000 });
  assert.deepEqual(allocateAdditionalRefund(sources, { deposit: 1 }).exceeded, { deposit: 0 });
});
