import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverPortalCode } from '../../src/services/auth/portal-delivery.js';

const production = {
  NODE_ENV: 'production',
  RESEND_API_KEY: 're_test_key',
  OTP_EMAIL_FROM: 'Rentra <codes@rentra.example>',
  CUSTOMER_OTP_DELIVERY: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
  TWILIO_FROM_NUMBER: '+15005550006',
};
const recorder = (body) => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => body };
  };
  return { calls, fetcher };
};

test('owner email codes are sent through the email provider in production', async () => {
  const { calls, fetcher } = recorder({ id: 'email-1' });
  await deliverPortalCode(
    { identifier: 'owner@example.test', channel: 'email', code: '482913' },
    production,
    fetcher,
  );
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.to, ['owner@example.test']);
  assert.match(sent.text, /482913/);
});

test('owner and caretaker phone codes go out by SMS to the bare Indian number', async () => {
  const { calls, fetcher } = recorder({ sid: 'SM1', status: 'queued' });
  await deliverPortalCode(
    { identifier: 'staff:9876543210', channel: 'sms', code: '111222' },
    production,
    fetcher,
  );
  assert.match(calls[0].url, /api\.twilio\.com/);
  assert.equal(new URLSearchParams(calls[0].init.body).get('To'), '+919876543210');
});

test('a missing provider fails loudly instead of pretending a code was sent', async () => {
  const { fetcher } = recorder({});
  await assert.rejects(
    deliverPortalCode(
      { identifier: 'owner@example.test', channel: 'email', code: '1' },
      { NODE_ENV: 'production' },
      fetcher,
    ),
    /email delivery is not configured/i,
  );
});

test('outside production nothing is sent', async () => {
  const { calls, fetcher } = recorder({});
  await deliverPortalCode(
    { identifier: 'owner@example.test', channel: 'email', code: '1' },
    { NODE_ENV: 'development' },
    fetcher,
    () => {},
  );
  assert.equal(calls.length, 0);
});

test('payout confirmation identifies the money change in both delivery channels', async () => {
  for (const channel of ['email', 'sms']) {
    const { calls, fetcher } = recorder({ sid: 'SM1', status: 'queued' });
    await deliverPortalCode(
      {
        identifier: channel === 'email' ? 'owner@example.test' : '9876543210',
        channel,
        code: '482913',
        purpose: 'payout_confirm',
      },
      production,
      fetcher,
    );
    const message =
      channel === 'email'
        ? JSON.parse(calls[0].init.body).text
        : new URLSearchParams(calls[0].init.body).get('Body');
    assert.match(message, /confirm a payout method change/);
    assert.match(message, /10 minutes/);
    assert.doesNotMatch(message, /sign-in/);
  }
});
