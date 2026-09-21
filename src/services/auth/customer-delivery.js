import 'server-only';

/** Fixed code is a local development convenience, never an SMS fallback. */
export function customerDeliveryConfig(env = process.env) {
  const local = ['development', 'test'].includes(env.NODE_ENV);
  const mode = env.CUSTOMER_OTP_DELIVERY || (local ? 'development' : 'disabled');
  if (mode === 'development' && !local) throw new Error('Development customer OTP is disabled outside development/test.');
  if (!['development', 'twilio', 'disabled'].includes(mode)) throw new Error('Invalid customer OTP delivery mode.');
  if (mode === 'twilio' && (!/^AC[0-9a-f]{32}$/i.test(env.TWILIO_ACCOUNT_SID ?? '') || !env.TWILIO_AUTH_TOKEN || !/^\+[1-9]\d{7,14}$/.test(env.TWILIO_FROM_NUMBER ?? ''))) {
    throw new Error('Customer SMS delivery is not configured.');
  }
  return { mode };
}

/** Twilio Messages API. Acceptance is not a claim that the handset received it. */
export async function deliverCustomerCode(phone, code, env = process.env, fetcher = fetch) {
  const { mode } = customerDeliveryConfig(env);
  if (mode === 'development') return;
  if (mode !== 'twilio') throw new Error('Customer SMS delivery is not configured.');
  const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: `+91${phone}`, From: env.TWILIO_FROM_NUMBER, Body: `Your Rentra verification code is ${code}. It expires in 5 minutes. Do not share this code.` }),
  });
  // Never log provider bodies: they can include the phone number and SMS body.
  if (!response.ok) throw new Error('SMS delivery failed.');
  const body = await response.json();
  if (!body.sid || ['failed', 'undelivered', 'canceled'].includes(body.status)) throw new Error('SMS delivery failed.');
}
