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
  listRefunds,
  previewOperatorRefund,
  readRefund,
  reconcileRefundObligation,
  requestOperatorRefund,
} from '../../src/services/payments/refund-operations.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_CP20KEY1234',
  RAZORPAY_KEY_SECRET: 'cp20-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'cp20-disposable-webhook-secret',
};

/** Fake Razorpay with refunds: a refund POST can be accepted while its response is lost. */
function fakeProvider() {
  const orders = new Map();
  const payments = new Map();
  const refunds = new Map();
  const posts = [];
  let counter = 0;
  let dropNextRefund = false;
  const fetcher = async (url, init) => {
    const target = new URL(url);
    const path = target.pathname.replace('/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    let reply = null;
    if (path === 'orders' && body) {
      reply = {
        id: `order_CP20${++counter}`,
        amount: body.amount,
        currency: 'INR',
        receipt: body.receipt,
        partial_payment: false,
      };
      orders.set(reply.id, reply);
    } else if (/^orders\/[^/]+\/payments$/.test(path)) {
      reply = { items: [...payments.values()].filter((p) => p.order_id === path.split('/')[1]) };
    } else if (/^payments\/[^/]+\/refund$/.test(path) && body) {
      const refund = {
        id: `rfnd_CP20${++counter}`,
        payment_id: path.split('/')[1],
        amount: body.amount,
        currency: 'INR',
        receipt: body.receipt,
        status: 'pending',
      };
      refunds.set(refund.id, refund);
      posts.push(body.receipt);
      reply = dropNextRefund ? null : refund;
      dropNextRefund = false;
    } else if (/^payments\/[^/]+\/refunds$/.test(path)) {
      reply = { items: [...refunds.values()].filter((r) => r.payment_id === path.split('/')[1]) };
    } else if (path.startsWith('refunds/')) {
      reply = refunds.get(path.split('/')[1]) ?? null;
    } else if (path.startsWith('payments/')) {
      reply = payments.get(path.split('/')[1]) ?? null;
    }
    return { ok: Boolean(reply), json: async () => reply };
  };
  return {
    fetcher,
    orders,
    refunds,
    posts,
    loseNextRefundResponse: () => {
      dropNextRefund = true;
    },
    setRefund: (receipt, status) => {
      for (const refund of refunds.values()) if (refund.receipt === receipt) refund.status = status;
    },
    capture: (order, id) =>
      payments.set(id, {
        id,
        order_id: order.id,
        amount: order.amount,
        currency: 'INR',
        status: 'captured',
        captured: true,
      }),
  };
}

test(
  'CP20 refunds: capped operator refunds, single dispatch, lost responses, duplicate callbacks and failed refunds',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql);
      const booked = await seedConfirmedBooking(sql, f.listing);
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
      const days = [10, 11].map((d) => addLocalDays(propertyToday(), d));
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: days[0], to: days[1] });
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

      // A paid two-visit order; the customer cancels visit 2 → a queued refund obligation.
      const quote = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: days, slot: 'day', guests: 2 },
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
      const order = provider.orders.get(started.providerOrderId);
      provider.capture(order, 'pay_CP20A');
      const signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
        .update(`${order.id}|pay_CP20A`)
        .digest('hex');
      await verifyCheckoutPayment(
        sql,
        session,
        { orderId: held.orderId, paymentId: 'pay_CP20A', signature },
        opts,
      );
      const [v1, v2] =
        await sql`SELECT id FROM booking WHERE order_id=${held.orderId} ORDER BY item_position`;
      const estimate = await previewCancellation(
        sql,
        session,
        { orderId: held.orderId, visitIds: [v2.id] },
        env,
      );
      await commitCancellation(
        sql,
        session,
        {
          orderId: held.orderId,
          visitIds: [v2.id],
          hash: estimate.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        },
        env,
      );
      const [r1] = await sql`SELECT id FROM refund ORDER BY created_at LIMIT 1`;

      // Queue and detail: source, allocation and an honest queued status.
      let list = await listRefunds(sql, admin, {});
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0].source, 'customer_cancellation');
      assert.equal(list.items[0].status.key, 'queued');
      assert.equal(list.totals.length, 1);
      assert.equal(list.totals[0].environment, 'test');
      let detail = await readRefund(sql, admin, r1.id);
      assert.equal(detail.origin.kind, 'customer_cancellation');
      assert.ok(detail.allocations.length >= 1);
      await assert.rejects(listRefunds(sql, { kind: 'admin', id: randomUUID() }, {}), {
        code: 'OPERATOR_REQUIRED',
      });

      // Operator refund: previewed, capped and serialised.
      const base = { orderId: held.orderId, visitId: v1.id };
      let preview = await previewOperatorRefund(sql, admin, base);
      const rent = preview.components.find((c) => c.component === 'rent');
      assert.ok(rent.remainingMinor > 0);
      assert.match(
        (await previewOperatorRefund(sql, admin, { ...base, rent: rent.remainingMinor + 1 }))
          .blocked,
        /exceeds what remains/,
      );
      const full = await previewOperatorRefund(sql, admin, { ...base, rent: rent.remainingMinor });
      const race = await Promise.allSettled([
        requestOperatorRefund(sql, admin, {
          ...base,
          rent: rent.remainingMinor,
          reason: 'Goodwill for a broken pump',
          hash: full.hash,
          requestKey: randomUUID(),
        }),
        requestOperatorRefund(sql, admin, {
          ...base,
          rent: rent.remainingMinor,
          reason: 'Goodwill for a broken pump',
          hash: full.hash,
          requestKey: randomUUID(),
        }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'PREVIEW_CHANGED');
      preview = await previewOperatorRefund(sql, admin, base);
      assert.equal(
        preview.components.find((c) => c.component === 'rent').remainingMinor,
        0,
        'nothing left to refund twice',
      );
      const [{ reserved, captured }] = await sql`SELECT
          (SELECT sum(ra.expected_minor) FROM refund_allocation ra WHERE ra.booking_id=${v1.id} AND ra.component='rent')::int reserved,
          (SELECT sum(pa.actual_minor) FROM payment_allocation pa WHERE pa.booking_id=${v1.id} AND pa.component='rent')::int captured`;
      assert.ok(reserved <= captured, 'reservations never exceed the captured rent');
      const fee = preview.components.find((c) => c.component === 'fee').remainingMinor;
      const feePreview = await previewOperatorRefund(sql, admin, { ...base, fee });
      const key = randomUUID();
      const operatorRefund = await requestOperatorRefund(sql, admin, {
        ...base,
        fee,
        reason: 'Fee returned for a late check-in',
        hash: feePreview.hash,
        requestKey: key,
      });
      const replay = await requestOperatorRefund(sql, admin, {
        ...base,
        fee,
        reason: 'Fee returned for a late check-in',
        hash: feePreview.hash,
        requestKey: key,
      });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.refundIds, operatorRefund.refundIds);
      await assert.rejects(
        requestOperatorRefund(sql, admin, {
          ...base,
          fee: 1,
          reason: 'A different refund entirely',
          hash: feePreview.hash,
          requestKey: key,
        }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      const r2 = operatorRefund.refundIds[0];
      assert.equal((await readRefund(sql, admin, r2)).origin.kind, 'operator');

      // Timeout after provider acceptance: the provider has it, Rentra lost the response.
      provider.loseNextRefundResponse();
      const lost = await reconcileRefundObligation(
        sql,
        admin,
        { id: r1.id, requestKey: randomUUID() },
        opts,
      );
      assert.equal(lost.outcome, 'unresolved');
      assert.equal((await readRefund(sql, admin, r1.id)).status.key, 'uncertain');
      const checked = await reconcileRefundObligation(
        sql,
        admin,
        { id: r1.id, requestKey: randomUUID() },
        opts,
      );
      assert.equal(checked.outcome, 'pending');
      assert.equal(
        provider.posts.filter((receipt) => receipt === r1.id).length,
        1,
        'the lost response is looked up, never resent',
      );

      // Repeated and concurrent operator commands: one provider refund per obligation.
      const repeatKey = randomUUID();
      const first = await reconcileRefundObligation(
        sql,
        admin,
        { id: r2, requestKey: repeatKey },
        opts,
      );
      const again = await reconcileRefundObligation(
        sql,
        admin,
        { id: r2, requestKey: repeatKey },
        opts,
      );
      assert.equal(again.replayed, true);
      assert.equal(again.outcome, first.outcome);
      await Promise.allSettled(
        [1, 2, 3].map(() =>
          reconcileRefundObligation(sql, admin, { id: r2, requestKey: randomUUID() }, opts),
        ),
      );
      assert.equal(provider.posts.filter((receipt) => receipt === r2).length, 1);

      // Duplicate provider callbacks settle once.
      provider.setRefund(r1.id, 'processed');
      const [remote] = [...provider.refunds.values()].filter((r) => r.receipt === r1.id);
      const raw = Buffer.from(
        JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: remote } } }),
      );
      const sign = (body) =>
        createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
      const one = await ingestRazorpayEvent(sql, raw, sign(raw), 'evt_CP20_1', env);
      const duplicate = await ingestRazorpayEvent(sql, raw, sign(raw), 'evt_CP20_1', env);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.id, one.id);
      await ingestRazorpayEvent(sql, raw, sign(raw), 'evt_CP20_2', env);
      while (await processNextPaymentEvent(sql, opts));
      detail = await readRefund(sql, admin, r1.id);
      assert.equal(detail.status.key, 'refunded');
      assert.equal(detail.actualMinor, detail.expectedMinor);
      assert.equal(detail.events.length, 2);
      assert.equal(
        detail.history.filter((h) => h.kind === 'refund_processed').length,
        1,
        'one refunded record despite two callbacks',
      );
      await assert.rejects(
        reconcileRefundObligation(sql, admin, { id: r1.id, requestKey: randomUUID() }, opts),
        { code: 'NOTHING_TO_RECONCILE' },
      );

      // A refund the provider reports failed keeps its reservation and is never resent.
      provider.setRefund(r2, 'failed');
      const failed = await reconcileRefundObligation(
        sql,
        admin,
        { id: r2, requestKey: randomUUID() },
        opts,
      );
      assert.equal(failed.outcome, 'unresolved');
      const failedDetail = await readRefund(sql, admin, r2);
      assert.equal(failedDetail.status.key, 'provider_failed');
      assert.equal(failedDetail.status.command, 'check');
      assert.equal(provider.posts.filter((receipt) => receipt === r2).length, 1);
      assert.equal(
        (await previewOperatorRefund(sql, admin, base)).components.find(
          (c) => c.component === 'fee',
        ).remainingMinor,
        0,
      );

      // Filters and totals follow the same status keys.
      list = await listRefunds(sql, admin, { status: 'attention' });
      assert.ok(list.items.some((i) => i.id === r2));
      assert.ok(
        (await listRefunds(sql, admin, { status: 'refunded' })).items.every(
          (i) => i.status.key === 'refunded',
        ),
      );
      assert.equal((await listRefunds(sql, admin, { source: 'operator' })).total, 2);
      const totals = (await listRefunds(sql, admin, { environment: 'all' })).totals;
      assert.deepEqual(
        totals.map((t) => t.environment),
        ['test'],
      );
      assert.equal(totals[0].refundedMinor, detail.actualMinor);
    } finally {
      await fixture.drop();
    }
  },
);
