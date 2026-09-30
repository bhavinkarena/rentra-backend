import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import {
  previewCancellation,
  commitCancellation,
} from '../../src/services/booking/cancellation.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import {
  startCheckoutPayment,
  verifyCheckoutPayment,
} from '../../src/services/payments/checkout-service.js';
import {
  ingestRazorpayEvent,
  processNextPaymentEvent,
} from '../../src/services/payments/webhooks.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';
import {
  listPaymentOrders,
  readPaymentOrder,
  reconcilePaymentOrder,
} from '../../src/services/payments/investigation.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_TEST_KEY_ID: 'rzp_test_CP19KEY1234',
  RAZORPAY_TEST_KEY_SECRET: 'cp19-disposable-key-secret',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'cp19-disposable-webhook-secret',
};

/** A fake Razorpay transport: orders are created on POST; payments are whatever the test registers. */
function fakeProvider() {
  const orders = new Map(),
    payments = new Map();
  let counter = 0;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    let reply = null;
    if (path === 'orders' && body) {
      const id = `order_CP19${++counter}`;
      reply = {
        id,
        amount: body.amount,
        currency: 'INR',
        receipt: body.receipt,
        partial_payment: false,
      };
      orders.set(id, reply);
    } else if (/^orders\/[^/]+\/payments$/.test(path)) {
      reply = { items: [...payments.values()].filter((p) => p.order_id === path.split('/')[1]) };
    } else if (path.startsWith('payments/')) {
      reply = payments.get(path.split('/')[1]) ?? null;
    }
    return { ok: Boolean(reply), json: async () => reply };
  };
  return {
    fetcher,
    orders,
    payments,
    capture: (order, id, amount = order.amount) =>
      payments.set(id, {
        id,
        order_id: order.id,
        amount,
        currency: 'INR',
        status: 'captured',
        captured: true,
      }),
  };
}

test(
  'CP19 investigation: environment-separated totals, verified-only money, reconcile, webhook evidence and disabled gateway',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const [{ udt_name }] =
        await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
      if (udt_name !== 'geometry') {
        await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
        await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
      }
      const slot = {
        enabled: true,
        startTime: '09:00',
        endTime: '18:00',
        endDayOffset: 0,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        capacity: 12,
        includedGuests: 12,
        extraGuestChargeMinor: 0,
      };
      await sql`UPDATE rentable SET status='live',booking_config=${sql.json({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })} WHERE id=${f.listing}`;
      const [legacy] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${booked.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${legacy.id},'booking','committed',${legacy.starts_at},${legacy.ends_at})`;
      const days = [10, 11, 12, 13, 14, 15, 16].map((d) => addLocalDays(propertyToday(), d));
      await openBookingDates(sql, f.owner, {
        rentableId: f.listing,
        from: days[0],
        to: days.at(-1),
      });
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: f.admin,
          expectedVersion: 0,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      const [row] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${booked.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: booked.customer, sessionId: row.id };
      const admin = { kind: 'admin', id: f.admin };
      const provider = fakeProvider();
      const opts = { env, fetcher: provider.fetcher };
      const hold = async (dates) => {
        const quote = await createBookingQuote(
          sql,
          { rentableId: f.listing, dates, slot: 'day', guests: 2 },
          { customerId: booked.customer, variables: env },
        );
        const held = await createCheckoutHold(
          sql,
          session,
          {
            rentableId: f.listing,
            quoteId: quote.id,
            hash: quote.hash,
            version: quote.version,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        );
        const started = await startCheckoutPayment(sql, session, held.orderId, opts);
        return { ...held, providerOrder: provider.orders.get(started.providerOrderId) };
      };
      const sign = (order, paymentId) =>
        createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
          .update(`${order}|${paymentId}`)
          .digest('hex');

      // A: paid two-visit order, then the customer cancels visit 2 → one pending refund obligation.
      const a = await hold([days[0], days[1]]);
      provider.capture(a.providerOrder, 'pay_CP19A');
      await verifyCheckoutPayment(
        sql,
        session,
        {
          orderId: a.orderId,
          paymentId: 'pay_CP19A',
          signature: sign(a.providerOrder.id, 'pay_CP19A'),
        },
        opts,
      );
      const [, v2] =
        await sql`SELECT id FROM booking WHERE order_id=${a.orderId} ORDER BY item_position`;
      const estimate = await previewCancellation(
        sql,
        session,
        { orderId: a.orderId, visitIds: [v2.id] },
        env,
      );
      await commitCancellation(
        sql,
        session,
        {
          orderId: a.orderId,
          visitIds: [v2.id],
          hash: estimate.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        },
        env,
      );

      // B: provider captured but Rentra never heard back → awaiting provider; admin re-fetch settles it once.
      const b = await hold([days[2]]);
      provider.capture(b.providerOrder, 'pay_CP19B');
      const listed = await listPaymentOrders(sql, admin, { attention: 'needs_review' });
      assert.ok(
        listed.items.some(
          (i) =>
            i.id === b.paymentOrderId &&
            i.status.key === 'awaiting_provider' &&
            i.status.reconcilable,
        ),
      );
      const key = randomUUID();
      const first = await reconcilePaymentOrder(
        sql,
        admin,
        { id: b.paymentOrderId, requestKey: key },
        opts,
      );
      assert.deepEqual(
        [first.outcome, first.stateAfter, first.bookingStateAfter],
        ['checked', 'succeeded', 'confirmed'],
      );
      const boom = async () => {
        throw new Error('a replay must not call the provider');
      };
      assert.equal(
        (
          await reconcilePaymentOrder(
            sql,
            admin,
            { id: b.paymentOrderId, requestKey: key },
            { env, fetcher: boom },
          )
        ).replayed,
        true,
      );
      await assert.rejects(
        reconcilePaymentOrder(sql, admin, { id: b.paymentOrderId, requestKey: randomUUID() }, opts),
        { code: 'NOTHING_TO_RECONCILE' },
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM payment_transaction WHERE provider_payment_id='pay_CP19B' AND kind='capture'`
        )[0].n,
        1,
      );

      // B2: the provider has no payment for this order → unresolved, nothing marked paid.
      const nothing = await hold([days[5]]);
      const unresolved = await reconcilePaymentOrder(
        sql,
        admin,
        { id: nothing.paymentOrderId, requestKey: randomUUID() },
        opts,
      );
      assert.deepEqual(
        [unresolved.outcome, unresolved.code, unresolved.stateAfter],
        ['unresolved', 'NO_PROVIDER_OUTCOME', 'processing'],
      );

      // C: a signed webhook is stored as an object and settles through the provider re-fetch.
      const c = await hold([days[3]]);
      provider.capture(c.providerOrder, 'pay_CP19C');
      const webhook = (paymentId, orderId, eventId) => {
        const raw = Buffer.from(
          JSON.stringify({
            event: 'payment.captured',
            payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
          }),
        );
        return ingestRazorpayEvent(
          sql,
          raw,
          createHmac('sha256', env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex'),
          eventId,
          env,
        );
      };
      await webhook('pay_CP19C', c.providerOrder.id, 'evt_CP19C');
      const [stored] =
        await sql`SELECT jsonb_typeof(redacted_payload) kind,redacted_payload->>'orderId' order_id FROM payment_event WHERE external_event_id='evt_CP19C'`;
      assert.deepEqual([stored.kind, stored.order_id], ['object', c.providerOrder.id]);
      assert.equal(await processNextPaymentEvent(sql, opts), true);
      assert.equal(
        (await sql`SELECT state FROM payment_order WHERE id=${c.paymentOrderId}`)[0].state,
        'succeeded',
      );

      // D: a genuinely signed callback whose provider record disagrees cannot mark paid.
      const d = await hold([days[4]]);
      provider.capture(d.providerOrder, 'pay_CP19D', 1);
      await webhook('pay_CP19D', d.providerOrder.id, 'evt_CP19D');
      await processNextPaymentEvent(sql, opts);
      const [event] =
        await sql`SELECT state,failure_code FROM payment_event WHERE external_event_id='evt_CP19D'`;
      assert.deepEqual([event.state, event.failure_code], ['failed', 'PROVIDER_PAYMENT_MISMATCH']);
      assert.equal(
        (await sql`SELECT state FROM payment_order WHERE id=${d.paymentOrderId}`)[0].state,
        'processing',
      );
      const dDetail = await readPaymentOrder(sql, admin, d.paymentOrderId);
      assert.equal(dDetail.status.attention, true);
      assert.equal(dDetail.events[0].failureCode, 'PROVIDER_PAYMENT_MISMATCH');

      // E: disabling the gateway stops new attempts but not the outstanding obligation.
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: f.admin,
          expectedVersion: 1,
          provider: 'razorpay',
          environment: 'test',
          enabled: false,
          collectionPurpose: 'full',
        },
        env,
      );
      const blocked = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [days[6]], slot: 'day', guests: 2 },
        { customerId: booked.customer, variables: env },
      );
      await assert.rejects(
        createCheckoutHold(
          sql,
          session,
          {
            rentableId: f.listing,
            quoteId: blocked.id,
            hash: blocked.hash,
            version: blocked.version,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        ),
        { code: 'PAYMENTS_DISABLED' },
      );
      provider.capture(d.providerOrder, 'pay_CP19D');
      const settled = await reconcilePaymentOrder(
        sql,
        admin,
        { id: d.paymentOrderId, requestKey: randomUUID() },
        opts,
      );
      assert.equal(settled.stateAfter, 'succeeded');
      assert.equal((await readPaymentOrder(sql, admin, d.paymentOrderId)).gatewayEnabled, false);

      // F: a simulated order: provider dummy, no money moved.
      const [simOrder] =
        await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,
          amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,state,payment_mode)
        VALUES ('SIM-CP19',${booked.customer},${f.listing},'INR','Asia/Kolkata','v1','v1','{}','{"title":"Simulated farm"}',50000,4000,0,${randomUUID()},${'e'.repeat(64)},'confirmed','simulated') RETURNING id`;
      const [simVisit] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,payment_mode,units_booked,guests)
        VALUES ('SIM-CP19-V',${f.listing},${booked.customer},${simOrder.id},1,current_date+40,'day','confirmed',now()+interval '40 days',now()+interval '40 days 8 hours','INR','Asia/Kolkata',50000,4000,0,'simulated',1,2) RETURNING id`;
      const [simPayment] =
        await sql`INSERT INTO payment_order(booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,state)
        VALUES (${simOrder.id},'dummy','simulated','simulated','INR','full',54000,${randomUUID()},${'f'.repeat(64)},'succeeded') RETURNING id`;
      const [simAttempt] =
        await sql`INSERT INTO payment_attempt(payment_order_id,provider,environment,mode,currency,attempt_number,expected_minor,state)
        VALUES (${simPayment.id},'dummy','simulated','simulated','INR',1,54000,'succeeded') RETURNING id`;
      // The ledger's deferred check needs a transaction and its allocations to commit together.
      await sql.begin(async (tx) => {
        const [simTxn] =
          await tx`INSERT INTO payment_transaction(attempt_id,reference,provider,environment,mode,currency,kind,outcome,expected_minor,simulated_minor)
          VALUES (${simAttempt.id},'DUMMY_TXN_CP19','dummy','simulated','simulated','INR','simulated','succeeded',54000,54000) RETURNING id`;
        await tx`INSERT INTO payment_allocation(transaction_id,booking_id,component,simulated_minor) VALUES (${simTxn.id},${simVisit.id},'rent',54000)`;
      });

      // Totals: per-order aggregation first, per environment, matching independent ledger sums.
      const independent = async (environment) => ({
        captured: Number(
          (
            await sql`SELECT coalesce(sum(captured_minor),0)::bigint v FROM payment_transaction WHERE environment=${environment} AND kind='capture' AND outcome='succeeded' AND verified_at IS NOT NULL`
          )[0].v,
        ),
        pending: Number(
          (
            await sql`SELECT coalesce(sum(expected_minor),0)::bigint v FROM refund WHERE environment=${environment} AND state IN ('requested','processing','unknown')`
          )[0].v,
        ),
        expected: Number(
          (
            await sql`SELECT coalesce(sum(expected_minor),0)::bigint v FROM payment_order WHERE environment=${environment}`
          )[0].v,
        ),
        count: (
          await sql`SELECT count(*)::int v FROM payment_order WHERE environment=${environment}`
        )[0].v,
      });
      const testList = await listPaymentOrders(sql, admin, { environment: 'test' });
      const expectedTest = await independent('test');
      assert.equal(testList.totals.length, 1);
      assert.deepEqual(
        [
          testList.totals[0].count,
          testList.totals[0].capturedMinor,
          testList.totals[0].refundPendingMinor,
          testList.totals[0].expectedMinor,
          testList.totals[0].simulatedMinor,
        ],
        [expectedTest.count, expectedTest.captured, expectedTest.pending, expectedTest.expected, 0],
      );
      assert.ok(!testList.items.some((i) => i.id === simPayment.id));
      const all = await listPaymentOrders(sql, admin, { environment: 'all' });
      assert.deepEqual(
        all.totals.map((t) => t.environment),
        ['simulated', 'test'],
      );
      const sim = all.totals.find((t) => t.environment === 'simulated');
      assert.deepEqual([sim.simulatedMinor, sim.capturedMinor, sim.refundedMinor], [54000, 0, 0]);
      assert.equal(all.total, expectedTest.count + 1);
      assert.equal(
        (await listPaymentOrders(sql, admin, { environment: 'simulated' })).items[0].status.key,
        'simulated',
      );

      // Detail: allocations equal the verified capture; refunds linked; nothing secret leaves.
      const detailA = await readPaymentOrder(sql, admin, a.paymentOrderId);
      const allocated = detailA.transactions
        .flatMap((t) => t.allocations)
        .reduce((sum, x) => sum + x.actualMinor, 0);
      assert.equal(allocated, detailA.capturedMinor);
      assert.equal(detailA.status.key, 'refund_pending');
      assert.equal(detailA.refunds.length, 1);
      assert.ok(detailA.refunds[0].allocations.every((x) => x.visitReference));
      assert.equal(detailA.execution.credential, 'rzp_test_…1234');
      const json = JSON.stringify([detailA, all]);
      assert.doesNotMatch(
        json,
        /cp19-disposable|rzp_test_CP19KEY1234|snapshot|request_hash|idempotency/,
      );
      assert.equal(
        (await readPaymentOrder(sql, admin, c.paymentOrderId)).events[0].state,
        'processed',
      );

      // Search, pagination and access.
      assert.equal((await listPaymentOrders(sql, admin, { q: c.providerOrder.id })).total, 1);
      assert.equal(
        (await listPaymentOrders(sql, admin, { q: 'pay_CP19B' })).items[0].id,
        b.paymentOrderId,
      );
      assert.equal((await listPaymentOrders(sql, admin, { page: 999 })).page, 1);
      await assert.rejects(listPaymentOrders(sql, { kind: 'owner', id: f.owner }), {
        code: 'OPERATOR_REQUIRED',
      });
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.second}`;
      await assert.rejects(
        readPaymentOrder(sql, { kind: 'admin', id: f.second }, a.paymentOrderId),
        { code: 'OPERATOR_REQUIRED' },
      );
      await assert.rejects(readPaymentOrder(sql, admin, randomUUID()), {
        code: 'PAYMENT_NOT_FOUND',
      });
      await assert.rejects(
        reconcilePaymentOrder(sql, admin, { id: simPayment.id, requestKey: randomUUID() }, opts),
        { code: 'NOTHING_TO_RECONCILE' },
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM audit_log WHERE action='payment_reconcile_requested'`
        )[0].n,
        3,
      );
    } finally {
      await fixture.drop();
    }
  },
);
