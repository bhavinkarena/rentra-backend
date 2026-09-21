import 'server-only';
import { randomUUID } from 'node:crypto';
import { withListingInventory, expireInventoryHolds } from '../booking/inventory.js';
import { CheckoutError, lifecycle } from '../booking/checkout.js';
import { quoteDigest } from '../booking/quotes.js';
import { assertPayment } from './razorpay-test.js';

export async function paymentScope(database, paymentId) {
  const [row] = await database`SELECT p.*,b.rentable_id,b.customer_id,e.snapshot,e.credential_key_id,e.config_version,e.state execution_state
    FROM payment_order p JOIN booking_order b ON b.id=p.booking_order_id JOIN payment_execution e ON e.payment_order_id=p.id
    WHERE p.id=${paymentId} AND p.provider='razorpay' AND p.environment='test' AND p.mode='real'`;
  if (!row) throw new CheckoutError('PAYMENT_NOT_FOUND');
  return row;
}

/** Only adapter-fetched evidence reaches this internal writer, never browser bodies. */
export async function settleVerifiedPayment(database, paymentId, payment) {
  const scope = await paymentScope(database, paymentId);
  assertPayment(payment, scope);
  return withListingInventory(database, scope.rentable_id, async (tx, listing) => {
    await expireInventoryHolds(tx, listing.id);
    const [po] = await tx`UPDATE payment_order SET state=state WHERE id=${paymentId} RETURNING *`;
    assertPayment(payment, po);
    const [already] = await tx`SELECT id FROM payment_transaction WHERE provider='razorpay' AND environment='test'
      AND provider_payment_id=${payment.id} AND kind='capture'`;
    if (already) return { captured: true };
    if (po.state === 'succeeded') {
      if (payment.status === 'captured') throw new CheckoutError('EXTRA_CAPTURE_REQUIRES_REVIEW');
      return { captured: true }; // Late failures never downgrade capture.
    }
    if (!['authorized','captured','failed'].includes(payment.status)) return { processing: true };
    const kind = { authorized: 'authorization', captured: 'capture', failed: 'failure' }[payment.status];
    const [fact] = await tx`SELECT id FROM payment_transaction WHERE provider='razorpay' AND environment='test'
      AND external_ledger_id=${payment.id} AND kind=${kind}`;
    if (fact) return { processing: kind !== 'capture' };
    let [attempt] = await tx`SELECT * FROM payment_attempt WHERE payment_order_id=${po.id} AND provider_payment_id=${payment.id}`;
    if (!attempt) {
      [attempt] = await tx`SELECT * FROM payment_attempt WHERE payment_order_id=${po.id} AND provider_payment_id IS NULL ORDER BY attempt_number LIMIT 1`;
      if (attempt) {
        [attempt] = await tx`UPDATE payment_attempt SET provider_payment_id=${payment.id} WHERE id=${attempt.id} RETURNING *`;
      } else {
        // An authorization on another pending attempt stays retryable until its state resolves.
        if (kind === 'authorization') {
          const [active] = await tx`SELECT id FROM payment_attempt WHERE payment_order_id=${po.id} AND state IN ('created','processing','unknown')`;
          if (active) throw new CheckoutError('ANOTHER_ATTEMPT_PENDING');
        }
        const [{ n }] = await tx`SELECT coalesce(max(attempt_number),0)+1 n FROM payment_attempt WHERE payment_order_id=${po.id}`;
        [attempt] = await tx`INSERT INTO payment_attempt(payment_order_id,provider,environment,mode,currency,attempt_number,expected_minor,provider_payment_id,state)
          VALUES(${po.id},'razorpay','test','real','INR',${n},${po.expected_minor},${payment.id},${kind==='capture'?'succeeded':kind==='failure'?'failed':'processing'}) RETURNING *`;
      }
    }
    const evidence = { id: payment.id, orderId: payment.order_id, amount: payment.amount, currency: payment.currency, status: payment.status, captured: payment.captured === true };
    const transactionId = randomUUID();
    await tx`INSERT INTO payment_transaction(id,attempt_id,reference,provider,environment,mode,currency,provider_payment_id,external_ledger_id,
      kind,outcome,expected_minor,authorized_minor,captured_minor,verified_at,evidence_hash)
      VALUES(${transactionId},${attempt.id},${'TEST_' + transactionId},'razorpay','test','real','INR',${payment.id},${payment.id},${kind},
      ${kind==='failure'?'failed':'succeeded'},${po.expected_minor},${kind==='authorization'?po.expected_minor:0},${kind==='capture'?po.expected_minor:0},clock_timestamp(),${quoteDigest(evidence)})`;
    if (kind !== 'capture') {
      // A later authorization cannot resurrect a known failed attempt.
      if (attempt.state !== 'failed' || kind === 'failure') await tx`UPDATE payment_attempt SET state=${kind==='failure'?'failed':'processing'},
        completed_at=CASE WHEN ${kind==='failure'} THEN clock_timestamp() ELSE NULL END WHERE id=${attempt.id}`;
      if (kind === 'authorization' && po.state !== 'succeeded') await tx`UPDATE payment_order SET state='processing' WHERE id=${po.id}`;
      return { processing: kind === 'authorization', failed: kind === 'failure' };
    }
    const visits = await tx`SELECT * FROM booking WHERE order_id=${po.booking_order_id} ORDER BY item_position`;
    const planned = scope.snapshot.allocations;
    if (!Array.isArray(planned) || planned.length !== visits.length) throw new CheckoutError('ALLOCATION_PLAN_MISMATCH');
    const allocations = [];
    for (const visit of visits) {
      const date = visit.local_day instanceof Date ? visit.local_day.toISOString().slice(0,10) : visit.local_day;
      const plan = planned.find(p => p.date === date);
      if (!plan) throw new CheckoutError('ALLOCATION_PLAN_MISMATCH');
      for (const [component, amount] of [['rent',plan.rentMinor],['fee',plan.feeMinor]]) {
        if (!Number.isSafeInteger(amount) || amount < 0) throw new CheckoutError('ALLOCATION_PLAN_MISMATCH');
        const [allocation] = await tx`INSERT INTO payment_allocation(transaction_id,booking_id,component,actual_minor)
          VALUES(${transactionId},${visit.id},${component},${amount}) RETURNING *`;
        allocations.push(allocation);
      }
    }
    await tx`UPDATE payment_attempt SET state='cancelled',completed_at=clock_timestamp() WHERE payment_order_id=${po.id}
      AND id<>${attempt.id} AND state IN ('created','processing','unknown')`;
    await tx`UPDATE payment_attempt SET state='succeeded',completed_at=clock_timestamp() WHERE id=${attempt.id}`;
    await tx`UPDATE payment_order SET state='succeeded' WHERE id=${po.id}`;
    const [order] = await tx`SELECT * FROM booking_order WHERE id=${po.booking_order_id}`;
    const [active] = await tx`SELECT id FROM "user" WHERE id=${order.customer_id} AND role='customer' AND account_status='active' FOR SHARE`;
    const [owner] = await tx`SELECT id FROM "user" WHERE id=${listing.client_id} AND role='client' AND account_status='active' FOR SHARE`;
    const [{ n }] = await tx`SELECT count(*)::int n FROM inventory_reservation WHERE booking_id IN ${tx(visits.map(v=>v.id))} AND state='held'`;
    const [{ now }] = await tx`SELECT clock_timestamp() now`;
    const canConfirm = order.state === 'held' && new Date(order.hold_expires_at) > new Date(now) && listing.status === 'live'
      && active && owner && n === visits.length && visits.every(v=>v.state==='requested');
    if (canConfirm) {
      await tx`UPDATE inventory_reservation SET state='committed',hold_expires_at=NULL WHERE booking_id IN ${tx(visits.map(v=>v.id))} AND state='held'`;
      await tx`UPDATE booking SET state='confirmed',confirmed_at=${now},lifecycle_version=lifecycle_version+1,updated_at=${now} WHERE order_id=${order.id}`;
      await tx`UPDATE booking_order SET state='confirmed',confirmed_at=${now},updated_at=${now} WHERE id=${order.id}`;
      await lifecycle(tx, order.id, 'confirmed', { environment: 'test', testCapturedMinor: Number(po.expected_minor), actualCollectedMinor: 0 });
    } else {
      // Conservative late-capture policy: never reacquire expired inventory.
      await tx`UPDATE inventory_reservation SET state='released',released_at=${now} WHERE booking_id IN ${tx(visits.map(v=>v.id))} AND state='held'`;
      await tx`UPDATE booking SET state='cancelled',cancelled_at=${now},cancellation_reason='Test capture requires resolution',
        lifecycle_version=lifecycle_version+1,updated_at=${now} WHERE order_id=${order.id} AND state='requested'`;
      await tx`UPDATE booking_order SET state='cancelled',updated_at=${now} WHERE id=${order.id} AND state='held'`;
      const refundId = randomUUID();
      await tx`INSERT INTO refund(id,transaction_id,reference,provider,environment,mode,currency,expected_minor,reason,idempotency_key,request_hash)
        VALUES(${refundId},${transactionId},${'TEST_REFUND_' + refundId},'razorpay','test','real','INR',${po.expected_minor},
        'Capture after inventory expiry or account unavailability','late-capture',${quoteDigest({ transactionId, reason:'late-capture' })})`;
      for (const allocation of allocations) await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
        VALUES(${refundId},${allocation.id},${allocation.booking_id},${allocation.component},${allocation.actual_minor})`;
      await lifecycle(tx, order.id, 'refund_required', { refundId, environment:'test', testCapturedMinor:Number(po.expected_minor), actualCollectedMinor:0 });
    }
    // Test captures are kept in the ledger; actual bank-money mirrors stay zero.
    return { captured:true, confirmed:Boolean(canConfirm), needsResolution:!canConfirm };
  });
}
