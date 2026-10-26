import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ownedCheckout, CheckoutError, lifecycle } from './checkout.js';
import { quoteDigest } from './quotes.js';
import { cancellationEntitlement } from '../domain/cancellation.js';
import { previewHotelCancellation } from './hotel-stays.js';
import { allocateByWeights, refundOfPaid } from '../domain/booking-money.js';

/**
 * Hotel stay (Phase 7): each room's own rate rule (free until a deadline, then
 * first night or whole stay), from the booked room snapshots. The refund is
 * split over room and tax in the same proportion as they were paid.
 */
async function stayEntitlement(tx, visit, now, roomIds = null) {
  let preview;
  try { preview = await previewHotelCancellation(tx, visit.id, now, roomIds); } catch (error) { throw new CheckoutError(error.code ?? error.message); }
  // Phase 10: cancel some rooms of a multi-room stay. Each room keeps its own rule.
  const lines = preview.lines;
  if (roomIds && lines.length !== roomIds.length) throw new CheckoutError('ROOM_NOT_CANCELLABLE');
  const rooms = await tx`SELECT id, amount_room_minor::bigint AS room, amount_tax_minor::bigint AS tax FROM booking_room WHERE id IN ${tx(lines.map((line) => line.id))}`;
  let rent = 0, tax = 0;
  for (const line of lines) {
    const row = rooms.find((room) => room.id === line.id);
    const lineTax = Math.round(line.refundMinor * Number(row.tax) / Math.max(1, Number(row.room) + Number(row.tax)));
    tax += lineTax;
    rent += line.refundMinor - lineTax;
  }
  // Story 2.7: rooms booked with percentage windows refund that percentage of everything paid for
  // the room (room, tax and its share of the stay fee), split by stable largest remainder.
  if (lines.every((line) => Number.isInteger(line.pct))) {
    const all = await tx`SELECT id, amount_room_minor::bigint AS room FROM booking_room WHERE booking_id=${visit.id} ORDER BY id`;
    const roomFees = allocateByWeights(Number(visit.amount_fee_minor ?? 0), all.map((row) => Number(row.room)));
    let r = 0, t = 0, f = 0;
    for (const line of lines) {
      const row = rooms.find((room) => room.id === line.id);
      const share = refundOfPaid({ rent: Number(row.room), tax: Number(row.tax), fee: roomFees[all.findIndex((x) => x.id === line.id)] }, line.pct);
      r += share.rent; t += share.tax; f += share.fee;
    }
    return { rent: r, tax: t, fee: f, deposit: 0, basis: 'full_paid', chargeMinor: lines.reduce((sum, line) => sum + line.chargeMinor, 0),
      roomDetails: lines.map((line) => ({ id: line.id, pct: line.pct })),
      rooms: lines.length, roomIds: lines.map((line) => line.id), partial: lines.length < preview.bookedRoomCount };
  }
  // Story 2.2: the guest service fee is refunded in the same share as the stay money refunded.
  const [stay] = await tx`SELECT coalesce(sum(amount_room_minor + amount_tax_minor), 0)::bigint AS paid FROM booking_room WHERE booking_id=${visit.id}`;
  const refunded = lines.reduce((sum, line) => sum + line.refundMinor, 0);
  // Fully refunding the last rooms returns the whole remaining fee (earlier refunds cap it), so
  // rounding never strands paise; otherwise the fee follows the share of stay money refunded.
  const paidFee = Number(visit.amount_fee_minor ?? 0);
  const linesPaid = rooms.reduce((sum, row) => sum + Number(row.room) + Number(row.tax), 0);
  const fee = lines.length === preview.bookedRoomCount && refunded >= linesPaid ? paidFee
    : Number(stay.paid) > 0 ? Math.floor(paidFee * refunded / Number(stay.paid)) : 0;
  return { rent, tax, fee, deposit: 0,
    roomDetails: lines.map(line => ({ id: line.id, rule: line.free ? 'free' : line.legacy.lateCharge, freeCancelHours: line.legacy.freeCancelHours, refundMinor: line.refundMinor, chargeMinor: line.chargeMinor })),
    chargeMinor: lines.reduce((sum, line) => sum + line.chargeMinor, 0),
    rooms: lines.length, roomIds: lines.map((line) => line.id), partial: lines.length < preview.bookedRoomCount };
}

const selection = z.object({ orderId:z.string().uuid(), visitIds:z.array(z.string().uuid()).min(1).max(10),
  roomIds:z.array(z.string().uuid()).min(1).max(8).optional() }).strict();
const normalize = input => {
  const value=selection.parse(input); value.visitIds=[...new Set(value.visitIds)].sort();
  if (value.roomIds) { value.roomIds=[...new Set(value.roomIds)].sort(); if (value.visitIds.length!==1) throw new CheckoutError('ROOMS_NEED_ONE_STAY'); }
  return value;
};
/** Verified capture allocations for these visits, with what earlier refunds already reserved. */
export async function capturedAllocations(tx, visitIds) {
  return tx`SELECT a.*,t.provider,t.environment,t.mode,t.currency,t.provider_payment_id,
    coalesce((SELECT sum(ra.expected_minor) FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
      WHERE ra.payment_allocation_id=a.id AND r.state<>'failed'),0)::text reserved
    FROM payment_allocation a JOIN payment_transaction t ON t.id=a.transaction_id
    WHERE a.booking_id IN ${tx(visitIds)} AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL ORDER BY a.id`;
}
/** Split an entitlement over captured allocations, never past what earlier refunds left. */
export function allocateRefund(sources, entitlement, { remainingOnly = false } = {}) {
  const remaining={rent:entitlement.rent,fee:entitlement.fee,deposit:entitlement.deposit,tax:entitlement.tax??0};
  return sources.map(a=>{
    if(!(a.component in remaining)) throw new CheckoutError('PAYMENT_UNSUPPORTED');
    const capacity = remainingOnly ? Math.max(0, Number(a.actual_minor) - Number(a.reserved)) : Number(a.actual_minor);
    const entitled=Math.min(capacity,remaining[a.component]);
    remaining[a.component]-=entitled;
    // Visit entitlements count the whole payment, so earlier refunds come off them. A stay's
    // entitlement covers only rooms still booked (Phase 10), so earlier refunds only cap it.
    return {allocationId:a.id,transactionId:a.transaction_id,component:a.component,
      amount:Math.max(0,remainingOnly?entitled:entitled-Number(a.reserved))};
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
  const visits=await tx`SELECT b.*,o.policy_snapshot FROM booking b JOIN booking_order o ON o.id=b.order_id WHERE b.order_id=${order.id} AND b.id IN ${tx(value.visitIds)} ORDER BY b.id`;
  if(visits.length!==value.visitIds.length) throw new CheckoutError('VISIT_NOT_FOUND');
  const allocations=await capturedAllocations(tx, value.visitIds);
  const plans=[];
  for(const visit of visits) {
    if(visit.state!=='confirmed') throw new CheckoutError(value.roomIds && visit.slot==='stay' ? 'ROOM_NOT_CANCELLABLE' : 'VISIT_NOT_CANCELLABLE');
    let entitlement;
    if(visit.slot==='stay') entitlement=await stayEntitlement(tx,visit,now,value.roomIds ?? null);
    else if (value.roomIds) throw new CheckoutError('ROOMS_NEED_ONE_STAY');
    else try { entitlement=cancellationEntitlement(visit,now); } catch(error) { throw new CheckoutError(error.message); }
    const sources=allocations.filter(a=>a.booking_id===visit.id);
    if(!sources.length || !testSourcesOnly(sources)) throw new CheckoutError('PAYMENT_UNSUPPORTED');
    // Earlier stay refunds must name the rooms whose entitlement they consumed.
    if (visit.slot === 'stay' && sources.some((source) => Number(source.reserved) > 0)) {
      const [unattributed] = await tx`SELECT ra.refund_id FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
        WHERE ra.booking_id=${visit.id} AND r.state<>'failed' AND NOT EXISTS (
          SELECT 1 FROM booking_cancellation c, jsonb_array_elements(c.snapshot->'visits') v
          WHERE c.order_id=${order.id} AND c.snapshot->'refundIds' ? r.id::text
            AND v->>'id'=${visit.id}::text AND jsonb_typeof(v->'roomIds')='array'
            AND jsonb_array_length(v->'roomIds')>0
        ) LIMIT 1`;
      if (unattributed) throw new CheckoutError('REFUND_ATTRIBUTION_REQUIRED');
    }
    const refunds=allocateRefund(sources, entitlement, { remainingOnly: visit.slot==='stay' });
    plans.push({id:visit.id,reference:visit.reference,date:String(visit.local_day instanceof Date?visit.local_day.toISOString():visit.local_day).slice(0,10),
      state:visit.state,version:visit.lifecycle_version,...entitlement,
      startedAtEstimate: visit.slot==='stay' && entitlement.basis==='full_paid' && new Date(visit.starts_at)<=new Date(now),
      refundMinor:refunds.reduce((sum,a)=>sum+a.amount,0),refunds});
  }
  const result={orderId:order.id,visits:plans,refundMinor:plans.reduce((sum,v)=>sum+v.refundMinor,0),actualBankRefundMinor:0};
  // Story 2.7: the preview binds who asked, the scope and the booked policy versions, not just the amounts.
  const binding={customer:order.customer_id,roomIds:value.roomIds??null,
    policies:visits.map(v=>[v.id,v.lifecycle_version,v.policy_snapshot?.version??null,Boolean(v.policy_snapshot?.cancellationPolicy)])};
  return {...result,hash:quoteDigest({...result,binding})};
}
function publicPreview(preview) {
  return {...preview,visits:preview.visits.map(({refunds: _refunds,...visit})=>visit)};
}
export async function previewCancellation(database,session,input,env=process.env) {
  const value=normalize(input);
  return ownedCheckout(database,session,value.orderId,async(tx,order)=>publicPreview(await estimate(tx,order,value)),env);
}
/**
 * Cancel visits (or, for one stay, some of its rooms) inside the caller's
 * transaction: refund obligations, state changes, rooms back on sale, the
 * cancellation record and its lifecycle event. Shared by the guest's own
 * cancellation and by a booking change (Phase 10).
 */
export async function applyCancellation(tx, order, preview, value, { actorKind, reason, idempotencyKey, requestHash, customerId }) {
  const id=randomUUID();
  // The refund reason is a category key for finance; the visit keeps the guest's own words.
  const refundIds=await createRefundObligations(tx, preview.visits, { reason:'Customer visit cancellation', idempotencyKey:id, requestHash });
  const partial=preview.visits.some(v=>v.partial);
  if (partial) {
    const released=await tx`UPDATE booking_room SET state='released',updated_at=clock_timestamp()
      WHERE booking_id=${value.visitIds[0]} AND id IN ${tx(value.roomIds)} AND state='booked'
        AND EXISTS (SELECT 1 FROM booking b WHERE b.id=booking_room.booking_id AND b.state='confirmed'
          AND (b.starts_at>clock_timestamp() OR ${preview.visits[0].startedAtEstimate})) RETURNING id`;
    if(released.length!==value.roomIds.length) throw new CheckoutError('CANCELLATION_CHANGED');
  } else {
    const changed=await tx`UPDATE booking SET state='cancelled',cancelled_at=clock_timestamp(),cancelled_by_kind=${actorKind},
      cancellation_reason=${reason},lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp()
      WHERE order_id=${order.id} AND id IN ${tx(value.visitIds)} AND state='confirmed' AND (starts_at>clock_timestamp() OR
        ${JSON.stringify(preview.visits.filter(v=>v.startedAtEstimate).map(v=>v.id))}::text::jsonb ? id::text) RETURNING id`;
    if(changed.length!==value.visitIds.length) throw new CheckoutError('CANCELLATION_CHANGED');
    await tx`UPDATE inventory_reservation SET state='released',released_at=clock_timestamp() WHERE booking_id IN ${tx(value.visitIds)} AND state='committed'`;
    await tx`UPDATE booking_order SET state='cancelled',updated_at=clock_timestamp() WHERE id=${order.id}
      AND NOT EXISTS(SELECT 1 FROM booking WHERE order_id=${order.id} AND state<>'cancelled')`;
  }
  const snapshot={...publicPreview(preview),id,refundIds,cancelledAt:new Date().toISOString(),...(partial?{roomIds:value.roomIds}:{})};
  await tx`INSERT INTO booking_cancellation(id,order_id,customer_id,idempotency_key,request_hash,snapshot)
    VALUES(${id},${order.id},${customerId},${idempotencyKey},${requestHash},${JSON.stringify(snapshot)}::text::jsonb)`;
  await lifecycle(tx,order.id,'cancel_'+id.replaceAll('-',''),{cancellationId:id,visitIds:value.visitIds,...(partial?{roomIds:value.roomIds}:{}),refundIds,environment:'test',actualBankRefundMinor:0});
  return snapshot;
}

export async function commitCancellation(database,session,input,env=process.env) {
  const parsed=z.object({orderId:z.string().uuid(),visitIds:z.array(z.string().uuid()).min(1).max(10),roomIds:z.array(z.string().uuid()).min(1).max(8).optional(),
    hash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().uuid(),accepted:z.literal(true),reason:z.string().trim().max(160).default('')}).strict().parse(input);
  const value=normalize({orderId:parsed.orderId,visitIds:parsed.visitIds,...(parsed.roomIds?{roomIds:parsed.roomIds}:{})});
  const requestHash=quoteDigest({...parsed,visitIds:value.visitIds,roomIds:value.roomIds});
  return ownedCheckout(database,session,value.orderId,async(tx,order)=>{
    const [previous]=await tx`SELECT snapshot,request_hash FROM booking_cancellation WHERE customer_id=${session.userId} AND idempotency_key=${parsed.idempotencyKey}`;
    if(previous) {if(previous.request_hash!==requestHash) throw new CheckoutError('IDEMPOTENCY_CONFLICT');return previous.snapshot;}
    const preview=await estimate(tx,order,value);
    if(preview.hash!==parsed.hash) throw new CheckoutError('CANCELLATION_CHANGED');
    return applyCancellation(tx, order, preview, value, { actorKind:'customer', reason:parsed.reason||'Customer cancellation',
      idempotencyKey:parsed.idempotencyKey, requestHash, customerId:session.userId });
  },env);
}

/** Preview inside an existing transaction (booking changes, Phase 10). */
export const estimateCancellation = estimate;
