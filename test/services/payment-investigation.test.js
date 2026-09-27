import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskKeyId, paymentStatus } from '../../src/services/domain/payment-investigation.js';

const base = {
  provider: 'razorpay',
  environment: 'test',
  mode: 'real',
  state: 'processing',
  executionState: 'linked',
  capturedMinor: 0,
  refundedMinor: 0,
  refundPendingMinor: 0,
};

test('CP19 key ids are masked to their tail; nothing else passes through', () => {
  assert.equal(maskKeyId('rzp_test_AbCdEf1234'), 'rzp_test_…1234');
  assert.equal(maskKeyId('rzp_live_ZZZZ9876'), 'rzp_live_…9876');
  assert.equal(maskKeyId('secret-looking-value'), 'masked');
  assert.equal(maskKeyId(null), null);
});

test('CP19 status: only unresolved Test provider outcomes can be re-fetched', () => {
  const awaiting = paymentStatus(base);
  assert.deepEqual(
    [awaiting.key, awaiting.reconcilable, awaiting.attention],
    ['awaiting_provider', true, true],
  );
  assert.equal(
    paymentStatus({ ...base, executionState: 'ready', state: 'created' }).key,
    'not_started',
  );
  assert.equal(
    paymentStatus({ ...base, executionState: 'ready', state: 'created' }).reconcilable,
    false,
  );
  assert.equal(paymentStatus({ ...base, environment: 'live' }).reconcilable, false);
  const sim = paymentStatus({
    ...base,
    provider: 'dummy',
    environment: 'simulated',
    mode: 'simulated',
    state: 'succeeded',
    executionState: null,
  });
  assert.deepEqual([sim.key, sim.reconcilable], ['simulated', false]);
  assert.equal(paymentStatus({ ...base, mode: 'legacy_unknown' }).key, 'legacy');
});

test('CP19 status: captured payments describe refunds honestly', () => {
  const done = { ...base, state: 'succeeded', capturedMinor: 1000 };
  assert.deepEqual(
    [paymentStatus(done).key, paymentStatus(done).reconcilable, paymentStatus(done).attention],
    ['settled', false, false],
  );
  assert.equal(paymentStatus({ ...done, refundPendingMinor: 500 }).key, 'refund_pending');
  assert.equal(paymentStatus({ ...done, refundedMinor: 1000 }).key, 'refunded');
  const uncertain = paymentStatus({ ...done, refundsUncertain: 1 });
  assert.deepEqual([uncertain.key, uncertain.attention], ['needs_review', true]);
  assert.equal(paymentStatus({ ...base, state: 'failed', executionState: 'linked' }).key, 'closed');
  assert.equal(paymentStatus({ ...done, eventsFailed: 1 }).attention, true);
});
