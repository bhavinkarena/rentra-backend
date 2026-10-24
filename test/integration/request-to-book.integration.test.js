import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import {
  decideBookingRequest,
  listBookingRequests,
  setInstantBook,
} from '../../src/services/booking/booking-requests.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import {
  startCheckoutPayment,
  verifyCheckoutPayment,
} from '../../src/services/payments/checkout-service.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_REQBOOK12',
  RAZORPAY_KEY_SECRET: 'request-to-book-disposable-secret',
  RAZORPAY_WEBHOOK_SECRET: 'request-to-book-disposable-webhook',
};
const HOUR = 3_600_000;

test(
  'request to book: owner accepts before payment, declines release the dates; instant book is the default',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    const dir = await mkdtemp(join(tmpdir(), 'rentra-request-'));
    const providerFile = join(dir, 'razorpay.json');
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
      const day = addLocalDays(propertyToday(), 10);
      const other = addLocalDays(propertyToday(), 11);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: day, to: other });
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

      // Instant book is the default for every property.
      const [{ instant_book }] = await sql`SELECT instant_book FROM rentable WHERE id=${f.listing}`;
      assert.equal(instant_book, true);
      await assert.rejects(
        setInstantBook(sql, f.other, { rentableId: f.listing, enabled: false }),
        {
          code: 'BOOKING_REQUEST_NOT_FOUND',
        },
      );
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: false });

      // A request holds the dates for the owner's reply window; payment cannot start.
      const requested = await hold(day);
      assert.equal(requested.approval, 'pending');
      const wait = new Date(requested.holdExpiresAt) - Date.now();
      assert.ok(wait > 23 * HOUR && wait <= 24 * HOUR, `reply window ${wait}`);
      await assert.rejects(startCheckoutPayment(sql, session, requested.orderId, opts), {
        code: 'AWAITING_OWNER',
      });
      const [update] =
        await sql`SELECT kind,action FROM client_update WHERE client_id=${f.owner} AND order_id=${requested.orderId}`;
      assert.deepEqual({ ...update }, { kind: 'action', action: 'booking_requested' });
      const requests = await listBookingRequests(sql, f.owner);
      assert.deepEqual(
        requests.map((r) => r.orderId),
        [requested.orderId],
      );
      assert.equal(requests[0].guests, 2);
      assert.deepEqual(await listBookingRequests(sql, f.other), []);
      await assert.rejects(
        decideBookingRequest(sql, f.other, { orderId: requested.orderId, approve: true }),
        { code: 'BOOKING_REQUEST_NOT_FOUND' },
      );

      // Hours pass: the 10-minute quote is long gone when the owner accepts.
      await sql`UPDATE booking_quote SET created_at=now()-interval '3 hours',expires_at=now()-interval '2 hours'
        WHERE id=(SELECT quote_id FROM booking_order WHERE id=${requested.orderId})`;
      const approved = await decideBookingRequest(sql, f.owner, {
        orderId: requested.orderId,
        approve: true,
      });
      assert.equal(approved.approval, 'approved');
      const payWindow = new Date(approved.holdExpiresAt) - Date.now();
      assert.ok(payWindow > 11 * HOUR && payWindow <= 12 * HOUR, `pay window ${payWindow}`);
      const [reservation] =
        await sql`SELECT r.hold_expires_at FROM inventory_reservation r JOIN booking b ON b.id=r.booking_id WHERE b.order_id=${requested.orderId}`;
      assert.equal(+new Date(reservation.hold_expires_at), +new Date(approved.holdExpiresAt));
      const [sms] =
        await sql`SELECT template FROM notification_outbox WHERE order_id=${requested.orderId}`;
      assert.equal(sms.template, 'request_approved');
      assert.deepEqual(await listBookingRequests(sql, f.owner), []);
      await assert.rejects(
        decideBookingRequest(sql, f.owner, { orderId: requested.orderId, approve: false }),
        { code: 'REQUEST_CLOSED' },
      );

      // Then the guest pays and the booking confirms as usual.
      const started = await startCheckoutPayment(sql, session, requested.orderId, opts);
      providerCaptures(providerFile, started.providerOrderId, 'pay_REQ1');
      const paid = await verifyCheckoutPayment(
        sql,
        session,
        {
          orderId: requested.orderId,
          paymentId: 'pay_REQ1',
          signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET)
            .update(`${started.providerOrderId}|pay_REQ1`)
            .digest('hex'),
        },
        opts,
      );
      assert.equal(paid.state, 'confirmed');
      assert.equal(paid.paymentState, 'succeeded');

      // A declined request frees the dates; the guest was never charged.
      const second = await hold(other);
      const declined = await decideBookingRequest(sql, f.owner, {
        orderId: second.orderId,
        approve: false,
      });
      assert.equal(declined.state, 'expired');
      assert.equal(declined.approval, 'declined');
      const [visit] =
        await sql`SELECT b.state,b.cancelled_by_kind,r.state reservation FROM booking b JOIN inventory_reservation r ON r.booking_id=b.id WHERE b.order_id=${second.orderId}`;
      assert.deepEqual(
        { ...visit },
        { state: 'cancelled', cancelled_by_kind: 'client', reservation: 'expired' },
      );
      const [declinedSms] =
        await sql`SELECT template FROM notification_outbox WHERE order_id=${second.orderId}`;
      assert.equal(declinedSms.template, 'request_declined');
      const again = await hold(other);
      assert.equal(again.approval, 'pending');

      // Back to instant book: the next checkout is an ordinary 10-minute hold.
      await sql`UPDATE booking_order SET hold_expires_at=now()-interval '1 second' WHERE id=${again.orderId}`;
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: true });
      const instant = await hold(other);
      assert.equal(instant.approval, null);
      assert.ok(new Date(instant.holdExpiresAt) - Date.now() <= 10 * 60_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await fixture.drop();
    }
  },
);
