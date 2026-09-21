import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

/**
 * The webhook is the one route that does NOT answer in the house envelope, and
 * that is deliberate: Razorpay reads the status code and retries on 5xx. So
 * the contract asserted here is the status codes, and the rule that decides
 * them —
 *
 *   4xx = "this event is not valid, stop retrying"
 *   5xx = "we could not store it, please retry"
 *
 * Inverting those either replays a forged event forever or silently drops a
 * real payment, which is why a missing webhook secret is 503 and not 400: we
 * cannot tell whether the event was genuine, so we must not discard it.
 */
const SECRET = 'test-webhook-secret-for-signature-checks';

let server;
let base;

before(async () => {
  process.env.RAZORPAY_TEST_WEBHOOK_SECRET = SECRET;
  const { createApp } = await import('@/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/webhooks/razorpay`;
});

after(async () => {
  server?.close();
  const { sql } = await import('@/config/database.js');
  await sql.end({ timeout: 5 }).catch(() => {});
});

const sign = (body) => createHmac('sha256', SECRET).update(body).digest('hex');

const post = (body, headers = {}) =>
  fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

test('an empty body is rejected without reaching the database', async () => {
  const response = await post('');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid event');
});

test('a wrong signature is 400 — stop retrying, this is not from Razorpay', async () => {
  const body = JSON.stringify({ event: 'payment.captured' });
  const response = await post(body, {
    'x-razorpay-signature': 'deadbeef',
    'x-razorpay-event-id': 'evt_test_wrong_sig',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Invalid event');
});

test('a correct signature over a malformed payload is still 400', async () => {
  /** Signed by us, so authentic — but it carries no usable payment entity. */
  const body = JSON.stringify({ event: 'payment.captured', payload: {} });
  const response = await post(body, {
    'x-razorpay-signature': sign(body),
    'x-razorpay-event-id': 'evt_test_malformed',
  });

  assert.equal(response.status, 400);
});

test('an oversized body is refused before any signature work', async () => {
  const body = 'x'.repeat(300 * 1024);
  const response = await post(body, {
    'x-razorpay-signature': sign(body),
    'x-razorpay-event-id': 'evt_test_huge',
  });

  assert.ok(response.status === 413 || response.status === 400, `got ${response.status}`);
});

test('the webhook never answers in the house envelope', async () => {
  const body = JSON.stringify({ event: 'payment.captured' });
  const payload = await (
    await post(body, { 'x-razorpay-signature': 'nope', 'x-razorpay-event-id': 'evt_test_shape' })
  ).json();

  /** Razorpay reads the status, not the body; adding our envelope here would be noise. */
  assert.ok(!('statusCode' in payload));
  assert.ok(!('success' in payload));
});
