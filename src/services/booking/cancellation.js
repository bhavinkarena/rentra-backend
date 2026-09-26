import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ownedCheckout, CheckoutError, lifecycle } from './checkout.js';
import { quoteDigest } from './quotes.js';
import { cancellationEntitlement } from '../domain/cancellation.js';

const selection = z.object({ orderId:z.string().uuid(), visitIds:z.array(z.string().uuid()).min(1).max(10) }).strict();
const normalize = input => { const value=selection.parse(input); value.visitIds=[...new Set(value.visitIds)].sort(); return value; };
/** Verified capture allocations for these visits, with what earlier refunds already reserved. */
export async function capturedAllocations(tx, visitIds) {
  return tx`SELECT a.*,t.provider,t.environment,t.mode,t.currency,t.provider_payment_id,
    coalesce((SELECT sum(ra.expected_minor) FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
      WHERE ra.payment_allocation_id=a.id AND r.state<>'failed'),0)::text reserved
    FROM payment_allocation a JOIN payment_transaction t ON t.id=a.transaction_id
    WHERE a.booking_id IN ${tx(visitIds)} AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL ORDER BY a.id`;
}
/** Split an entitlement over captured allocations, never past what earlier refunds left. */
export function allocateRefund(sources, entitlement) {
  const remaining={rent:entitlement.rent,fee:entitlement.fee,deposit:entitlement.deposit};
  return sources.map(a=>{
    if(!(a.component in remaining)) throw new CheckoutError('PAYMENT_UNSUPPORTED');
    const entitled=Math.min(Number(a.actual_minor),remaining[a.component]);
    remaining[a.component]-=entitled;
    return {allocationId:a.id,transactionId:a.transaction_id,component:a.component,
      amount:Math.max(0,entitled-Number(a.reserved))};
  }).filter(a=>a.amount>0);
}
export const testSourcesOnly = sources => sources.every(a=>a.provider==='razorpay'&&a.environment==='test'&&a.mode==='real');
/** One refund obligation per captured transaction, each with its single execution claim. */
export async function createRefundObligations(tx, visits, { reason, idempotencyKey, requestHash }) {
  const refundIds=[], groups=new Map();
  for(const visit of visits) for(const a of visit.refunds) {
    if(!groups.has(a.transactionId)) groups.set(a.transactionId,[]);
    groups.get(a.transactionId).push({...a,bookingId:visit.id});
  }
  for(const [transactionId,allocations] of groups) {
    const refundId=randomUUID();refundIds.push(refundId);
    await tx`INSERT INTO refund(id,transaction_id,reference,provider,environment,mode,currency,expected_minor,reason,idempotency_key,request_hash)
      VALUES(${refundId},${transactionId},${'TEST_REFUND_'+refundId},'razorpay','test','real','INR',${allocations.reduce((sum,a)=>sum+a.amount,0)},
      ${reason},${idempotencyKey},${requestHash})`;
    for(const a of allocations) await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
      VALUES(${refundId},${a.allocationId},${a.bookingId},${a.component},${a.amount})`;
    await tx`INSERT INTO refund_execution(refund_id) VALUES(${refundId})`;
  }
  return refundIds;
}
async function estimate(tx, order, value) {
  const [{now}]=await tx`SELECT clock_timestamp() now`;
  const visits=await tx`SELECT * FROM booking WHERE order_id=${order.id} AND id IN ${tx(value.visitIds)} ORDER BY id`;
  if(visits.length!==value.visitIds.length) throw new CheckoutError('VISIT_NOT_FOUND');
  const allocations=await capturedAllocations(tx, value.visitIds);
  const plans=[];
  for(const visit of visits) {
    if(visit.state!=='confirmed') throw new CheckoutError('VISIT_NOT_CANCELLABLE');
    let entitlement;
    try { entitlement=cancellationEntitlement(visit,now); } catch(error) { throw new CheckoutError(error.message); }
    const sources=allocations.filter(a=>a.booking_id===visit.id);
    if(!sources.length || !testSourcesOnly(sources)) throw new CheckoutError('PAYMENT_UNSUPPORTED');
    const refunds=allocateRefund(sources, entitlement);
    plans.push({id:visit.id,reference:visit.reference,date:String(visit.local_day instanceof Date?visit.local_day.toISOString():visit.local_day).slice(0,10),
      state:visit.state,version:visit.lifecycle_version,...entitlement,refundMinor:refunds.reduce((sum,a)=>sum+a.amount,0),refunds});
  }
  const result={orderId:order.id,visits:plans,refundMinor:plans.reduce((sum,v)=>sum+v.refundMinor,0),actualBankRefundMinor:0};
  return {...result,hash:quoteDigest(result)};
}
function publicPreview(preview) {
  return {...preview,visits:preview.visits.map(({refunds: _refunds,...visit})=>visit)};
}
export async function previewCancellation(database,session,input,env=process.env) {
  const value=normalize(input);
  return ownedCheckout(database,session,value.orderId,async(tx,order)=>publicPreview(await estimate(tx,order,value)),env);
}
export async function commitCancellation(database,session,input,env=process.env) {
  const parsed=z.object({orderId:z.string().uuid(),visitIds:z.array(z.string().uuid()).min(1).max(10),
    hash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().uuid(),accepted:z.literal(true),reason:z.string().trim().max(160).default('')}).strict().parse(input);
  const value=normalize({orderId:parsed.orderId,visitIds:parsed.visitIds});
  const requestHash=quoteDigest({...parsed,visitIds:value.visitIds});
  return ownedCheckout(database,session,value.orderId,async(tx,order)=>{
    const [previous]=await tx`SELECT snapshot,request_hash FROM booking_cancellation WHERE customer_id=${session.userId} AND idempotency_key=${parsed.idempotencyKey}`;
    if(previous) {if(previous.request_hash!==requestHash) throw new CheckoutError('IDEMPOTENCY_CONFLICT');return previous.snapshot;}
    const preview=await estimate(tx,order,value);
    if(preview.hash!==parsed.hash) throw new CheckoutError('CANCELLATION_CHANGED');
    const id=randomUUID();
    const refundIds=await createRefundObligations(tx, preview.visits, { reason:'Customer visit cancellation', idempotencyKey:id, requestHash });
    const changed=await tx`UPDATE booking SET state='cancelled',cancelled_at=clock_timestamp(),cancelled_by='customer',
      cancellation_reason=${parsed.reason||'Customer cancellation'},lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp()
      WHERE order_id=${order.id} AND id IN ${tx(value.visitIds)} AND state='confirmed' AND starts_at>clock_timestamp() RETURNING id`;
    if(changed.length!==value.visitIds.length) throw new CheckoutError('CANCELLATION_CHANGED');
    await tx`UPDATE inventory_reservation SET state='released',released_at=clock_timestamp() WHERE booking_id IN ${tx(value.visitIds)} AND state='committed'`;
    await tx`UPDATE booking_order SET state='cancelled',updated_at=clock_timestamp() WHERE id=${order.id}
      AND NOT EXISTS(SELECT 1 FROM booking WHERE order_id=${order.id} AND state<>'cancelled')`;
    const snapshot={...publicPreview(preview),id,refundIds,cancelledAt:new Date().toISOString()};
    await tx`INSERT INTO booking_cancellation(id,order_id,customer_id,idempotency_key,request_hash,snapshot)
      VALUES(${id},${order.id},${session.userId},${parsed.idempotencyKey},${requestHash},${JSON.stringify(snapshot)}::text::jsonb)`;
    await lifecycle(tx,order.id,'cancel_'+id.replaceAll('-',''),{cancellationId:id,visitIds:value.visitIds,refundIds,environment:'test',actualBankRefundMinor:0});
    return snapshot;
  },env);
}
