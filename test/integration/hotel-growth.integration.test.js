import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/** Hotel plan, Phase 10: cancel some rooms, change a stay, stay-worded messages, weekly KPIs. */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_HOTEL10KEY12',
  RAZORPAY_KEY_SECRET: 'hotel10-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'hotel10-disposable-webhook-secret',
};

test('Phase 10: hotel booking flow — partial cancellation, change booking, KPIs', { skip: !process.env.PORTAL_TEST_DATABASE_URL }, async (t) => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const dir = await mkdtemp(join(tmpdir(), 'hotel10-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await fixture.drop();
  });
  const { sql } = fixture;
  globalThis.__rentraSql = sql;
  process.env.DATABASE_URL = fixture.url;
  Object.assign(process.env, { RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET });
  const { createStayQuote } = await import('@/services/booking/hotel-checkout.js');
  const { createCheckoutHold } = await import('@/services/booking/checkout.js');
  const { startCheckoutPayment, verifyCheckoutPayment } = await import('@/services/payments/checkout-service.js');
  const { setPaymentGatewayConfiguration } = await import('@/services/payments/gateway-settings.js');
  const { previewCancellation, commitCancellation } = await import('@/services/booking/cancellation.js');
  const { getAdminHotelAnalytics } = await import('@/services/analytics/hotel-analytics.js');
  const { notificationMessage } = await import('@/services/domain/notifications.js');

  const h = await seedHotel(sql, { deluxeRooms: 5 });
  await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
  await setPaymentGatewayConfiguration(sql, { actorId: h.admin, expectedVersion: 0, provider: 'razorpay', environment: 'test', enabled: true, collectionPurpose: 'full' }, env);
  const providerFile = join(dir, 'provider.json');
  const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
  const customer = await seedCustomer(sql);
  const [row] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${customer},now()+interval '1 day') RETURNING id`;
  const session = { role: 'customer', userId: customer, sessionId: row.id };
  const roomsOf = (count, plan) => Array.from({ length: count }, () => ({ roomTypeId: h.deluxe, ratePlanId: plan, adults: 2, childAges: [] }));
  async function pay(input) {
    const quote = await createStayQuote(sql, { rentableId: h.hotel, ...input }, { customerId: customer });
    const held = await createCheckoutHold(sql, session, { rentableId: h.hotel, quoteId: quote.id, hash: quote.hash, version: quote.version, idempotencyKey: randomUUID(), accepted: true,
      stay: { guestNames: input.rooms.map((_, i) => `Guest ${i + 1}`) } }, env);
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    const paymentId = `pay_H10${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    providerCaptures(providerFile, started.providerOrderId, paymentId);
    await verifyCheckoutPayment(sql, session, { orderId: held.orderId, paymentId, signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${started.providerOrderId}|${paymentId}`).digest('hex') }, opts);
    const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
    return { quote, orderId: held.orderId, visitId: visit.id };
  }
  const checkIn = addLocalDays(propertyToday(), 20);

  await t.test('cancel one room of a two-room stay: that room is refunded and released, the stay stays booked', async () => {
    const stay = await pay({ checkIn, checkOut: addLocalDays(checkIn, 2), rooms: roomsOf(2, h.deluxeBase) });
    const rooms = await sql`SELECT id, (amount_room_minor + amount_tax_minor)::int AS total FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
    const preview = await previewCancellation(sql, session, { orderId: stay.orderId, visitIds: [stay.visitId], roomIds: [rooms[0].id] }, env);
    // Story 2.2: each room refund also returns its share of the guest service fee.
    const feeShare = Math.floor((stay.quote.totals.feeMinor * rooms[0].total) / (rooms[0].total + rooms[1].total));
    assert.equal(preview.refundMinor, rooms[0].total + feeShare, JSON.stringify(preview.visits));
    await commitCancellation(sql, session, { orderId: stay.orderId, visitIds: [stay.visitId], roomIds: [rooms[0].id], hash: preview.hash, idempotencyKey: randomUUID(), accepted: true }, env);
    const states = await sql`SELECT id, state FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
    assert.deepEqual(states.map((r) => r.state), ['released', 'booked']);
    const [visit] = await sql`SELECT state FROM booking WHERE id=${stay.visitId}`;
    assert.equal(visit.state, 'confirmed');
    const [{ held }] = await sql`SELECT (sold + held)::int AS held FROM room_night WHERE room_type_id=${h.deluxe} AND night=${checkIn}`;
    assert.equal(held, 1, 'the cancelled room is back on sale');
    // The last room cancels the whole stay.
    const rest = await previewCancellation(sql, session, { orderId: stay.orderId, visitIds: [stay.visitId] }, env);
    assert.equal(rest.refundMinor, rooms[1].total + stay.quote.totals.feeMinor - feeShare, 'the rest of the fee, nothing stranded');
  });

  await t.test('change dates: new stay paid, old stay cancelled and refunded in full', async () => {
    const old = await pay({ checkIn: addLocalDays(checkIn, 5), checkOut: addLocalDays(checkIn, 7), rooms: roomsOf(1, h.deluxeBase) });
    const moved = await pay({ checkIn: addLocalDays(checkIn, 10), checkOut: addLocalDays(checkIn, 13), rooms: roomsOf(1, h.deluxeBase), replacesOrderId: old.orderId });
    const [before] = await sql`SELECT state FROM booking_order WHERE id=${old.orderId}`;
    assert.equal(before.state, 'cancelled');
    const [{ refunded }] = await sql`SELECT sum(ra.expected_minor)::int AS refunded FROM refund_allocation ra WHERE ra.booking_id=${old.visitId}`;
    assert.equal(refunded, old.quote.totals.totalMinor);
    const [after] = await sql`SELECT state FROM booking_order WHERE id=${moved.orderId}`;
    assert.equal(after.state, 'confirmed');
    const [reason] = await sql`SELECT cancellation_reason FROM booking WHERE id=${old.visitId}`;
    assert.match(reason.cancellation_reason, /^Changed to booking /);
  });

  await t.test('a non-refundable stay cannot be changed for free', async () => {
    const strict = await pay({ checkIn: addLocalDays(checkIn, 30), checkOut: addLocalDays(checkIn, 31), rooms: roomsOf(1, h.deluxeNonRefundable) });
    await assert.rejects(createStayQuote(sql, { rentableId: h.hotel, checkIn: addLocalDays(checkIn, 40), checkOut: addLocalDays(checkIn, 41), rooms: roomsOf(1, h.deluxeBase), replacesOrderId: strict.orderId }, { customerId: customer }), { code: 'CHANGE_NOT_ALLOWED' });
    const stranger = await seedCustomer(sql);
    await assert.rejects(createStayQuote(sql, { rentableId: h.hotel, checkIn: addLocalDays(checkIn, 40), checkOut: addLocalDays(checkIn, 41), rooms: roomsOf(1, h.deluxeBase), replacesOrderId: strict.orderId }, { customerId: stranger }), { code: 'CHANGE_NOT_ALLOWED' });
  });

  await t.test('stay messages use stay words', () => {
    assert.match(notificationMessage({ template: 'review_invitation', reference: 'R1', id: 'x', is_stay: true, visit_provenance: 'real' }), /How was your stay\?/);
    assert.match(notificationMessage({ template: 'review_invitation', reference: 'R1', id: 'x', visit_provenance: 'real' }), /How was your visit\?/);
  });

  await t.test('weekly KPIs: quotes, paid, guest cancellations', async () => {
    const report = await getAdminHotelAnalytics(sql, h.admin, { from: addLocalDays(propertyToday(), -1), to: addLocalDays(propertyToday(), 60) });
    assert.ok(report.weekly.quotes >= 4 && report.weekly.paid >= 4, JSON.stringify(report.weekly));
    assert.ok(report.weekly.guestCancelled >= 1);
    assert.ok(report.weekly.holdToPaid > 0);
  });
});
