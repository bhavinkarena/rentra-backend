import 'server-only';
import { withListingInventory } from '../booking/inventory.js';
import { lifecycle } from '../booking/checkout.js';
import { quoteDigest } from '../booking/quotes.js';
import { razorpayTestAdapter, assertRefund, ProviderError } from './razorpay-test.js';
import { resolvePinnedPaymentConfiguration } from './gateway-settings.js';

async function refundScope(database,id) {
  const [row]=await database`SELECT r.*,t.provider_payment_id,b.rentable_id,b.id order_id,e.credential_key_id,e.snapshot
    FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id
    JOIN payment_order p ON p.id=a.payment_order_id JOIN payment_execution e ON e.payment_order_id=p.id
    JOIN booking_order b ON b.id=p.booking_order_id
    WHERE r.id=${id} AND r.provider='razorpay' AND r.environment='test' AND r.mode='real'
      AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL`;
  if(!row) throw new ProviderError('REFUND_NOT_FOUND');
  return row;
}
export async function reconcileRefund(database,id,options={}) {
  const scope=await refundScope(database,id);
  if(scope.state==='succeeded') return;
  await resolvePinnedPaymentConfiguration(database,scope.snapshot);
  const provider=razorpayTestAdapter(scope.credential_key_id,options);
  const send=await withListingInventory(database,scope.rentable_id,async tx=>{
    await tx`INSERT INTO refund_execution(refund_id) VALUES(${id}) ON CONFLICT DO NOTHING`;
    // One durable claim: missing/failed network responses are lookup-only forever.
    const [claimed]=await tx`UPDATE refund_execution SET dispatched_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '1 minute'
      WHERE refund_id=${id} AND dispatched_at IS NULL RETURNING refund_id`;
    if(claimed) await tx`UPDATE refund SET state='processing' WHERE id=${id} AND state<>'succeeded'`;
    return Boolean(claimed) && !options.lookupOnly;
  });
  let remote;
  try {
    remote=send?await provider.createRefund(scope):await provider.findRefund(scope);
    if(!remote) throw new ProviderError('REFUND_OUTCOME_UNKNOWN');
    // Refetch POST results; completion is always based on the provider's current stored refund.
    if(send) remote=await provider.findRefund({...scope,provider_refund_id:remote.id});
    assertRefund(remote,scope);
    await withListingInventory(database,scope.rentable_id,async tx=>{
      const [current]=await tx`SELECT * FROM refund WHERE id=${id} FOR UPDATE`;
      if(current.state==='succeeded') return;
      assertRefund(remote,{...scope,provider_refund_id:current.provider_refund_id});
      if(remote.status==='processed') {
        await tx`UPDATE refund SET state='succeeded',actual_minor=expected_minor,provider_refund_id=${remote.id},
          verified_at=clock_timestamp(),completed_at=clock_timestamp(),evidence_hash=${quoteDigest(remote)} WHERE id=${id}`;
        await tx`UPDATE refund_allocation SET actual_minor=expected_minor WHERE refund_id=${id}`;
        await lifecycle(tx,scope.order_id,'refund_'+id.replaceAll('-',''),{refundId:id,environment:'test',testRefundMinor:Number(scope.expected_minor),actualBankRefundMinor:0});
      } else {
        // Keep the financial reservation even on provider failure. Re-POSTing or releasing
        // its cap could double-refund if the provider retries a failed refund later.
        await tx`UPDATE refund SET state=${remote.status==='failed'?'unknown':'processing'},provider_refund_id=${remote.id} WHERE id=${id}`;
      }
      await tx`UPDATE refund_execution SET failure_code=${remote.status==='failed'?'PROVIDER_REFUND_FAILED':null},
        next_check_at=clock_timestamp()+interval '5 minutes' WHERE refund_id=${id}`;
    });
  } catch(error) {
    const code=/^[A-Z_]{1,64}$/.test(error.code??'')?error.code:'REFUND_RETRY';
    await withListingInventory(database,scope.rentable_id,async tx=>{
      await tx`UPDATE refund SET state='unknown' WHERE id=${id} AND state<>'succeeded'`;
      await tx`UPDATE refund_execution SET failure_code=${code},next_check_at=clock_timestamp()+interval '1 minute' WHERE refund_id=${id} AND EXISTS(SELECT 1 FROM refund WHERE id=${id} AND state<>'succeeded')`;
    });
    throw error;
  }
}
export async function runRefundJobs(database,options={}) {
  // Includes Part 11 late-capture obligations, without enabling new customer payments.
  await database`INSERT INTO refund_execution(refund_id) SELECT r.id FROM refund r
    JOIN payment_transaction t ON t.id=r.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id
    JOIN payment_execution e ON e.payment_order_id=a.payment_order_id
    WHERE r.provider='razorpay' AND r.environment='test' AND r.mode='real' AND r.state='requested'
    ON CONFLICT DO NOTHING`;
  const work=await database`WITH due AS (
    SELECT e.refund_id FROM refund_execution e JOIN refund r ON r.id=e.refund_id
    WHERE r.state<>'succeeded' AND e.next_check_at<=clock_timestamp() ORDER BY e.next_check_at LIMIT 10 FOR UPDATE OF e SKIP LOCKED)
    UPDATE refund_execution e SET next_check_at=clock_timestamp()+interval '2 minutes' FROM due
    WHERE e.refund_id=due.refund_id RETURNING e.refund_id`;
  for(const row of work) {
    try { await reconcileRefund(database,row.refund_id,options); }
    catch(error) {
      const code=/^[A-Z_]{1,64}$/.test(error.code??'')?error.code:'REFUND_RETRY';
      await database`UPDATE refund_execution SET failure_code=${code} WHERE refund_id=${row.refund_id} AND EXISTS(SELECT 1 FROM refund WHERE id=${row.refund_id} AND state<>'succeeded')`;
    }
  }
  return work.length;
}
