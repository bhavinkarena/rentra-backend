import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  changePropertyPolicy,
  propertyPolicyHistory,
} from '../../src/services/booking/property-policy.js';
import { createBookingQuote, revalidateBookingQuote } from '../../src/services/booking/quotes.js';
import { withListingInventory } from '../../src/services/booking/inventory.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import { listBookingRecords, readBookingRecord } from '../../src/services/booking/records.js';
import { recordVisitTransition } from '../../src/services/booking/visit-lifecycle.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';
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
import { settleVerifiedPayment } from '../../src/services/payments/settlement.js';

test(
  'CP11/12 persisted policy previews, stale quotes, mixed work queues, contact scope and idempotent evidence',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    let app;
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const [{ udt_name }] =
        await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
      if (udt_name !== 'geometry') {
        await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
        await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
      }
      const schedule = {
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
      const config = {
        inventoryReady: true,
        timeZone: 'Asia/Kolkata',
        leadTimeMinutes: 60,
        bookingHorizonDays: 90,
        slots: { day: schedule, night: { enabled: false }, full_day: { enabled: false } },
      };
      await sql`UPDATE rentable SET status='live',booking_config=${sql.json(config)} WHERE id=${f.listing}`;
      // Reconcile the inherited fixture booking before any authoritative quote.
      const [visit] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${booked.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${visit.id},'booking','committed',${visit.starts_at},${visit.ends_at})`;
      const day = addLocalDays(propertyToday(), 10);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: day, to: day });
      const quote = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [day], slot: 'day', guests: 2 },
        { customerId: booked.customer },
      );
      assert.ok(quote.policy.cancellation.bands.length);
      const accepted = {
        version: 'customer-v1',
        cancellationTier: 'strict',
        cancellation: {
          bands: [
            [7, 0.5],
            [3, 0],
            [0, 0],
          ],
          noShow: 0,
          feeOnFullRefund: false,
        },
      };
      await sql`UPDATE booking_order SET policy_snapshot=${sql.json(accepted)},listing_snapshot=listing_snapshot||'{"contact":{"name":"Guest contact","phone":"9000000077"}}'::jsonb WHERE id=${booked.order}`;
      const contentVersion = async () =>
        Number(
          (await sql`SELECT content_version FROM rentable WHERE id=${f.listing}`)[0]
            .content_version,
        );
      const values = {
        day_weekday: 1800,
        day_weekend: 2200,
        night_weekday: 0,
        night_weekend: 0,
        full_day_weekday: 0,
        full_day_weekend: 0,
        extraGuestCharge: 100,
        extraHourCharge: 0,
      };
      const expectedVersion = await contentVersion();
      const preview = await changePropertyPolicy(sql, f.owner, f.listing, 'pricing', {
        values,
        expectedVersion,
        preview: true,
      });
      assert.equal(
        (await sql`SELECT weekday FROM rentable_price WHERE rentable_id=${f.listing}`)[0].weekday,
        1000,
        'preview writes nothing',
      );
      await assert.rejects(
        changePropertyPolicy(sql, f.other, f.listing, 'pricing', {
          values,
          expectedVersion,
          preview: true,
        }),
        { statusCode: 404 },
      );
      await assert.rejects(
        changePropertyPolicy(sql, f.owner, f.listing, 'pricing', {
          values: { ...values, day_weekday: -1 },
          expectedVersion,
          preview: true,
        }),
        { statusCode: 422 },
      );
      await assert.rejects(
        changePropertyPolicy(sql, f.owner, f.listing, 'pricing', {
          values: { ...values, day_weekday: 1900 },
          expectedVersion,
          previewToken: preview.preview.token,
        }),
        { code: 'PREVIEW_REQUIRED' },
      );
      const race = await Promise.allSettled(
        [1, 2].map(() =>
          changePropertyPolicy(sql, f.owner, f.listing, 'pricing', {
            values,
            expectedVersion,
            previewToken: preview.preview.token,
          }),
        ),
      );
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (await propertyPolicyHistory(sql, f.owner, f.listing)).filter(
          (e) => e.action === 'property_pricing_changed',
        ).length,
        1,
      );
      await assert.rejects(
        withListingInventory(sql, f.listing, (tx, listing) =>
          revalidateBookingQuote(tx, listing, {
            quoteId: quote.id,
            hash: quote.hash,
            version: quote.version,
            customerId: booked.customer,
          }),
        ),
        { code: 'QUOTE_CHANGED' },
      );
      const terms = { depositAmount: 500, cancellationTier: 'flexible' };
      const version = await contentVersion();
      const tp = await changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
        values: terms,
        expectedVersion: version,
        preview: true,
      });
      await changePropertyPolicy(sql, f.owner, f.listing, 'terms', {
        values: terms,
        expectedVersion: version,
        previewToken: tp.preview.token,
      });
      assert.deepEqual(
        (await sql`SELECT policy_snapshot FROM booking_order WHERE id=${booked.order}`)[0]
          .policy_snapshot,
        accepted,
      );
      const newQuote = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [day], slot: 'day', guests: 2 },
        { customerId: booked.customer },
      );
      assert.equal(newQuote.policy.cancellationTier, 'flexible');
      assert.notEqual(newQuote.hash, quote.hash);
      // One currently due visit and one cancelled visit in the same confirmed order.
      await sql`UPDATE booking SET starts_at=now()-interval '1 hour',ends_at=now()+interval '2 hours',blocked_start_at=now()-interval '1 hour',blocked_end_at=now()+interval '2 hours' WHERE id=${visit.id}`;
      await sql`UPDATE inventory_reservation r SET blocked_start_at=b.blocked_start_at,blocked_end_at=b.blocked_end_at FROM booking b WHERE b.id=r.booking_id AND b.id=${visit.id}`;
      await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,state,amount_rent,amount_fee,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
    VALUES ('CP12-CANCELLED',${f.listing},${booked.customer},${booked.order},2,current_date+20,current_date+20,'day','cancelled',1000,80,now()+interval '20 days',now()+interval '20 days 8 hours',true,now()+interval '20 days',now()+interval '20 days 8 hours','INR','Asia/Kolkata',100000,8000,0)`;
      const owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin };
      for (const actor of [owner, admin]) {
        for (const tab of ['today', 'action_needed'])
          assert.equal((await listBookingRecords(sql, actor, { tab })).total, 1);
        const record = await readBookingRecord(sql, actor, booked.order);
        assert.equal(record.state, 'confirmed');
        assert.deepEqual(
          new Set(record.visits.map((v) => v.state)),
          new Set(['confirmed', 'cancelled']),
        );
        assert.equal(record.arrival.visitIds.length, 1);
        assert.equal(record.contact.phone, '9000000077');
        assert.equal(record.visits.find((v) => v.id === visit.id).operation.action, 'handover');
        if (actor.kind === 'admin') assert.equal(record.relationships.customerId, booked.customer);
        else assert.equal(record.relationships.customerId, undefined);
      }
      assert.equal(
        (await listBookingRecords(sql, { kind: 'owner', id: f.other }, { tab: 'today' })).total,
        0,
      );
      await assert.rejects(readBookingRecord(sql, { kind: 'owner', id: f.other }, booked.order), {
        code: 'BOOKING_NOT_FOUND',
      });
      assert.equal((await listBookingRecords(sql, owner, { property: randomUUID() })).total, 0);
      const input = {
        visitId: visit.id,
        phase: 'handover',
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        note: 'Guest keys handed over after the arrival inspection.',
        attested: true,
        expectedVersion: visit.lifecycle_version,
        requestKey: randomUUID(),
      };
      const first = await recordVisitTransition(sql, owner, input),
        second = await recordVisitTransition(sql, owner, input);
      assert.equal(first.id, second.id);
      assert.equal(
        (await sql`SELECT * FROM visit_evidence WHERE booking_id=${visit.id}`).length,
        1,
      );
      for (const [index, phase] of ['return', 'complete'].entries()) {
        const [currentVisit] =
          await sql`SELECT lifecycle_version FROM booking WHERE id=${visit.id}`;
        const transition = {
          ...input,
          phase,
          occurredAt: new Date(Date.now() - 100 + index).toISOString(),
          expectedVersion: currentVisit.lifecycle_version,
          requestKey: randomUUID(),
        };
        const once = await recordVisitTransition(sql, owner, transition);
        const again = await recordVisitTransition(sql, owner, transition);
        assert.equal(once.id, again.id);
      }
      assert.equal(
        (await sql`SELECT count(*)::int count FROM visit_evidence WHERE booking_id=${visit.id}`)[0]
          .count,
        3,
      );
      const closed = await readBookingRecord(sql, owner, booked.order);
      assert.equal(closed.arrival, null);
      assert.equal(closed.contact.phone, null);
      assert.equal(closed.contact.withheld, true);
      // Adapter-verified Test capture confirms automatically, with no owner decision.
      // Checkout runs on a client configured like src/services/db (prepare: false).
      app = postgres(fixture.url, { prepare: false, max: 4, onnotice: () => {} });
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        RAZORPAY_TEST_KEY_ID: 'rzp_test_CP12',
        RAZORPAY_TEST_KEY_SECRET: 'cp12-disposable-key-secret',
        RAZORPAY_TEST_WEBHOOK_SECRET: 'cp12-disposable-webhook-secret',
      };
      const [{ version: gatewayVersion }] =
        await sql`SELECT coalesce(max(version),0)::int version FROM payment_gateway_config`;
      await setPaymentGatewayConfiguration(
        app,
        {
          actorId: f.admin,
          expectedVersion: gatewayVersion,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      const [sessionRow] =
        await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${booked.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: booked.customer, sessionId: sessionRow.id };
      const payable = await createBookingQuote(
        app,
        { rentableId: f.listing, dates: [day], slot: 'day', guests: 2 },
        { customerId: booked.customer, variables: env },
      );
      const held = await createCheckoutHold(
        app,
        session,
        {
          rentableId: f.listing,
          quoteId: payable.id,
          hash: payable.hash,
          version: payable.version,
          idempotencyKey: randomUUID(),
          accepted: true,
        },
        env,
      );
      assert.equal(held.state, 'held');
      const capture = {
        id: 'pay_CP12',
        order_id: 'order_CP12',
        amount: held.expectedMinor,
        currency: 'INR',
        status: 'captured',
        captured: true,
      };
      const fetcher = async (url, init) => {
        const path = new URL(url).pathname.replace('/v1/', '');
        const body = init.body ? JSON.parse(init.body) : null;
        const reply =
          path === 'orders'
            ? {
                id: 'order_CP12',
                amount: body.amount,
                currency: 'INR',
                receipt: body.receipt,
                partial_payment: false,
              }
            : path === 'payments/pay_CP12'
              ? capture
              : null;
        return { ok: Boolean(reply), json: async () => reply };
      };
      const started = await startCheckoutPayment(app, session, held.orderId, { env, fetcher });
      assert.equal(started.providerOrderId, 'order_CP12');
      await assert.rejects(
        settleVerifiedPayment(app, held.paymentOrderId, { ...capture, amount: 1 }),
        {
          code: 'PROVIDER_PAYMENT_MISMATCH',
        },
      );
      const signature = createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
        .update('order_CP12|pay_CP12')
        .digest('hex');
      const verified = { orderId: held.orderId, paymentId: 'pay_CP12', signature };
      await assert.rejects(
        verifyCheckoutPayment(
          app,
          session,
          { ...verified, signature: 'f'.repeat(64) },
          { env, fetcher },
        ),
        { code: 'INVALID_SIGNATURE' },
      );
      assert.equal(
        (await verifyCheckoutPayment(app, session, verified, { env, fetcher })).state,
        'confirmed',
      );
      assert.equal(
        (await verifyCheckoutPayment(app, session, verified, { env, fetcher })).state,
        'confirmed',
      );
      assert.equal(
        (await sql`SELECT count(*)::int n FROM payment_transaction WHERE kind='capture'`)[0].n,
        1,
      );
      const [paidVisit] = await sql`SELECT * FROM booking WHERE order_id=${held.orderId}`;
      assert.equal(paidVisit.state, 'confirmed');
      assert.equal(paidVisit.policy_snapshot.cancellationTier, 'flexible');
      // Customer cancellation still follows the accepted snapshot and replays idempotently.
      const cancellation = { orderId: held.orderId, visitIds: [paidVisit.id] };
      const estimate = await previewCancellation(app, session, cancellation, env);
      const feeRefund = paidVisit.policy_snapshot.cancellation.feeOnFullRefund
        ? Number(paidVisit.amount_fee_minor)
        : 0;
      assert.equal(estimate.visits[0].rate, 1);
      assert.equal(estimate.refundMinor, Number(paidVisit.amount_rent_minor) + feeRefund);
      const cancel = {
        ...cancellation,
        hash: estimate.hash,
        idempotencyKey: randomUUID(),
        accepted: true,
      };
      const cancelled = await commitCancellation(app, session, cancel, env);
      assert.deepEqual(await commitCancellation(app, session, cancel, env), cancelled);
      assert.equal(
        (await sql`SELECT state FROM booking WHERE id=${paidVisit.id}`)[0].state,
        'cancelled',
      );
      assert.equal(
        (await sql`SELECT state FROM inventory_reservation WHERE booking_id=${paidVisit.id}`)[0]
          .state,
        'released',
      );
    } finally {
      await app?.end();
      await fixture.drop();
    }
  },
);
