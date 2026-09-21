import 'server-only';
import { z } from 'zod';
import { ownedCheckout, checkoutStatus, CheckoutError, readCheckoutStatus } from '../booking/checkout.js';
import { withListingInventory } from '../booking/inventory.js';
import { revalidateHeldQuoteTerms } from '../booking/quotes.js';
import { requireNewPaymentConfiguration, resolvePinnedPaymentConfiguration } from './gateway-settings.js';
import { registeredPaymentProvider } from './provider-registry.js';
import { razorpayTestAdapter, assertOrder, verifyCheckoutSignature } from './razorpay-test.js';
import { paymentScope, settleVerifiedPayment } from './settlement.js';

function adapter(scope, options) {
  registeredPaymentProvider(scope.provider, scope.environment);
  return razorpayTestAdapter(scope.credential_key_id, options);
}
async function linkOrder(database, scope, remote) {
  assertOrder(remote, scope);
  return withListingInventory(database, scope.rentable_id, async tx => {
    const [po] = await tx`UPDATE payment_order SET state=state WHERE id=${scope.id} RETURNING *`;
    assertOrder(remote, po);
    await tx`UPDATE payment_order SET provider_order_id=${remote.id},state=CASE WHEN state='succeeded' THEN state ELSE 'processing' END WHERE id=${po.id}`;
    await tx`UPDATE payment_execution SET state='linked',failure_code=NULL,updated_at=clock_timestamp() WHERE payment_order_id=${po.id}`;
  });
}

/** First POST is claimed durably once. A timeout/crash always enters lookup, never another POST. */
export async function startCheckoutPayment(database, session, orderId, options = {}) {
  const env = options.env ?? process.env;
  const prepared = await ownedCheckout(database, session, orderId, async (tx, order, listing) => {
    const scope = await paymentScope(tx, (await checkoutStatus(tx, orderId)).paymentOrderId);
    await resolvePinnedPaymentConfiguration(tx, scope.snapshot);
    if (scope.execution_state !== 'ready') return { scope, send:false };
    await tx`SELECT pg_advisory_xact_lock(73420,1)`;
    await requireNewPaymentConfiguration(tx, { expectedVersion:scope.config_version }, env);
    const [current] = await tx`SELECT state,hold_expires_at>clock_timestamp() active FROM booking_order WHERE id=${orderId}`;
    if (current.state !== 'held' || !current.active) throw new CheckoutError('HOLD_EXPIRED');
    await revalidateHeldQuoteTerms(tx, listing, order, env);
    adapter(scope, options); // Validate pinned credentials before reserving the external dispatch.
    await tx`INSERT INTO payment_attempt(payment_order_id,provider,environment,mode,currency,attempt_number,expected_minor,state)
      VALUES(${scope.id},'razorpay','test','real','INR',1,${scope.expected_minor},'processing')`;
    await tx`UPDATE payment_order SET state='processing' WHERE id=${scope.id}`;
    await tx`UPDATE payment_execution SET state='dispatched',next_check_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE payment_order_id=${scope.id}`;
    return { scope, send:true };
  }, env);
  if (prepared.send) {
    try {
      const remote = await adapter(prepared.scope, options).createOrder(prepared.scope);
      await linkOrder(database, prepared.scope, remote);
    } catch {
      await database`UPDATE payment_execution SET state='unknown',failure_code='PROVIDER_OUTCOME_UNKNOWN',updated_at=clock_timestamp()
        WHERE payment_order_id=${prepared.scope.id} AND state='dispatched'`;
      // Includes a lost DB response after a successful link. Status below reads the durable outcome.
    }
  }
  return readCheckoutStatus(database, session, orderId, env);
}

/** Internal worker path; pinned credentials/config survive the new-checkout admin toggle. */
export async function reconcilePayment(database, paymentId, options = {}) {
  let scope = await paymentScope(database, paymentId);
  await resolvePinnedPaymentConfiguration(database, scope.snapshot);
  if (scope.execution_state === 'ready' || scope.state === 'succeeded') return;
  const provider = adapter(scope, options);
  if (!scope.provider_order_id) {
    const remote = await provider.findOrder(scope);
    if (!remote) throw new CheckoutError('PROVIDER_OUTCOME_UNKNOWN');
    await linkOrder(database, scope, remote);
    scope = await paymentScope(database, paymentId);
  }
  const payments = await provider.payments(scope);
  // Capture has precedence even when provider collections arrive out of order.
  payments.sort((a,b)=>Number(b.status==='captured')-Number(a.status==='captured'));
  for (const payment of payments) await settleVerifiedPayment(database, paymentId, payment);
}

export async function verifyCheckoutPayment(database, session, input, options = {}) {
  const value = z.object({ orderId:z.string().uuid(), paymentId:z.string().regex(/^pay_[A-Za-z0-9]+$/),
    signature:z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict().parse(input);
  const status = await readCheckoutStatus(database, session, value.orderId, options.env ?? process.env);
  const scope = await paymentScope(database, status.paymentOrderId);
  await resolvePinnedPaymentConfiguration(database, scope.snapshot);
  if (!scope.provider_order_id) throw new CheckoutError('PROVIDER_ORDER_PENDING');
  const provider = adapter(scope, options);
  // The order ID is always loaded from the server, never trusted from Checkout.
  verifyCheckoutSignature(scope.provider_order_id, value.paymentId, value.signature, provider.credentials);
  const [captured] = await database`SELECT id FROM payment_transaction WHERE provider='razorpay' AND environment='test' AND provider_payment_id=${value.paymentId} AND kind='capture' AND outcome='succeeded' AND verified_at IS NOT NULL AND attempt_id IN (SELECT id FROM payment_attempt WHERE payment_order_id=${scope.id})`;
  if(captured) return readCheckoutStatus(database, session, value.orderId, options.env ?? process.env);
  const payment = await provider.payment(value.paymentId, scope);
  await settleVerifiedPayment(database, scope.id, payment);
  return readCheckoutStatus(database, session, value.orderId, options.env ?? process.env);
}
