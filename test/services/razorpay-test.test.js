import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { paymentCredentialStatus } from '../../src/services/payments/provider-credentials.js';
import {
  razorpayTestAdapter,
  pinnedCredentials,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../../src/services/payments/razorpay-test.js';

const env = {
  RAZORPAY_KEY_ID: 'rzp_test_fixture',
  RAZORPAY_KEY_SECRET: 'fixture-api-secret',
  RAZORPAY_WEBHOOK_SECRET: 'fixture-webhook-secret',
};

test('sandbox checkout reads standard credential names and requires matching sandbox values', () => {
  assert.equal(paymentCredentialStatus('razorpay', 'test', env).ready, true);
  const obsoleteNamespace = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name.replace('RAZORPAY_', 'RAZORPAY_' + 'TEST_'),
      value,
    ]),
  );
  assert.equal(paymentCredentialStatus('razorpay', 'test', obsoleteNamespace).ready, false);
  assert.equal(
    paymentCredentialStatus('razorpay', 'test', { ...env, RAZORPAY_WEBHOOK_SECRET: '' }).ready,
    false,
  );
  assert.equal(
    paymentCredentialStatus('razorpay', 'test', {
      ...env,
      RAZORPAY_KEY_ID: 'rzp_live_fixture',
    }).ready,
    false,
  );
  assert.throws(() => paymentCredentialStatus('razorpay', 'live', env), {
    code: 'UNSUPPORTED_GATEWAY',
  });
});

test('standard names support pinned API key and webhook secret rotation', () => {
  const rotated = {
    ...env,
    RAZORPAY_KEY_ID: 'rzp_test_newfixture',
    RAZORPAY_KEY_SECRET: 'new-api-secret',
    RAZORPAY_WEBHOOK_SECRET: 'new-webhook-secret',
    RAZORPAY_KEYRING_JSON: JSON.stringify({
      [env.RAZORPAY_KEY_ID]: { keySecret: env.RAZORPAY_KEY_SECRET },
    }),
    RAZORPAY_PREVIOUS_WEBHOOK_SECRETS: JSON.stringify([env.RAZORPAY_WEBHOOK_SECRET]),
  };
  assert.equal(pinnedCredentials(env.RAZORPAY_KEY_ID, env).keySecret, env.RAZORPAY_KEY_SECRET);
  assert.equal(pinnedCredentials(env.RAZORPAY_KEY_ID, rotated).keySecret, env.RAZORPAY_KEY_SECRET);
  assert.equal(pinnedCredentials(rotated.RAZORPAY_KEY_ID, rotated).keySecret, 'new-api-secret');
  assert.throws(() => pinnedCredentials('rzp_test_missing', rotated), {
    code: 'PINNED_CREDENTIAL_MISSING',
  });
  const body = Buffer.from('{"event":"payment.captured"}');
  const signature = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  verifyWebhookSignature(body, signature, rotated);
  assert.throws(
    () => verifyWebhookSignature(body, signature, { ...env, RAZORPAY_WEBHOOK_SECRET: '' }),
    {
      code: 'WEBHOOK_NOT_CONFIGURED',
    },
  );
});

test('checkout and webhook signatures use separate secrets and reject tampering', () => {
  const signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update('order_fixture|pay_fixture')
    .digest('hex');
  verifyCheckoutSignature('order_fixture', 'pay_fixture', signature, {
    keySecret: env.RAZORPAY_KEY_SECRET,
  });
  assert.throws(
    () =>
      verifyCheckoutSignature('order_other', 'pay_fixture', signature, {
        keySecret: env.RAZORPAY_KEY_SECRET,
      }),
    { code: 'INVALID_SIGNATURE' },
  );
  const body = Buffer.from('{"event":"payment.captured"}');
  const signed = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  verifyWebhookSignature(body, signed, env);
  assert.throws(() => verifyWebhookSignature(Buffer.from('{}'), signed, env), {
    code: 'INVALID_SIGNATURE',
  });
  assert.throws(() => verifyWebhookSignature(body, signature, env), { code: 'INVALID_SIGNATURE' });
});

test('Razorpay order creation uses the server amount and rejects mismatched provider amounts', async () => {
  const expected = { id: 'test-receipt', expected_minor: 540000 };
  let wrongAmount = false;
  const adapter = razorpayTestAdapter(env.RAZORPAY_KEY_ID, {
    env,
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.razorpay.com/v1/orders');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.amount, expected.expected_minor);
      assert.equal(body.currency, 'INR');
      assert.equal(body.receipt, expected.id);
      return Response.json({
        id: 'order_fixture',
        amount: wrongAmount ? 100 : body.amount,
        currency: 'INR',
        receipt: body.receipt,
        partial_payment: false,
      });
    },
  });
  assert.equal((await adapter.createOrder(expected)).id, 'order_fixture');
  wrongAmount = true;
  await assert.rejects(adapter.createOrder(expected), { code: 'PROVIDER_ORDER_MISMATCH' });
});
