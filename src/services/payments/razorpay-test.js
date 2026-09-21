import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requirePaymentCredentials } from './provider-credentials.js';

export class ProviderError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'ProviderError'; }
}
export function pinnedCredentials(keyId, env = process.env) {
  if (!/^rzp_test_[A-Za-z0-9]+$/.test(keyId)) throw new ProviderError('TEST_CREDENTIAL_REQUIRED');
  if (keyId === env.RAZORPAY_TEST_KEY_ID?.trim()) return requirePaymentCredentials('razorpay', 'test', env);
  let ring;
  try { ring = JSON.parse(env.RAZORPAY_TEST_KEYRING_JSON ?? '{}'); } catch { throw new ProviderError('INVALID_TEST_KEYRING'); }
  if (!Object.hasOwn(ring, keyId) || typeof ring[keyId]?.keySecret !== 'string' || !ring[keyId].keySecret) throw new ProviderError('PINNED_CREDENTIAL_MISSING');
  return { keyId, keySecret: ring[keyId].keySecret };
}
export function validSignature(body, signature, secret) {
  if (typeof secret !== 'string' || !secret || !/^[a-fA-F0-9]{64}$/.test(signature ?? '')) return false;
  return timingSafeEqual(createHmac('sha256', secret).update(body).digest(), Buffer.from(signature, 'hex'));
}
export function verifyWebhookSignature(body, signature, env = process.env) {
  let old;
  try { old = JSON.parse(env.RAZORPAY_TEST_PREVIOUS_WEBHOOK_SECRETS ?? '[]'); } catch { throw new ProviderError('INVALID_WEBHOOK_KEYS'); }
  if (!Array.isArray(old) || old.length > 10 || old.some(s => typeof s !== 'string')) throw new ProviderError('INVALID_WEBHOOK_KEYS');
  const secrets = [env.RAZORPAY_TEST_WEBHOOK_SECRET, ...old].filter(Boolean);
  if (!secrets.length) throw new ProviderError('WEBHOOK_NOT_CONFIGURED');
  if (!secrets.some(secret => validSignature(body, signature, secret))) throw new ProviderError('INVALID_SIGNATURE');
}
export function verifyCheckoutSignature(orderId, paymentId, signature, credentials) {
  if (!validSignature(`${orderId}|${paymentId}`, signature, credentials.keySecret)) throw new ProviderError('INVALID_SIGNATURE');
}
export function assertOrder(order, expected) {
  if (!/^order_[A-Za-z0-9]+$/.test(order?.id ?? '') || order.amount !== Number(expected.expected_minor)
    || order.currency !== 'INR' || order.receipt !== expected.id || order.partial_payment === true
    || (expected.provider_order_id && order.id !== expected.provider_order_id)) throw new ProviderError('PROVIDER_ORDER_MISMATCH');
  return order;
}
export function assertPayment(payment, expected) {
  if (!/^pay_[A-Za-z0-9]+$/.test(payment?.id ?? '') || payment.order_id !== expected.provider_order_id
    || payment.amount !== Number(expected.expected_minor) || payment.currency !== 'INR'
    || !['created','authorized','captured','failed','refunded'].includes(payment.status)
    || (payment.status === 'captured' && payment.captured !== true)) throw new ProviderError('PROVIDER_PAYMENT_MISMATCH');
  if (payment.amount_refunded > 0 || payment.status === 'refunded') throw new ProviderError('UNEXPECTED_PROVIDER_REFUND');
  return payment;
}

export function assertRefund(refund, expected) {
  if (!/^rfnd_[A-Za-z0-9]+$/.test(refund?.id ?? '') || refund.payment_id !== expected.provider_payment_id
    || refund.amount !== Number(expected.expected_minor) || refund.currency !== 'INR' || refund.receipt !== expected.id
    || !['pending','processed','failed'].includes(refund.status)
    || (expected.provider_refund_id && refund.id !== expected.provider_refund_id)) throw new ProviderError('PROVIDER_REFUND_MISMATCH');
  return refund;
}

/** Fixed host and TEST key only. Transport injection belongs exclusively to server tests. */
export function razorpayTestAdapter(keyId, { env = process.env, fetcher = fetch } = {}) {
  const credentials = pinnedCredentials(keyId, env);
  async function request(path, body) {
    let response;
    try {
      response = await fetcher(`https://api.razorpay.com/v1/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error('provider response');
      return await response.json();
    } catch { throw new ProviderError('PROVIDER_OUTCOME_UNKNOWN'); }
  }
  return {
    credentials,
    async createRefund(expected) {
      if (!/^pay_[A-Za-z0-9]+$/.test(expected.provider_payment_id ?? '')) throw new ProviderError('INVALID_PAYMENT_ID');
      return assertRefund(await request(`payments/${expected.provider_payment_id}/refund`, {
        amount:Number(expected.expected_minor),speed:'normal',receipt:expected.id,
      }),expected);
    },
    async findRefund(expected) {
      if (!/^pay_[A-Za-z0-9]+$/.test(expected.provider_payment_id ?? '')) throw new ProviderError('INVALID_PAYMENT_ID');
      if (expected.provider_refund_id) {
        if (!/^rfnd_[A-Za-z0-9]+$/.test(expected.provider_refund_id)) throw new ProviderError('INVALID_REFUND_ID');
        return assertRefund(await request(`refunds/${expected.provider_refund_id}`),expected);
      }
      const exact=[];
      for(let skip=0;skip<1000;skip+=100) {
        const page=await request(`payments/${expected.provider_payment_id}/refunds?count=100&skip=${skip}`);
        if(!Array.isArray(page.items)) throw new ProviderError('REFUND_LOOKUP_AMBIGUOUS');
        exact.push(...page.items.filter(item=>item.receipt===expected.id));
        if(exact.length>1) throw new ProviderError('REFUND_LOOKUP_AMBIGUOUS');
        if(page.items.length<100) return exact.length?assertRefund(exact[0],expected):null;
      }
      throw new ProviderError('REFUND_LOOKUP_AMBIGUOUS');
    },
    async createOrder(expected) {
      return assertOrder(await request('orders', { amount: Number(expected.expected_minor), currency: 'INR', receipt: expected.id, partial_payment: false }), expected);
    },
    async findOrder(expected) {
      const result = await request(`orders?receipt=${encodeURIComponent(expected.id)}&count=100`);
      if (!Array.isArray(result.items) || result.items.length >= 100) throw new ProviderError('ORDER_LOOKUP_AMBIGUOUS');
      const exact = result.items.filter(order => order.receipt === expected.id);
      if (exact.length > 1) throw new ProviderError('ORDER_LOOKUP_AMBIGUOUS');
      return exact.length ? assertOrder(exact[0], expected) : null;
    },
    async payment(paymentId, expected) {
      if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new ProviderError('INVALID_PAYMENT_ID');
      const result = assertPayment(await request(`payments/${paymentId}`), expected);
      if (result.id !== paymentId) throw new ProviderError('PROVIDER_PAYMENT_MISMATCH');
      return result;
    },
    async payments(expected) {
      if (!/^order_[A-Za-z0-9]+$/.test(expected.provider_order_id ?? '')) throw new ProviderError('INVALID_ORDER_ID');
      const result = await request(`orders/${expected.provider_order_id}/payments`);
      if (!Array.isArray(result.items)) throw new ProviderError('PROVIDER_PAYMENT_MISMATCH');
      return result.items.map(payment => assertPayment(payment, expected));
    },
  };
}
