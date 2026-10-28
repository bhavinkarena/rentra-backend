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
  RAZORPAY_KEY_ID: 'rzp_test_PAUSE1234',
  RAZORPAY_KEY_SECRET: 'pause-bookings-disposable-secret',
  RAZORPAY_WEBHOOK_SECRET: 'pause-bookings-disposable-webhook',
};

test(
  'Story 2.14 stop new bookings: preview splits stays and holds, approvals and payments stop, commitments stay',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    const dir = await mkdtemp(join(tmpdir(), 'rentra-pause-'));
    const providerFile = join(dir, 'razorpay.json');
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.SESSION_SECRET ??= 'pause-bookings-disposable-secret-only-123';
      const { runWithContext } = await import('@/runtime/context.js');
      const { encryptSession } = await import('@/services/auth/session-crypto.js');
      const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
      const actions = await import('@/services/auth/listings.js');
      const { createBookingQuote } = await import('@/services/booking/quotes.js');
      const { openBookingDates } = await import('@/services/booking/owner-settings.js');
      const { createCheckoutHold } = await import('@/services/booking/checkout.js');
      const { decideBookingRequest, listBookingRequests, setInstantBook } =
        await import('@/services/booking/booking-requests.js');
      const { setPaymentGatewayConfiguration } =
        await import('@/services/payments/gateway-settings.js');
      const { startCheckoutPayment, verifyCheckoutPayment } =
        await import('@/services/payments/checkout-service.js');
      const { addLocalDays, propertyToday } = await import('@/services/domain/booking-dates.js');

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
      await sql`UPDATE rentable SET status='live',published_at=now(),booking_config=${JSON.stringify({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })}::text::jsonb WHERE id=${f.listing}`;
      const [legacy] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${booked.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${legacy.id},'booking','committed',${legacy.starts_at},${legacy.ends_at})`;
      const days = [10, 11, 12].map((n) => addLocalDays(propertyToday(), n));
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: days[0], to: days[2] });
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
      const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
      const hold = async (date) => {
        const quote = await createBookingQuote(
          sql,
          { rentableId: f.listing, dates: [date], slot: 'day', guests: 2 },
          { customerId: booked.customer, variables: env },
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
      const token = await encryptSession({
        role: 'client',
        userId: f.owner,
        sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
      });
      const asOwner = (action, values) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(values)) form.append(key, String(value));
        return runWithContext({ req: { cookies: { rentra_session: token } } }, () =>
          action(null, form),
        );
      };

      // One instant hold awaiting payment, one paid-in-flight hold, one request awaiting the owner.
      const instant = await hold(days[0]);
      const racing = await hold(days[1]);
      const racingStart = await startCheckoutPayment(sql, session, racing.orderId, opts);
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: false });
      const requested = await hold(days[2]);
      assert.equal(requested.approval, 'pending');

      // (a) The preview separates confirmed stays from unpaid holds, and requests from payments due.
      await assert.rejects(actions.ownerPausePreview(sql, f.other, f.listing), { statusCode: 404 });
      const preview = await actions.ownerPausePreview(sql, f.owner, f.listing);
      assert.equal(preview.canPause, true);
      assert.equal(preview.confirmedStays.total, 1);
      assert.equal(preview.confirmedStays.items[0].orderId, booked.order);
      assert.deepEqual(
        preview.pendingRequests.map((h) => h.orderId),
        [requested.orderId],
      );
      assert.deepEqual(
        preview.awaitingPayment.map((h) => h.orderId).sort(),
        [instant.orderId, racing.orderId].sort(),
      );
      assert.deepEqual(
        preview.choices.map((c) => [c.key, c.available]),
        [
          ['stop_new', true],
          ['cancel_upcoming', true],
        ],
      );

      // (c) A stale preview is refused; the property is unchanged.
      const stale = await asOwner(actions.toggleListingPause, {
        id: f.listing,
        action: 'pause',
        expectedVersion: preview.version - 1,
      });
      assert.equal(stale.stale, true);
      assert.equal(
        (await sql`SELECT status FROM rentable WHERE id=${f.listing}`)[0].status,
        'live',
      );

      // Stop new bookings only.
      const paused = await asOwner(actions.toggleListingPause, {
        id: f.listing,
        action: 'pause',
        expectedVersion: preview.version,
      });
      assert.equal(paused.ok, true);
      assert.equal(paused.status, 'paused');
      // A retried "pause" is a no-op, never a resume.
      const replay = await asOwner(actions.toggleListingPause, {
        id: f.listing,
        action: 'pause',
        expectedVersion: preview.version,
      });
      assert.deepEqual([replay.ok, replay.status, replay.replayed], [true, 'paused', true]);
      const [audit] =
        await sql`SELECT after FROM audit_log WHERE action='listing_paused' AND entity_id=${f.listing}`;
      assert.equal(audit.after.mode, 'stop_new');
      assert.deepEqual(audit.after.retained, {
        confirmedStays: 1,
        pendingRequests: 1,
        awaitingPayment: 2,
      });

      // (b) Commitments stay: the confirmed stay and every unpaid hold keep their state and deadline.
      assert.equal(
        (await sql`SELECT state FROM booking WHERE order_id=${booked.order}`)[0].state,
        'confirmed',
      );
      const holdRows =
        await sql`SELECT id, state FROM booking_order WHERE id IN ${sql([instant.orderId, racing.orderId, requested.orderId])}`;
      assert.ok(holdRows.every((h) => h.state === 'held'));

      // (b) New admissions stop: no new quote, no approval, no new payment.
      await assert.rejects(hold(days[0]));
      await assert.rejects(
        decideBookingRequest(sql, f.owner, { orderId: requested.orderId, approve: true }),
        {
          code: 'LISTING_PAUSED',
        },
      );
      assert.deepEqual(
        (await listBookingRequests(sql, f.owner)).map((r) => r.canApprove),
        [false],
      );
      assert.deepEqual(
        (await listBookingRequests(sql, f.owner)).map((r) => r.approveBlocked),
        ['paused'],
      );
      // A payment dispatched before the pause can still be read; only new dispatch is refused.
      const inFlight = await startCheckoutPayment(sql, session, racing.orderId, opts);
      assert.equal(inFlight.providerOrderId, racingStart.providerOrderId);
      await assert.rejects(startCheckoutPayment(sql, session, instant.orderId, opts), {
        code: 'LISTING_UNAVAILABLE',
      });

      // (b) A capture that was already in flight resolves without confirming or overbooking: the
      // captured money becomes a refund obligation and the dates are released.
      providerCaptures(providerFile, racingStart.providerOrderId, 'pay_PAUSE1');
      const late = await verifyCheckoutPayment(
        sql,
        session,
        {
          orderId: racing.orderId,
          paymentId: 'pay_PAUSE1',
          signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET)
            .update(`${racingStart.providerOrderId}|pay_PAUSE1`)
            .digest('hex'),
        },
        opts,
      );
      assert.notEqual(late.state, 'confirmed');
      assert.equal(late.needsResolution, true);
      const [{ committed }] =
        await sql`SELECT count(*)::int AS committed FROM inventory_reservation r
        JOIN booking b ON b.id=r.booking_id WHERE b.order_id=${racing.orderId} AND r.state='committed'`;
      assert.equal(committed, 0);
      // Nothing uncaptured is ever refunded.
      const [{ refunds }] = await sql`SELECT count(*)::int AS refunds FROM refund_allocation ra
        JOIN booking b ON b.id=ra.booking_id WHERE b.order_id IN ${sql([instant.orderId, requested.orderId])}`;
      assert.equal(refunds, 0);

      // Declining still works while paused and releases the dates.
      const declined = await decideBookingRequest(sql, f.owner, {
        orderId: requested.orderId,
        approve: false,
      });
      assert.equal(declined.approval, 'declined');

      // Resume: the surviving hold can be paid again; a repeated resume is a no-op.
      const resumed = await asOwner(actions.toggleListingPause, {
        id: f.listing,
        action: 'resume',
      });
      assert.equal(resumed.status, 'live');
      assert.equal(
        (await asOwner(actions.toggleListingPause, { id: f.listing, action: 'resume' })).replayed,
        true,
      );
      const payable = await startCheckoutPayment(sql, session, instant.orderId, opts);
      assert.ok(payable.providerOrderId);
    } finally {
      await fixture.drop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
