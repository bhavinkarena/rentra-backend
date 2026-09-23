import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { paymentCredentialStatus } from '../../src/services/payments/provider-credentials.js';
import {
  razorpayTestAdapter,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from '../../src/services/payments/razorpay-test.js';

const env = {
  RAZORPAY_TEST_KEY_ID: 'rzp_test_fixture',
  RAZORPAY_TEST_KEY_SECRET: 'fixture-api-secret',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'fixture-webhook-secret',
};

test('test checkout requires configured credentials and rejects live keys', () => {
  assert.equal(paymentCredentialStatus('razorpay', 'test', env).ready, true);
  assert.equal(
    paymentCredentialStatus('razorpay', 'test', { ...env, RAZORPAY_TEST_WEBHOOK_SECRET: '' }).ready,
    false,
  );
  assert.equal(
    paymentCredentialStatus('razorpay', 'test', {
      ...env,
      RAZORPAY_TEST_KEY_ID: 'rzp_live_fixture',
    }).ready,
    false,
  );
  assert.throws(() => paymentCredentialStatus('razorpay', 'live', env), {
    code: 'UNSUPPORTED_GATEWAY',
  });
});

test('checkout and webhook signatures use separate secrets and reject tampering', () => {
  const signature = createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
    .update('order_fixture|pay_fixture')
    .digest('hex');
  verifyCheckoutSignature('order_fixture', 'pay_fixture', signature, {
    keySecret: env.RAZORPAY_TEST_KEY_SECRET,
  });
  assert.throws(
    () =>
      verifyCheckoutSignature('order_other', 'pay_fixture', signature, {
        keySecret: env.RAZORPAY_TEST_KEY_SECRET,
      }),
    { code: 'INVALID_SIGNATURE' },
  );
  const body = Buffer.from('{"event":"payment.captured"}');
  const signed = createHmac('sha256', env.RAZORPAY_TEST_WEBHOOK_SECRET).update(body).digest('hex');
  verifyWebhookSignature(body, signed, env);
  assert.throws(() => verifyWebhookSignature(Buffer.from('{}'), signed, env), {
    code: 'INVALID_SIGNATURE',
  });
  assert.throws(() => verifyWebhookSignature(body, signature, env), { code: 'INVALID_SIGNATURE' });
});

test('Razorpay order creation uses the server amount and rejects mismatched provider amounts', async () => {
  const expected = { id: 'test-receipt', expected_minor: 540000 };
  let wrongAmount = false;
  const adapter = razorpayTestAdapter(env.RAZORPAY_TEST_KEY_ID, {
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
