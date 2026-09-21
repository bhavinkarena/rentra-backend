import 'server-only';
import { createHash } from 'node:crypto';
export const bodyHash = value => createHash('sha256').update(value).digest('hex');
export class NotificationError extends Error {
  constructor(code, safeRetry = false) { super(code); this.code = code; this.safeRetry = safeRetry; }
}
export function smsConfiguration(env = process.env) {
  if (env.CUSTOMER_NOTIFICATION_DELIVERY !== 'twilio' || !/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '')
    || !env.TWILIO_AUTH_TOKEN || !/^\+[1-9]\d{7,14}$/.test(env.TWILIO_FROM_NUMBER || '')) throw new NotificationError('SMS_NOT_CONFIGURED', true);
  return { account: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, sender: env.TWILIO_FROM_NUMBER };
}
export function smsAdapter(config, fetcher = fetch) {
  async function request(sid, fields) {
    let response;
    try {
      response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages${sid ? '/' + sid : ''}.json`, {
        method: fields ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Basic ${Buffer.from(config.account + ':' + config.token).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        ...(fields ? { body: new URLSearchParams(fields) } : {}),
      });
    } catch { throw new NotificationError('DELIVERY_OUTCOME_UNKNOWN'); }
    if (!response.ok) throw new NotificationError('CHANNEL_REJECTED', Boolean(fields && response.status >= 400 && response.status < 500 && response.status !== 408));
    try { return await response.json(); } catch { throw new NotificationError('DELIVERY_OUTCOME_UNKNOWN'); }
  }
  function verify(message, expected) {
    if (!/^SM[a-f0-9]{32}$/i.test(message?.sid || '') || message.account_sid !== config.account
      || message.to !== expected.recipient || message.from !== expected.sender || bodyHash(message.body || '') !== expected.body_hash
      || (expected.provider_id && message.sid !== expected.provider_id)) throw new NotificationError('DELIVERY_SCOPE_MISMATCH');
    if (!['accepted','queued','sending','sent','delivered','failed','undelivered','canceled'].includes(message.status)) throw new NotificationError('DELIVERY_STATUS_UNKNOWN');
    return { id: message.sid, state: message.status === 'delivered' ? 'delivered' : ['failed','undelivered','canceled'].includes(message.status) ? 'undelivered' : 'accepted' };
  }
  return { async send(row, body) { return verify(await request(null, { To: row.recipient, From: row.sender, Body: body }), row); },
    async fetch(row) { if (!/^SM[a-f0-9]{32}$/i.test(row.provider_id || '')) throw new NotificationError('INVALID_MESSAGE_ID'); return verify(await request(row.provider_id), row); } };
}
