import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { verifyWebhookSignature, razorpayTestAdapter, ProviderError } from './razorpay-test.js';
import { reconcileRefund } from './refunds.js';
import { paymentScope, settleVerifiedPayment } from './settlement.js';
import { resolvePinnedPaymentConfiguration } from './gateway-settings.js';

const refundEvents = new Set(['refund.created','refund.processed','refund.failed']);
const supported = new Set(['payment.authorized','payment.captured','payment.failed','order.paid']);
export async function ingestRazorpayEvent(database, raw, signature, eventId, env = process.env) {
  if (!Buffer.isBuffer(raw) || raw.length > 262144 || !/^[A-Za-z0-9_-]{1,160}$/.test(eventId ?? '')) throw new ProviderError('INVALID_EVENT');
  verifyWebhookSignature(raw, signature, env);
  let body;
  try { body=JSON.parse(raw.toString('utf8')); } catch { throw new ProviderError('INVALID_EVENT'); }
  if (typeof body?.event !== 'string' || body.event.length > 80) throw new ProviderError('INVALID_EVENT');
  const entity=body.payload?.payment?.entity;
  const normalized={ type:body.event };
  if (supported.has(body.event)) {
    if (!/^pay_[A-Za-z0-9]+$/.test(entity?.id ?? '') || !/^order_[A-Za-z0-9]+$/.test(entity?.order_id ?? '')) throw new ProviderError('INVALID_EVENT');
    normalized.paymentId=entity.id; normalized.orderId=entity.order_id;
  }
  if(refundEvents.has(body.event)) {
    const refund=body.payload?.refund?.entity;
    if(!/^rfnd_[A-Za-z0-9]+$/.test(refund?.id??'') || !/^pay_[A-Za-z0-9]+$/.test(refund?.payment_id??'') || !/^[a-f0-9-]{36}$/.test(refund?.receipt??'')) throw new ProviderError('INVALID_EVENT');
    normalized.refundId=refund.id; normalized.paymentId=refund.payment_id; normalized.receipt=refund.receipt;
  }
  const hash=createHash('sha256').update(raw).digest('hex');
  return database.begin(async tx=>{
    const [inserted]=await tx`INSERT INTO payment_event(provider,environment,external_event_id,payload_hash,redacted_payload,signature_verified_at)
      VALUES('razorpay','test',${eventId},${hash},${JSON.stringify(normalized)}::jsonb,clock_timestamp())
      ON CONFLICT(provider,environment,external_event_id) DO NOTHING RETURNING id`;
    const [event]=inserted?[inserted]:await tx`SELECT id,payload_hash FROM payment_event WHERE provider='razorpay' AND environment='test' AND external_event_id=${eventId}`;
    if (!inserted && event.payload_hash!==hash) throw new ProviderError('EVENT_ID_CONFLICT');
    await tx`INSERT INTO payment_event_job(event_id) VALUES(${event.id}) ON CONFLICT DO NOTHING`;
    return { id:event.id, duplicate:!inserted };
  });
}

export async function processNextPaymentEvent(database, options = {}) {
  const token=randomUUID();
  const event=await database.begin(async tx=>{
    const [job]=await tx`WITH candidate AS (
      SELECT j.event_id FROM payment_event_job j JOIN payment_event e ON e.id=j.event_id
      WHERE e.state<>'processed' AND j.next_attempt_at<=clock_timestamp()
        AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
      ORDER BY j.next_attempt_at,j.event_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
      UPDATE payment_event_job j SET lease_token=${token},lease_until=clock_timestamp()+interval '2 minutes'
      FROM candidate c WHERE j.event_id=c.event_id RETURNING j.event_id`;
    if (!job) return null;
    const [row]=await tx`UPDATE payment_event SET state='processing',attempts=attempts+1 WHERE id=${job.event_id} RETURNING *`;
    return row;
  });
  if (!event) return false;
  let failure=null;
  try {
    const data=event.redacted_payload;
    if(refundEvents.has(data.type)) {
      const [refund]=await database`SELECT r.id FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id
        WHERE r.id::text=${data.receipt} AND r.provider='razorpay' AND r.environment='test' AND t.provider_payment_id=${data.paymentId}`;
      if(!refund) throw new ProviderError('REFUND_NOT_FOUND');
      await reconcileRefund(database,refund.id,{...options,lookupOnly:true});
    }
    if (supported.has(data.type)) {
      const [po]=await database`SELECT id FROM payment_order WHERE provider='razorpay' AND environment='test' AND provider_order_id=${data.orderId}`;
      if (!po) throw new ProviderError('ORDER_NOT_LINKED');
      const scope=await paymentScope(database,po.id);
      await resolvePinnedPaymentConfiguration(database,scope.snapshot);
      const [captured]=await database`SELECT t.id FROM payment_transaction t JOIN payment_attempt a ON a.id=t.attempt_id
        WHERE a.payment_order_id=${scope.id} AND t.provider_payment_id=${data.paymentId} AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL`;
      if(!captured) {
      const payment=await razorpayTestAdapter(scope.credential_key_id,options).payment(data.paymentId,scope);
      await settleVerifiedPayment(database,scope.id,payment);
      }
    }
  } catch(error) { failure=/^[A-Z_]{1,64}$/.test(error.code ?? '')?error.code:'PROCESSING_RETRY'; }
  await database.begin(async tx=>{
    const [job]=await tx`SELECT event_id FROM payment_event_job WHERE event_id=${event.id} AND lease_token=${token} FOR UPDATE`;
    if (!job) return;
    await tx`UPDATE payment_event SET state=${failure?'failed':'processed'},failure_code=${failure},
      processed_at=CASE WHEN ${failure===null} THEN clock_timestamp() ELSE NULL END WHERE id=${event.id}`;
    await tx`UPDATE payment_event_job SET lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '1 minute' WHERE event_id=${event.id}`;
  });
  return true;
}
