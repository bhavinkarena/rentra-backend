// Test-only Razorpay transport backed by a JSON file, so a seed process and the disposable
// fixture API share one provider state. Never used outside NODE_ENV=test fixtures.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const load = (path) =>
  existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { counter: 0, orders: {}, payments: {} };

export function fileBackedRazorpay(path) {
  return async (url, init = {}) => {
    const state = load(path);
    const target = new URL(url);
    const route = target.pathname.replace('/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    let reply = null;
    if (route === 'orders' && body) {
      const id = `order_FAKE${++state.counter}`;
      reply = {
        id,
        amount: body.amount,
        currency: 'INR',
        receipt: body.receipt,
        partial_payment: false,
      };
      state.orders[id] = reply;
      writeFileSync(path, JSON.stringify(state));
    } else if (route === 'orders') {
      const receipt = target.searchParams.get('receipt');
      reply = { items: Object.values(state.orders).filter((o) => o.receipt === receipt) };
    } else if (/^orders\/[^/]+\/payments$/.test(route)) {
      reply = {
        items: Object.values(state.payments).filter((p) => p.order_id === route.split('/')[1]),
      };
    } else if (/^payments\/[^/]+\/refund$/.test(route) && body) {
      // CP20: a refund POST. The provider stores it even when the gate drops the response.
      const refund = {
        id: `rfnd_FAKE${++state.counter}`,
        payment_id: route.split('/')[1],
        amount: body.amount,
        currency: 'INR',
        receipt: body.receipt,
        status: 'pending',
      };
      state.refunds = { ...(state.refunds ?? {}), [refund.id]: refund };
      state.refundPosts = [...(state.refundPosts ?? []), body.receipt];
      const drop = (state.dropRefundResponses ?? 0) > 0;
      if (drop) state.dropRefundResponses -= 1;
      writeFileSync(path, JSON.stringify(state));
      reply = drop ? null : refund;
    } else if (/^payments\/[^/]+\/refunds$/.test(route)) {
      reply = {
        items: Object.values(state.refunds ?? {}).filter(
          (r) => r.payment_id === route.split('/')[1],
        ),
      };
    } else if (route.startsWith('refunds/')) {
      reply = state.refunds?.[route.split('/')[1]] ?? null;
    } else if (route.startsWith('payments/')) {
      reply = state.payments[route.split('/')[1]] ?? null;
    }
    return { ok: Boolean(reply), json: async () => reply };
  };
}

/** Record that the provider captured a payment for an order (optionally with a wrong amount). */
export function providerCaptures(path, orderId, paymentId, amount) {
  const state = load(path);
  const order = state.orders[orderId];
  state.payments[paymentId] = {
    id: paymentId,
    order_id: orderId,
    amount: amount ?? order.amount,
    currency: 'INR',
    status: 'captured',
    captured: true,
  };
  writeFileSync(path, JSON.stringify(state));
}
