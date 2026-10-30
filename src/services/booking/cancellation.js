import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ownedCheckout, CheckoutError, lifecycle } from './checkout.js';
import { quoteDigest } from './quotes.js';
import { cancellationEntitlement } from '../domain/cancellation.js';
import { previewHotelCancellation } from './hotel-stays.js';
import { allocateByWeights, refundOfPaid } from '../domain/booking-money.js';
import { earlyDepartureRoom } from '../domain/early-departure.js';
import { stayInstants } from '../domain/hotel.js';
import { apartmentRefundParts, departedReservationEnd, isApartmentPolicy } from './apartment-stays.js';

/**
 * Story 3.11: a whole apartment cancelled before arrival. The booked percentage applies to everything
 * paid (rent + cleaning + pet, booked as rent, and the fee), floored to the paisa; cleaning and pet
 * follow the same ratio as the rent. refund + charge = paid.
 */
function apartmentCancelEntitlement(visit, now) {
  let entitlement;
  try { entitlement = cancellationEntitlement(visit, now); } catch (error) { throw new CheckoutError(error.message); }
  const paid = Number(visit.amount_rent_minor) + Number(visit.amount_fee_minor);
  const refund = entitlement.rent + entitlement.fee;
  const chargeMinor = paid - refund;
  if (chargeMinor < 0) throw new CheckoutError('REFUND_EXCEEDS_PAID');
  return { ...entitlement, apartment: apartmentRefundParts(visit.slot_snapshot.apartment, entitlement.rent), chargeMinor };
}

/**
 * Story 3.11: leaving an apartment early. Unused nights (and their share of the fee) are refunded at the
 * booked early-departure rule over the accepted per-night snapshot; cleaning and pet charges are kept.
 */
function apartmentDepartureEntitlement(visit, now, departed) {
  if (departed || !visit.hours_known || !['confirmed', 'handed_over', 'returned'].includes(visit.state)
    || new Date(visit.starts_at) > new Date(now) || new Date(visit.ends_at) <= new Date(now)) throw new CheckoutError('EARLY_DEPARTURE_UNAVAILABLE');
  const stay = visit.slot_snapshot, a = stay?.apartment;
  try {
    const fees = allocateByWeights(Number(visit.amount_fee_minor), [a.rentMinor, a.cleaningMinor, a.petMinor ?? 0]);
    const d = earlyDepartureRoom({ checkIn: stay.checkIn, checkOut: stay.checkOut, nights: a.nightly, rent: a.rentMinor, tax: 0, fee: fees[0],
      policy: visit.policy_snapshot.cancellationPolicy, checkInMinute: a.checkInMinute, timeZone: visit.time_zone }, now);
    if (!d.consumedNights.length) throw new RangeError('EARLY_DEPARTURE_UNSUPPORTED');
    return { rent: d.refund.rent, tax: 0, fee: d.refund.fee, deposit: 0, basis: 'unused_nights', roomDetails: [], rooms: 0, roomIds: [], partial: false,
      apartment: { consumedNights: d.consumedNights, unusedNights: d.unusedNights, inventoryEnd: d.inventoryEnd, offered: d.offered, pct: d.pct,
        keptCleaningMinor: a.cleaningMinor, keptPetMinor: a.petMinor ?? 0 } };
  } catch { throw new CheckoutError('EARLY_DEPARTURE_UNSUPPORTED'); }
}

async function departureEntitlement(visit, now, roomIds, all) {
  if (visit.slot !== 'stay' || visit.policy_snapshot?.kind !== 'stay' || !visit.hours_known
    || !['confirmed', 'handed_over', 'returned'].includes(visit.state)
    || new Date(visit.starts_at) > new Date(now) || new Date(visit.ends_at) <= new Date(now)) throw new CheckoutError('EARLY_DEPARTURE_UNAVAILABLE');
  const selected = roomIds ? all.filter(row => roomIds.includes(row.id)) : all.filter(row => row.state === 'booked');
  if (!selected.length || (roomIds && selected.length !== roomIds.length) || selected.some(row => row.state !== 'booked' || row.departed_at)) throw new CheckoutError('ROOM_NOT_CANCELLABLE');
  let fees, details;
  try {
    const localDay=String(visit.local_day instanceof Date ? visit.local_day.toISOString() : visit.local_day).slice(0,10);
    if (selected.some(row => row.arrival!==localDay || row.arrival!==visit.slot_snapshot?.checkIn || row.checkout!==visit.slot_snapshot?.checkOut)) throw new RangeError('EARLY_DEPARTURE_UNSUPPORTED');
    const schedule=visit.policy_snapshot.hotel;
    if (![schedule?.checkInMinute,schedule?.checkOutMinute].every(minute=>Number.isInteger(minute)&&minute>=0&&minute<1440)) throw new RangeError('EARLY_DEPARTURE_UNSUPPORTED');
    const booked=stayInstants({checkIn:localDay,checkOut:selected[0].checkout,checkInMinute:schedule.checkInMinute,checkOutMinute:schedule.checkOutMinute});
    if (+new Date(booked.startsAt)!==+new Date(visit.starts_at) || +new Date(booked.endsAt)!==+new Date(visit.ends_at)) throw new RangeError('EARLY_DEPARTURE_UNSUPPORTED');
    fees = allocateByWeights(Number(visit.amount_fee_minor), all.map(row => Number(row.amount_room_minor)));
    details = selected.map(row => ({ id: row.id, ...earlyDepartureRoom({
      checkIn: row.arrival, checkOut: row.checkout, nights: row.nights,
      rent: Number(row.amount_room_minor), tax: Number(row.amount_tax_minor), fee: fees[all.indexOf(row)],
      policy: row.plan_snapshot?.cancellationPolicy, checkInMinute: visit.policy_snapshot.hotel?.checkInMinute,
      timeZone: visit.time_zone,
    }, now) }));
    if (details.some(room => room.consumedNights.length===0)) throw new RangeError('EARLY_DEPARTURE_UNSUPPORTED');
  } catch { throw new CheckoutError('EARLY_DEPARTURE_UNSUPPORTED'); }
  const total = key => details.reduce((sum, room) => sum + BigInt(room.refund[key]), 0n);
  if (['rent', 'tax', 'fee'].some(key => total(key) > BigInt(Number.MAX_SAFE_INTEGER))) throw new CheckoutError('EARLY_DEPARTURE_UNSUPPORTED');
  return { rent: Number(total('rent')), tax: Number(total('tax')), fee: Number(total('fee')), deposit: 0,
    basis: 'unused_nights', roomDetails: details, rooms: selected.length, roomIds: selected.map(row => row.id),
    partial: selected.length < all.filter(row => row.state === 'booked').length };
}

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
  // Story 3.9: the trip-level pet charge. Pets still come while any room stays booked, so a partial
  // cancel refunds none of it; cancelling every remaining room refunds it (and its fee share) at the
  // ratio of room rent refunded in this cancellation, floored to the paisa (the rest stays with the owner).
  const petMinor = Number(visit.policy_snapshot?.pets?.totalMinor ?? 0);
  const whole = lines.length === preview.bookedRoomCount;
  const roomsRent = rooms.reduce((sum, row) => sum + Number(row.room), 0);
  // On a whole cancel the charge also names what is kept of the pet charge and the fee, so
  // everything paid = refund + charge reconciles.
  const kept = (pet, fee) => (whole ? petMinor - pet + Number(visit.amount_fee_minor ?? 0) - fee : 0);
  const petShare = (amount, roomRentRefunded) => (whole && roomsRent > 0 ? Math.floor(amount * roomRentRefunded / roomsRent) : 0);
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
    // The fee also covered the pet charge (its own weight, last), so rooms keep only their own share.
    const roomFees = allocateByWeights(Number(visit.amount_fee_minor ?? 0), [...all.map((row) => Number(row.room)), ...(petMinor ? [petMinor] : [])]);
    let r = 0, t = 0, f = 0;
    for (const line of lines) {
      const row = rooms.find((room) => room.id === line.id);
      const share = refundOfPaid({ rent: Number(row.room), tax: Number(row.tax), fee: roomFees[all.findIndex((x) => x.id === line.id)] }, line.pct);
      r += share.rent; t += share.tax; f += share.fee;
    }
    const pet = petShare(petMinor, r);
    const petFee = petShare(petMinor ? roomFees.at(-1) : 0, r);
    return { rent: r + pet, tax: t, fee: f + petFee, deposit: 0, ...(petMinor ? { pet } : {}), basis: 'full_paid',
      chargeMinor: lines.reduce((sum, line) => sum + line.chargeMinor, 0) + kept(pet, f + petFee),
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
  const pet = petShare(petMinor, rent);
  const paidBase = Number(stay.paid) + petMinor;
  const fee = whole && refunded >= linesPaid && pet === petMinor ? paidFee
    : paidBase > 0 ? Math.floor(paidFee * (refunded + pet) / paidBase) : 0;
  return { rent: rent + pet, tax, fee, deposit: 0, ...(petMinor ? { pet } : {}),
    roomDetails: lines.map(line => ({ id: line.id, rule: line.free ? 'free' : line.legacy.lateCharge, freeCancelHours: line.legacy.freeCancelHours, refundMinor: line.refundMinor, chargeMinor: line.chargeMinor })),
    chargeMinor: lines.reduce((sum, line) => sum + line.chargeMinor, 0) + kept(pet, fee),
    rooms: lines.length, roomIds: lines.map((line) => line.id), partial: lines.length < preview.bookedRoomCount };
}

const selection = z.object({ orderId:z.string().uuid(), visitIds:z.array(z.string().uuid()).min(1).max(10),
  roomIds:z.array(z.string().uuid()).min(1).max(8).optional(), operation:z.literal('early_departure').optional() }).strict();
const normalize = input => {
  const value=selection.parse(input); value.visitIds=[...new Set(value.visitIds)].sort();
  if (value.roomIds) { value.roomIds=[...new Set(value.roomIds)].sort(); if (value.visitIds.length!==1) throw new CheckoutError('ROOMS_NEED_ONE_STAY'); }
  if (value.operation && value.visitIds.length !== 1) throw new CheckoutError('ROOMS_NEED_ONE_STAY');
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
  const departureRooms=value.operation ? await tx`SELECT br.*,br.check_in::text AS arrival,br.check_out::text AS checkout
    FROM booking_room br JOIN booking b ON b.id=br.booking_id
    WHERE b.order_id=${order.id} AND b.id IN ${tx(value.visitIds)} ORDER BY br.id FOR UPDATE OF br` : null;
  const [{now}]=await tx`SELECT clock_timestamp() now`;
  const visits=await tx`SELECT b.*,o.policy_snapshot FROM booking b JOIN booking_order o ON o.id=b.order_id WHERE b.order_id=${order.id} AND b.id IN ${tx(value.visitIds)} ORDER BY b.id`;
  if(visits.length!==value.visitIds.length) throw new CheckoutError('VISIT_NOT_FOUND');
  const allocations=await capturedAllocations(tx, value.visitIds);
  const plans=[];
  for(const visit of visits) {
    const apartment=visit.slot==='stay' && isApartmentPolicy(visit.policy_snapshot);
    const hotelStay=visit.slot==='stay' && !apartment;
    const departed=apartment && (await tx`SELECT 1 FROM booking_cancellation c, jsonb_array_elements(c.snapshot->'visits') v
      WHERE c.order_id=${order.id} AND c.snapshot->>'operation'='early_departure' AND v->>'id'=${visit.id}::text`).length>0;
    if(apartment && value.roomIds) throw new CheckoutError('ROOMS_NEED_ONE_STAY');
    if(apartment && departed && !value.operation) throw new CheckoutError('VISIT_NOT_CANCELLABLE');
    if(!value.operation && visit.state!=='confirmed') throw new CheckoutError(value.roomIds && visit.slot==='stay' ? 'ROOM_NOT_CANCELLABLE' : 'VISIT_NOT_CANCELLABLE');
    let entitlement;
    if(value.operation && apartment) entitlement=apartmentDepartureEntitlement(visit,now,departed);
    else if(apartment) entitlement=apartmentCancelEntitlement(visit,now);
    else if(value.operation) entitlement=await departureEntitlement(visit,now,value.roomIds ?? null,departureRooms.filter(room=>room.booking_id===visit.id));
    else if(visit.slot==='stay') entitlement=await stayEntitlement(tx,visit,now,value.roomIds ?? null);
    else if (value.roomIds) throw new CheckoutError('ROOMS_NEED_ONE_STAY');
    else try { entitlement=cancellationEntitlement(visit,now); } catch(error) { throw new CheckoutError(error.message); }
    const sources=allocations.filter(a=>a.booking_id===visit.id);
    if(!sources.length || !testSourcesOnly(sources)) throw new CheckoutError('PAYMENT_UNSUPPORTED');
    // Story 3.11: an apartment's refund + charge must equal what was actually captured for it.
    if(apartment && !value.operation) {
      const captured=sources.reduce((sum,a)=>sum+Number(a.actual_minor),0);
      if(captured!==Number(visit.amount_rent_minor)+Number(visit.amount_fee_minor)) throw new CheckoutError('PAYMENT_MISMATCH');
      entitlement.chargeMinor=captured-(entitlement.rent+entitlement.fee);
    }
    // Earlier stay refunds must name the rooms whose entitlement they consumed.
    if (hotelStay && sources.some((source) => Number(source.reserved) > 0)) {
      const [unattributed] = await tx`SELECT ra.refund_id FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
        WHERE ra.booking_id=${visit.id} AND r.state<>'failed' AND NOT EXISTS (
          SELECT 1 FROM booking_cancellation c, jsonb_array_elements(c.snapshot->'visits') v
          WHERE c.order_id=${order.id} AND c.snapshot->'refundIds' ? r.id::text
            AND v->>'id'=${visit.id}::text AND jsonb_typeof(v->'roomIds')='array'
            AND jsonb_array_length(v->'roomIds')>0
        ) LIMIT 1`;
      if (unattributed) throw new CheckoutError('REFUND_ATTRIBUTION_REQUIRED');
    }
    // A departure entitles only the unused part (remaining capacity); a cancellation counts the whole payment.
    const refunds=allocateRefund(sources, entitlement, { remainingOnly: hotelStay || (apartment && Boolean(value.operation)) });
    plans.push({id:visit.id,reference:visit.reference,date:String(visit.local_day instanceof Date?visit.local_day.toISOString():visit.local_day).slice(0,10),
      state:visit.state,version:visit.lifecycle_version,...entitlement,
      startedAtEstimate: visit.slot==='stay' && entitlement.basis==='full_paid' && new Date(visit.starts_at)<=new Date(now),
      ...(value.operation ? { priorReserved: Object.fromEntries(['rent','tax','fee'].map(key => [key,sources.filter(a=>a.component===key).reduce((sum,a)=>sum+Number(a.reserved),0)])) } : {}),
      refundMinor:refunds.reduce((sum,a)=>sum+a.amount,0),refunds});
  }
  const result={orderId:order.id,visits:plans,refundMinor:plans.reduce((sum,v)=>sum+v.refundMinor,0),actualBankRefundMinor:0};
  // Story 2.7: the preview binds who asked, the scope and the booked policy versions, not just the amounts.
  const binding={customer:order.customer_id,roomIds:value.roomIds??null,
    policies:visits.map(v=>[v.id,v.lifecycle_version,v.policy_snapshot?.version??null,Boolean(v.policy_snapshot?.cancellationPolicy)])};
  if (value.operation) result.operation=value.operation;
  return {...result,...(value.operation ? { requestedAt:new Date(now).toISOString() } : {}),hash:quoteDigest({...result,binding})};
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
export async function applyCancellation(tx, order, preview, value, { actorKind, reason, idempotencyKey, requestHash, customerId, refundReason }) {
  const id=randomUUID();
  // The refund reason is a category key for finance; the visit keeps the guest's own words.
  const departing=value.operation==='early_departure';
  const refundIds=await createRefundObligations(tx, preview.visits, { reason:refundReason ?? (departing?'Customer early departure':'Customer visit cancellation'), idempotencyKey:id, requestHash });
  const partial=preview.visits.some(v=>v.partial);
  const snapshot={...publicPreview(preview),id,refundIds,...(departing?{departedAt:preview.requestedAt}:{cancelledAt:new Date().toISOString()}),...(partial?{roomIds:value.roomIds}:{})};
  const saveReceipt=()=>tx`INSERT INTO booking_cancellation(id,order_id,customer_id,idempotency_key,request_hash,snapshot)
    VALUES(${id},${order.id},${customerId},${idempotencyKey},${requestHash},${JSON.stringify(snapshot)}::text::jsonb)`;
  if (departing) await saveReceipt();
  if (departing && preview.visits[0].apartment) {
    // Story 3.11: the accepted stay is kept; the reservation ends at the first unused night + turnover, so those nights sell again.
    const [visit]=await tx`SELECT slot_snapshot FROM booking WHERE id=${value.visitIds[0]}`;
    const end=departedReservationEnd(preview.visits[0].apartment.inventoryEnd, visit.slot_snapshot.apartment.turnoverNights ?? 0);
    await tx`UPDATE inventory_reservation SET blocked_end_at=${end} WHERE booking_id=${value.visitIds[0]} AND state='committed' AND blocked_end_at>${end}`;
    // The stay is over: completed like a hotel stay left early (0089 accepts the departure receipt as proof).
    await tx`UPDATE booking SET state='completed',lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp()
      WHERE id=${value.visitIds[0]} AND state IN ('confirmed','handed_over','returned')`;
  } else if (departing) {
    for (const room of preview.visits[0].roomDetails) {
      const changed=await tx`UPDATE booking_room SET state='stayed',departed_at=${preview.requestedAt},inventory_end=${room.inventoryEnd},updated_at=clock_timestamp()
        WHERE booking_id=${value.visitIds[0]} AND id=${room.id} AND state='booked' AND departed_at IS NULL RETURNING id`;
      if(changed.length!==1) throw new CheckoutError('CANCELLATION_CHANGED');
    }
    await tx`UPDATE booking SET state=CASE WHEN EXISTS(SELECT 1 FROM booking_room WHERE booking_id=booking.id AND state='booked') THEN state ELSE 'completed'::booking_state END,
      lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp() WHERE id=${value.visitIds[0]}`;
  } else if (partial) {
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
  if (!departing) await saveReceipt();
  await lifecycle(tx,order.id,(departing?'depart_':'cancel_')+id.replaceAll('-',''),{cancellationId:id,visitIds:value.visitIds,...(departing?{operation:value.operation,roomIds:preview.visits[0].roomIds,departedAt:preview.requestedAt,rooms:preview.visits[0].rooms,roomDetails:preview.visits[0].roomDetails}:partial?{roomIds:value.roomIds}:{}),refundIds,environment:'test',actualBankRefundMinor:0});
  return snapshot;
}

export async function commitCancellation(database,session,input,env=process.env) {
  const parsed=z.object({orderId:z.string().uuid(),visitIds:z.array(z.string().uuid()).min(1).max(10),roomIds:z.array(z.string().uuid()).min(1).max(8).optional(),
    operation:z.literal('early_departure').optional(),hash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().uuid(),accepted:z.literal(true),reason:z.string().trim().max(160).default('')}).strict().parse(input);
  const value=normalize({orderId:parsed.orderId,visitIds:parsed.visitIds,...(parsed.roomIds?{roomIds:parsed.roomIds}:{}),...(parsed.operation?{operation:parsed.operation}:{})});
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
