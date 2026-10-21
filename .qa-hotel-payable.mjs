// QA-only (untracked, delete after use): on the disposable gate DB, two paid Riverside stays moved into
// the past (one checked in, one non-refundable and cancelled) so the payout and analytics screens have data.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { fileBackedRazorpay, providerCaptures } from './test/helpers/fake-razorpay.mjs';
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing');
const sql = postgres(process.env.DATABASE_URL, { max: 4, onnotice: () => {} });
globalThis.__rentraSql = sql;
const { createStayQuote } = await import('@/services/booking/hotel-checkout.js');
const { createCheckoutHold } = await import('@/services/booking/checkout.js');
const { startCheckoutPayment, verifyCheckoutPayment } = await import('@/services/payments/checkout-service.js');
const { previewCancellation, commitCancellation } = await import('@/services/booking/cancellation.js');
const { addLocalDays, propertyToday } = await import('@/services/domain/booking-dates.js');
const opts = { env: process.env, fetcher: fileBackedRazorpay(process.env.FAKE_RAZORPAY_STATE) };
const [hotel] = await sql`SELECT r.id, r.client_id FROM rentable r WHERE r.slug='riverside-residency-surat'`;
const [room] = await sql`SELECT t.id FROM room_type t WHERE t.rentable_id=${hotel.id} ORDER BY t.sort_order LIMIT 1`;
const plans = await sql`SELECT id, name FROM rate_plan WHERE room_type_id=${room.id} AND is_active ORDER BY sort_order`;
await sql`UPDATE hotel_profile SET gst_registered=true, gstin='24ABCDE1234F1Z5' WHERE rentable_id=${hotel.id}`;
if (!(await sql`SELECT 1 FROM payout_destination WHERE client_id=${hotel.client_id} AND state='verified'`).length)
  await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
    VALUES (${hotel.client_id},1,'bank','Riverside Hospitality','4421','HDFC0001234','same','verified','migration',now(),'fixture','qa',${'a'.repeat(64)},now())`;
const [guest] = await sql`SELECT id FROM "user" WHERE email='hotel-guest@rentra.invalid'`;
const [s] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${guest.id},now()+interval '1 day') RETURNING id`;
const session = { role: 'customer', userId: guest.id, sessionId: s.id };
async function stay(plan, ahead) {
  const checkIn = addLocalDays(propertyToday(), ahead);
  const quote = await createStayQuote(sql, { rentableId: hotel.id, checkIn, checkOut: addLocalDays(checkIn, 2), rooms: [{ roomTypeId: room.id, ratePlanId: plan.id, adults: 2, childAges: [] }] }, { customerId: guest.id });
  const held = await createCheckoutHold(sql, session, { rentableId: hotel.id, quoteId: quote.id, hash: quote.hash, version: quote.version, idempotencyKey: randomUUID(), accepted: true, stay: { guestNames: ['Asha Patel'] } });
  const started = await startCheckoutPayment(sql, session, held.orderId, opts);
  const pay = `pay_QAH8${randomUUID().slice(0, 8)}`;
  providerCaptures(process.env.FAKE_RAZORPAY_STATE, started.providerOrderId, pay);
  await verifyCheckoutPayment(sql, session, { orderId: held.orderId, paymentId: pay, signature: createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${started.providerOrderId}|${pay}`).digest('hex') }, opts);
  const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
  return { orderId: held.orderId, visitId: visit.id };
}
const a = await stay(plans[0], 40);
const b = await stay(plans.find((p) => /non-refundable/i.test(p.name)) ?? plans[0], 43);
const preview = await previewCancellation(sql, session, { orderId: b.orderId, visitIds: [b.visitId] });
await commitCancellation(sql, session, { orderId: b.orderId, visitIds: [b.visitId], hash: preview.hash, idempotencyKey: randomUUID(), accepted: true });
// Move both stays into the past (fixture only: accepted terms are otherwise immutable).
await sql.begin(async (tx) => {
  for (const t of ['checkout_terms', 'payment_scope_immutable', 'visit_transition_proof']) await tx.unsafe(`ALTER TABLE booking DISABLE TRIGGER ${t}`);
  for (const [v, shift, state] of [[a.visitId, 45, 'handed_over'], [b.visitId, 47, 'cancelled']]) {
    await tx`UPDATE booking SET starts_at=starts_at-${`${shift} days`}::interval, ends_at=ends_at-${`${shift} days`}::interval,
      blocked_start_at=blocked_start_at-${`${shift} days`}::interval, blocked_end_at=blocked_end_at-${`${shift} days`}::interval,
      local_day=local_day-${shift}::int, state=${state} WHERE id=${v}`;
  }
  for (const t of ['checkout_terms', 'payment_scope_immutable', 'visit_transition_proof']) await tx.unsafe(`ALTER TABLE booking ENABLE TRIGGER ${t}`);
});
console.log('payable stays ready', a.visitId, b.visitId);
await sql.end();
