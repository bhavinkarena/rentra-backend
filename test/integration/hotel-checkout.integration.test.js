import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/**
 * Hotel plan, Phase 7: a stay goes through the existing checkout, payment,
 * webhook, refund and cancellation machinery, against the file-backed fake
 * Razorpay. Ends with 1,000 concurrent quote+hold attempts on 5 rooms.
 */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_HOTEL7KEY123',
  RAZORPAY_KEY_SECRET: 'hotel7-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'hotel7-disposable-webhook-secret',
};

test('Phase 7: hotel booking, payment and cancellation', { skip: !process.env.PORTAL_TEST_DATABASE_URL }, async (t) => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const dir = await mkdtemp(join(tmpdir(), 'hotel7-'));
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
  const { startCheckoutPayment, verifyCheckoutPayment, reconcilePayment } = await import('@/services/payments/checkout-service.js');
  const { setPaymentGatewayConfiguration } = await import('@/services/payments/gateway-settings.js');
  const { ingestRazorpayEvent, processNextPaymentEvent } = await import('@/services/payments/webhooks.js');
  const { reconcileRefund, runRefundJobs } = await import('@/services/payments/refunds.js');
  const { previewCancellation, commitCancellation } = await import('@/services/booking/cancellation.js');
  const { readBookingRecord } = await import('@/services/booking/records.js');
  const { bookingSummary } = await import('@/services/domain/booking-record.js');
  const { expireInventoryHolds, withListingInventory } = await import('@/services/booking/inventory.js');

  const h = await seedHotel(sql, { deluxeRooms: 5 });
  await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
  await setPaymentGatewayConfiguration(sql, { actorId: h.admin, expectedVersion: 0, provider: 'razorpay', environment: 'test', enabled: true, collectionPurpose: 'advance' }, env);

  const providerFile = join(dir, 'provider.json');
  const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
  const provider = async (change) => {
    const state = JSON.parse(await readFile(providerFile, 'utf8'));
    change(state);
    await writeFile(providerFile, JSON.stringify(state));
  };
  const providerPayment = (orderId, id, status) => provider((state) => {
    state.payments[id] = { id, order_id: orderId, amount: state.orders[orderId].amount, currency: 'INR', status, captured: status === 'captured' };
  });
  const sign = (orderId, paymentId) => createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const guest = async () => {
    const id = await seedCustomer(sql);
    const [row] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${id},now()+interval '1 day') RETURNING id`;
    return { role: 'customer', userId: id, sessionId: row.id };
  };
  let offset = 20;
  const stay = (nights = 2) => {
    const checkIn = addLocalDays(propertyToday(), offset);
    offset += 3;
    return { checkIn, checkOut: addLocalDays(checkIn, nights) };
  };
  const rooms = (count = 1, plan = h.deluxeBase) => Array.from({ length: count }, () => ({ roomTypeId: h.deluxe, ratePlanId: plan, adults: 2, childAges: [] }));
  async function book(session, dates, { count = 1, plan = h.deluxeBase, details } = {}) {
    const quote = await createStayQuote(sql, { rentableId: h.hotel, ...dates, rooms: rooms(count, plan) }, { customerId: session.userId });
    const held = await createCheckoutHold(sql, session, {
      rentableId: h.hotel, quoteId: quote.id, hash: quote.hash, version: quote.version, idempotencyKey: randomUUID(), accepted: true,
      stay: details ?? { guestNames: Array.from({ length: count }, (_, i) => `Guest ${i + 1}`) },
    }, env);
    return { quote, held };
  }
  const roomStates = async (orderId) => (await sql`SELECT br.state FROM booking_room br JOIN booking b ON b.id=br.booking_id WHERE b.order_id=${orderId} ORDER BY br.id`).map((r) => r.state);

  await t.test('success: quote → hold → pay → confirmed; rooms booked; money allocated as room + tax', async () => {
    const session = await guest();
    const { quote, held } = await book(session, stay(), {
      count: 2, details: { guestNames: ['Asha Patel', 'Ravi Patel'], arrivalTime: '18:30', requests: 'Adjoining rooms', gstin: '24ABCDE1234F1Z5', businessName: 'Patel Textiles' },
    });
    assert.equal(held.state, 'held');
    assert.equal(held.expectedMinor, quote.totals.totalMinor, 'stays are prepaid in full even when the gateway default is an advance');
    assert.deepEqual(await roomStates(held.orderId), ['held', 'held']);
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    providerCaptures(providerFile, started.providerOrderId, 'pay_HOTEL1');
    const done = await verifyCheckoutPayment(sql, session, { orderId: held.orderId, paymentId: 'pay_HOTEL1', signature: sign(started.providerOrderId, 'pay_HOTEL1') }, opts);
    assert.equal(done.state, 'confirmed');
    assert.deepEqual(await roomStates(held.orderId), ['booked', 'booked']);
    const parts = await sql`SELECT component::text, actual_minor::int AS amount FROM payment_allocation a JOIN booking b ON b.id=a.booking_id WHERE b.order_id=${held.orderId} ORDER BY component`;
    // Story 2.2: the guest service fee is its own component, 5% of rooms before tax.
    assert.deepEqual(parts.map((p) => p.component), ['fee', 'rent', 'tax']);
    assert.equal(quote.totals.feeMinor, Math.floor((quote.totals.roomMinor * 5 + 50) / 100));
    assert.equal(parts[0].amount, quote.totals.feeMinor);
    assert.equal(parts[1].amount, quote.totals.roomMinor);
    assert.equal(parts[2].amount, quote.totals.taxMinor);
    assert.equal(quote.totals.totalMinor, quote.totals.roomMinor + quote.totals.taxMinor + quote.totals.feeMinor);
    const record = await readBookingRecord(sql, { kind: 'customer', session }, held.orderId, env);
    assert.equal(record.stay.rooms.length, 2);
    assert.equal(record.stay.details.gstin, '24ABCDE1234F1Z5');
    assert.match(bookingSummary(record), /GST invoice to: Patel Textiles \(GSTIN 24ABCDE1234F1Z5\)/);
  });

  await t.test('guest details are required and validated', async () => {
    const session = await guest();
    const dates = stay();
    const quote = await createStayQuote(sql, { rentableId: h.hotel, ...dates, rooms: rooms(1) }, { customerId: session.userId });
    const base = { rentableId: h.hotel, quoteId: quote.id, hash: quote.hash, version: quote.version, accepted: true };
    await assert.rejects(createCheckoutHold(sql, session, { ...base, idempotencyKey: randomUUID() }, env), { code: 'GUEST_DETAILS_REQUIRED' });
    await assert.rejects(createCheckoutHold(sql, session, { ...base, idempotencyKey: randomUUID(), stay: { guestNames: ['A B'], gstin: 'BAD' } }, env), { name: 'ZodError' });
    await assert.rejects(createCheckoutHold(sql, session, { ...base, idempotencyKey: randomUUID(), stay: { guestNames: ['A B'], gstin: '24ABCDE1234F1Z5' } }, env), { name: 'ZodError' }, 'GSTIN needs a business name');
  });

  await t.test('failure keeps the hold; an expired hold puts the rooms back', async () => {
    const session = await guest();
    const { held } = await book(session, stay());
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    await providerPayment(started.providerOrderId, 'pay_HOTELFAIL', 'failed');
    await reconcilePayment(sql, started.paymentOrderId, opts);
    const [order] = await sql`SELECT state FROM booking_order WHERE id=${held.orderId}`;
    assert.equal(order.state, 'held', 'a failed attempt does not end the hold; the guest can try again');
    assert.deepEqual(await roomStates(held.orderId), ['held']);
    await withListingInventory(sql, h.hotel, (tx) => expireInventoryHolds(tx, h.hotel, new Date(Date.now() + 16 * 60_000)));
    assert.deepEqual(await roomStates(held.orderId), ['released']);
  });

  await t.test('pending UPI: authorized → processing, then captured → confirmed', async () => {
    const session = await guest();
    const { held } = await book(session, stay());
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    await providerPayment(started.providerOrderId, 'pay_HOTELUPI', 'authorized');
    await reconcilePayment(sql, started.paymentOrderId, opts);
    const [po] = await sql`SELECT state FROM payment_order WHERE id=${started.paymentOrderId}`;
    assert.equal(po.state, 'processing');
    assert.deepEqual(await roomStates(held.orderId), ['held']);
    await providerPayment(started.providerOrderId, 'pay_HOTELUPI', 'captured');
    await reconcilePayment(sql, started.paymentOrderId, opts);
    assert.deepEqual(await roomStates(held.orderId), ['booked']);
  });

  await t.test('duplicate webhook is processed once', async () => {
    const session = await guest();
    const { held } = await book(session, stay());
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    providerCaptures(providerFile, started.providerOrderId, 'pay_HOTELHOOK');
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_HOTELHOOK', order_id: started.providerOrderId } } } }));
    const signature = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    const first = await ingestRazorpayEvent(sql, raw, signature, 'evt_hotel_1', env);
    const second = await ingestRazorpayEvent(sql, raw, signature, 'evt_hotel_1', env);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    while (await processNextPaymentEvent(sql, opts));
    const [{ captures }] = await sql`SELECT count(*)::int captures FROM payment_transaction WHERE provider_payment_id='pay_HOTELHOOK' AND kind='capture'`;
    assert.equal(captures, 1);
    assert.deepEqual(await roomStates(held.orderId), ['booked']);
  });

  await t.test('late capture after the hold expired: rooms stay free and the money is refunded (success and failure)', async () => {
    for (const outcome of ['processed', 'failed']) {
      const session = await guest();
      const { held } = await book(session, stay());
      const started = await startCheckoutPayment(sql, session, held.orderId, opts);
      // The hold runs out before the capture arrives (accepted terms are otherwise immutable).
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE booking_order DISABLE TRIGGER checkout_terms`;
        await tx`UPDATE booking_order SET hold_expires_at=now()-interval '1 minute' WHERE id=${held.orderId}`;
        await tx`ALTER TABLE booking_order ENABLE TRIGGER checkout_terms`;
      });
      providerCaptures(providerFile, started.providerOrderId, `pay_HOTELLATE${outcome}`);
      await reconcilePayment(sql, started.paymentOrderId, opts);
      const [order] = await sql`SELECT state FROM booking_order WHERE id=${held.orderId}`;
      assert.ok(['expired', 'cancelled'].includes(order.state), order.state);
      assert.deepEqual(await roomStates(held.orderId), ['released']);
      const [refund] = await sql`SELECT r.id,r.expected_minor::int expected FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id
        WHERE t.provider_payment_id=${`pay_HOTELLATE${outcome}`}`;
      assert.ok(refund.expected > 0);
      await runRefundJobs(sql, opts);
      await provider((state) => { for (const r of Object.values(state.refunds)) if (r.payment_id === `pay_HOTELLATE${outcome}`) r.status = outcome; });
      await reconcileRefund(sql, refund.id, opts).catch(() => {});
      const [after] = await sql`SELECT state FROM refund WHERE id=${refund.id}`;
      assert.equal(after.state, outcome === 'processed' ? 'succeeded' : 'unknown', `refund ${outcome}`);
    }
  });

  await t.test('self-serve cancellation: free before the deadline (room + tax back), rooms released', async () => {
    const session = await guest();
    const { quote, held } = await book(session, stay());
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    providerCaptures(providerFile, started.providerOrderId, 'pay_HOTELCANCEL');
    await verifyCheckoutPayment(sql, session, { orderId: held.orderId, paymentId: 'pay_HOTELCANCEL', signature: sign(started.providerOrderId, 'pay_HOTELCANCEL') }, opts);
    const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
    const preview = await previewCancellation(sql, session, { orderId: held.orderId, visitIds: [visit.id] }, env);
    assert.equal(preview.refundMinor, quote.totals.totalMinor);
    const receipt = await commitCancellation(sql, session, { orderId: held.orderId, visitIds: [visit.id], hash: preview.hash, idempotencyKey: randomUUID(), accepted: true }, env);
    assert.equal(receipt.refundMinor, quote.totals.totalMinor);
    assert.deepEqual(await roomStates(held.orderId), ['released']);
    const parts = await sql`SELECT ra.component::text, ra.expected_minor::int amount FROM refund_allocation ra WHERE ra.booking_id=${visit.id} ORDER BY component`;
    assert.deepEqual(parts.map((p) => [p.component, p.amount]), [['fee', quote.totals.feeMinor], ['rent', quote.totals.roomMinor], ['tax', quote.totals.taxMinor]]);
  });

  await t.test('non-refundable rate keeps the whole stay', async () => {
    const session = await guest();
    const { held } = await book(session, stay(), { plan: h.deluxeNonRefundable });
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    providerCaptures(providerFile, started.providerOrderId, 'pay_HOTELNR');
    await verifyCheckoutPayment(sql, session, { orderId: held.orderId, paymentId: 'pay_HOTELNR', signature: sign(started.providerOrderId, 'pay_HOTELNR') }, opts);
    const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
    const preview = await previewCancellation(sql, session, { orderId: held.orderId, visitIds: [visit.id] }, env);
    assert.equal(preview.refundMinor, 0);
  });

  await t.test('1,000 concurrent quote+hold attempts on 5 rooms: never more than 5 held', async () => {
    const dates = stay(1);
    const sessions = await Promise.all(Array.from({ length: 400 }, guest));
    let held = 0, refused = 0, next = 0;
    const attempt = async () => {
      while (next < 1000) {
        const session = sessions[next++ % sessions.length];
        try {
          await book(session, dates);
          held += 1;
        } catch (error) {
          refused += 1;
          assert.ok(['SOLD_OUT', 'AVAILABILITY_CONFLICT', 'TOO_MANY_HOLDS', 'QUOTE_CHANGED', 'ROOM_UNAVAILABLE'].includes(error.code), `${error.code}: ${error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 25 }, attempt));
    const [night] = await sql`SELECT held, sold, allotment FROM room_night WHERE room_type_id=${h.deluxe} AND night=${dates.checkIn}`;
    t.diagnostic(`held ${held}, refused ${refused}`);
    assert.equal(held, 5);
    assert.equal(held + refused, 1000);
    assert.equal(night.held + night.sold, 5);
    assert.ok(night.held + night.sold <= night.allotment);
  });
});
