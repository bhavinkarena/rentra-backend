import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_OWNCANCEL1',
  RAZORPAY_KEY_SECRET: 'owner-cancel-disposable-secret',
  RAZORPAY_WEBHOOK_SECRET: 'owner-cancel-disposable-webhook',
};
const REASON = 'A water pipe burst and the property is closed for repairs.';

test(
  'Story 2.15 owner cancels upcoming stays: full paid refund, strictly future, unpaid released, per-booking outcomes',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    const dir = await mkdtemp(join(tmpdir(), 'rentra-owner-cancel-'));
    const providerFile = join(dir, 'razorpay.json');
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const { createBookingQuote } = await import('@/services/booking/quotes.js');
      const { openBookingDates } = await import('@/services/booking/owner-settings.js');
      const { createCheckoutHold } = await import('@/services/booking/checkout.js');
      const { setPaymentGatewayConfiguration } =
        await import('@/services/payments/gateway-settings.js');
      const { startCheckoutPayment, verifyCheckoutPayment } =
        await import('@/services/payments/checkout-service.js');
      const { addLocalDays, propertyToday } = await import('@/services/domain/booking-dates.js');
      const { previewOwnerCancelUpcoming, ownerCancelUpcoming } =
        await import('@/services/booking/owner-cancel-upcoming.js');
      const { setInstantBook } = await import('@/services/booking/booking-requests.js');
      const { quoteDigest } = await import('@/services/booking/quotes.js');

      const f = await seedReviewFixture(sql);
      const legacy = await seedConfirmedBooking(sql, f.listing);
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
      await sql`UPDATE rentable SET status='live',published_at=now(),booking_config=${JSON.stringify({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })}::text::jsonb WHERE id=${f.listing}`;
      const [old] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${legacy.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${old.id},'booking','committed',${old.starts_at},${old.ends_at})`;
      const days = [10, 11, 12, 13, 14, 15, 16].map((n) => addLocalDays(propertyToday(), n));
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: days[0], to: days[6] });
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
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${legacy.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: legacy.customer, sessionId: row.id };
      const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
      const hold = async (date) => {
        const quote = await createBookingQuote(
          sql,
          { rentableId: f.listing, dates: [date], slot: 'day', guests: 2 },
          { customerId: legacy.customer, variables: env },
        );
        return createCheckoutHold(
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
      };
      const pay = async (date, paymentId) => {
        const held = await hold(date);
        const started = await startCheckoutPayment(sql, session, held.orderId, opts);
        providerCaptures(providerFile, started.providerOrderId, paymentId);
        const done = await verifyCheckoutPayment(
          sql,
          session,
          {
            orderId: held.orderId,
            paymentId,
            signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET)
              .update(`${started.providerOrderId}|${paymentId}`)
              .digest('hex'),
          },
          opts,
        );
        assert.equal(done.state, 'confirmed');
        return held.orderId;
      };
      const paidA = await pay(days[0], 'pay_OWNA');
      const paidB = await pay(days[1], 'pay_OWNB');
      const startedC = await pay(days[2], 'pay_OWNC');
      const unpaidD = (await hold(days[3])).orderId;
      // E's payment was already sent to the provider: it may still be captured, so it is not released.
      const inFlightE = (await hold(days[4])).orderId;
      await startCheckoutPayment(sql, session, inFlightE, opts);
      // G is a request still waiting for the owner's answer.
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: false });
      const requestG = (await hold(days[5])).orderId;
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: true });
      const paid = async (orderId) =>
        Number(
          (
            await sql`SELECT sum(a.actual_minor)::bigint AS n FROM payment_allocation a JOIN booking b ON b.id=a.booking_id WHERE b.order_id=${orderId}`
          )[0].n,
        );

      // B already has an earlier refund in flight: it counts toward the full entitlement.
      const [rentB] =
        await sql`SELECT a.id, a.transaction_id, a.booking_id FROM payment_allocation a
        JOIN booking b ON b.id=a.booking_id WHERE b.order_id=${paidB} AND a.component='rent'`;
      const earlier = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO refund(id,transaction_id,reference,provider,environment,mode,currency,expected_minor,reason,idempotency_key,request_hash)
        VALUES (${earlier},${rentB.transaction_id},${'TEST_REFUND_' + earlier},'razorpay','test','real','INR',1000,'Earlier refund',${earlier},${'e'.repeat(64)})`;
        await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
        VALUES (${earlier},${rentB.id},${rentB.booking_id},'rent',1000)`;
      });

      // C has already started (check-in one minute ago): not upcoming, never cancelled here.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role=replica`;
        // now() is one instant per transaction, so the blocked interval always covers the visit.
        await tx`UPDATE booking SET starts_at=now()-interval '1 minute', ends_at=now()+interval '5 hours',
          blocked_start_at=now()-interval '1 minute', blocked_end_at=now()+interval '5 hours' WHERE order_id=${startedC}`;
      });

      // Preview: owner-scoped, strictly future, full paid amounts, unpaid listed separately.
      await assert.rejects(previewOwnerCancelUpcoming(sql, f.other, f.listing), {
        statusCode: 404,
      });
      const preview = await previewOwnerCancelUpcoming(sql, f.owner, f.listing);
      const byOrder = Object.fromEntries(preview.stays.map((s) => [s.orderId, s]));
      assert.equal(byOrder[startedC], undefined, 'a started stay is excluded');
      assert.ok(preview.startedExcluded >= 1);
      assert.equal(
        byOrder[paidA].refundMinor,
        await paid(paidA),
        'rent, fee and tax: everything paid',
      );
      assert.equal(
        byOrder[paidB].refundMinor,
        (await paid(paidB)) - 1000,
        'earlier refunds count toward it',
      );
      assert.equal(byOrder[legacy.order].blocked, 'PAYMENT_UNVERIFIED');
      assert.deepEqual(
        Object.fromEntries(
          preview.unpaidHolds.map((h) => [h.orderId, [h.awaitingOwner, h.paymentInFlight]]),
        ),
        { [unpaidD]: [false, false], [inFlightE]: [false, true], [requestG]: [true, false] },
      );

      const command = {
        hash: preview.hash,
        expectedVersion: preview.version,
        requestKey: randomUUID(),
        reason: REASON,
      };
      await assert.rejects(
        ownerCancelUpcoming(sql, f.owner, { ...command, rentableId: f.listing, reason: 'short' }),
        { statusCode: 422 },
      );
      await assert.rejects(
        ownerCancelUpcoming(sql, f.other, { ...command, rentableId: f.listing }),
        { statusCode: 404 },
      );
      await assert.rejects(
        ownerCancelUpcoming(sql, f.owner, {
          ...command,
          rentableId: f.listing,
          hash: 'b'.repeat(64),
        }),
        { code: 'CANCELLATION_CHANGED' },
      );
      assert.equal(
        (await sql`SELECT status FROM rentable WHERE id=${f.listing}`)[0].status,
        'live',
        'a stale preview changes nothing',
      );

      const done = await ownerCancelUpcoming(sql, f.owner, { ...command, rentableId: f.listing });
      const outcome = Object.fromEntries(done.results.map((r) => [r.orderId, r]));
      assert.equal(outcome[paidA].outcome, 'cancelled');
      assert.equal(outcome[paidA].refundMinor, await paid(paidA));
      assert.equal(outcome[paidB].refundMinor, (await paid(paidB)) - 1000);
      assert.deepEqual(
        [outcome[legacy.order].outcome, outcome[legacy.order].code],
        ['needs_rentra', 'PAYMENT_UNVERIFIED'],
      );
      assert.deepEqual([outcome[unpaidD].outcome, outcome[unpaidD].refundMinor], ['released', 0]);
      assert.equal(outcome[requestG].outcome, 'released');
      assert.deepEqual(
        [outcome[inFlightE].outcome, outcome[inFlightE].code],
        ['needs_rentra', 'PAYMENT_IN_FLIGHT'],
      );
      assert.equal(
        (await sql`SELECT state::text FROM booking_order WHERE id=${inFlightE}`)[0].state,
        'held',
        'a dispatched payment is never released as unpaid',
      );
      assert.equal(outcome[startedC], undefined);

      // Always pauses; the started stay and the unverified one are untouched.
      assert.equal(
        (await sql`SELECT status FROM rentable WHERE id=${f.listing}`)[0].status,
        'paused',
      );
      const states = Object.fromEntries(
        (
          await sql`SELECT order_id, state::text, cancelled_by_kind::text, cancellation_reason FROM booking WHERE rentable_id=${f.listing}`
        ).map((b) => [b.order_id, b]),
      );
      assert.equal(states[startedC].state, 'confirmed');
      assert.equal(states[legacy.order].state, 'confirmed');
      assert.deepEqual(
        [states[paidA].state, states[paidA].cancelled_by_kind, states[paidA].cancellation_reason],
        ['cancelled', 'client', REASON],
      );
      assert.equal(states[unpaidD].state, 'cancelled');

      // Refund obligations: never more than paid, none for the unpaid hold, no admin approval step.
      const refunded = async (orderId) =>
        Number(
          (
            await sql`SELECT coalesce(sum(ra.expected_minor),0)::bigint AS n FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
          JOIN booking b ON b.id=ra.booking_id WHERE b.order_id=${orderId} AND r.state<>'failed'`
          )[0].n,
        );
      assert.equal(await refunded(paidA), await paid(paidA));
      assert.equal(await refunded(paidB), await paid(paidB));
      assert.equal(await refunded(unpaidD), 0);
      const [{ reason }] =
        await sql`SELECT r.reason FROM refund r JOIN refund_allocation ra ON ra.refund_id=r.id
        JOIN booking b ON b.id=ra.booking_id WHERE b.order_id=${paidA} LIMIT 1`;
      assert.equal(reason, 'Owner cancelled upcoming stay');

      // Guest notice (SMS) and the booking record's host reason.
      const sms = async (orderId) =>
        (await sql`SELECT template FROM notification_outbox WHERE order_id=${orderId}`).map(
          (n) => n.template,
        );
      assert.ok((await sms(paidA)).includes('cancellation'));
      // An instant hold is told it was cancelled; only a pending request reads "Owner declined".
      assert.deepEqual(await sms(unpaidD), ['cancellation']);
      assert.deepEqual(await sms(requestG), ['request_declined']);
      const { readBookingRecord } = await import('@/services/booking/records.js');
      const record = await readBookingRecord(sql, { kind: 'customer', session }, paidA, env);
      assert.equal(record.visits[0].hostCancellationReason, REASON);

      // Replays return the recorded outcome; a changed payload under the same key conflicts.
      const replay = await ownerCancelUpcoming(sql, f.owner, { ...command, rentableId: f.listing });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.results, done.results);
      await assert.rejects(
        ownerCancelUpcoming(sql, f.owner, {
          ...command,
          rentableId: f.listing,
          reason: `${REASON} Sorry.`,
        }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(await refunded(paidA), await paid(paidA), 'no second refund');

      // A crash after the claim: the planned booking has no recorded outcome. The next request, even
      // with a new key after a reload, finishes it first; the old key then replays it. Once only.
      await sql`UPDATE rentable SET status='live', prior_status=NULL WHERE id=${f.listing}`;
      const paidF = await pay(days[6], 'pay_OWNF');
      await sql`UPDATE rentable SET status='paused', prior_status='live', paused_until=now()+interval '7 days' WHERE id=${f.listing}`;
      const [visitF] = await sql`SELECT id, reference FROM booking WHERE order_id=${paidF}`;
      const crashed = {
        hash: 'c'.repeat(64),
        expectedVersion: 0,
        requestKey: randomUUID(),
        reason: REASON,
      };
      const planned = [
        {
          orderId: paidF,
          reference: visitF.reference,
          kind: 'stay',
          visitIds: [visitF.id],
          blocked: null,
          ownerPaidOut: false,
        },
      ];
      const [claimed] =
        await sql`INSERT INTO owner_cancel_upcoming(owner_id,rentable_id,request_key,request_hash,reason,planned)
        VALUES (${f.owner},${f.listing},${crashed.requestKey},
          ${quoteDigest({ ownerId: f.owner, rentableId: f.listing, hash: crashed.hash, reason: REASON })},${REASON},
          ${JSON.stringify(planned)}::text::jsonb) RETURNING id`;
      const resumed = await ownerCancelUpcoming(sql, f.owner, {
        ...crashed,
        hash: 'd'.repeat(64),
        requestKey: randomUUID(),
        rentableId: f.listing,
      });
      assert.equal(resumed.replayed, true);
      assert.deepEqual(
        resumed.results.map((r) => [r.orderId, r.outcome, r.refundMinor]),
        [[paidF, 'cancelled', await paid(paidF)]],
      );
      await ownerCancelUpcoming(sql, f.owner, { ...crashed, rentableId: f.listing });
      assert.equal(await refunded(paidF), await paid(paidF), 'resumed once, never twice');
      const [{ audits }] = await sql`SELECT count(*)::int AS audits FROM audit_log
        WHERE action='owner_cancel_upcoming' AND "after"->>'commandId'=${claimed.id}`;
      assert.equal(audits, 1);

      // Already paused with an end date: cancelling keeps it paused until the owner resumes.
      const again = await previewOwnerCancelUpcoming(sql, f.owner, f.listing);
      const second = await ownerCancelUpcoming(sql, f.owner, {
        hash: again.hash,
        expectedVersion: again.version,
        requestKey: randomUUID(),
        reason: REASON,
        rentableId: f.listing,
      });
      assert.ok(second.results.every((r) => r.outcome === 'needs_rentra'));
      assert.deepEqual(
        (await sql`SELECT status::text, paused_until FROM rentable WHERE id=${f.listing}`).map(
          (r) => [r.status, r.paused_until],
        ),
        [['paused', null]],
      );
    } finally {
      await fixture.drop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
