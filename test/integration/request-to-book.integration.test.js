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
import { searchDiscovery } from '../../src/services/db/discovery.js';
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import {
  createCheckoutHold,
  releaseUnstartedCheckout,
} from '../../src/services/booking/checkout.js';
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

      // Story 3.9: declared pets need the guest's confirmation at hold; the order keeps the declaration.
      const petDay = addLocalDays(propertyToday(), 14);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: petDay, to: petDay });
      await sql`UPDATE rentable SET pet_policy=${sql.json({ status: 'allowed', maxPets: 2, types: ['dog'], maxSize: 'any', fee: { unit: 'per_stay', amount: 500 } })}, pet_policy_version=2 WHERE id=${f.listing}`;
      const petQuote = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [petDay], slot: 'day', guests: 2, pets: 1 },
        { customerId: booked.customer, variables: env },
      );
      assert.equal(petQuote.visits[0].petMinor, 50000);
      const petHold = (petsConfirmed) =>
        createCheckoutHold(
          sql,
          session,
          {
            rentableId: f.listing,
            quoteId: petQuote.id,
            hash: petQuote.hash,
            version: petQuote.version,
            idempotencyKey: randomUUID(),
            accepted: true,
            ...(petsConfirmed ? { petsConfirmed } : {}),
          },
          env,
        );
      await assert.rejects(petHold(), { code: 'PETS_UNCONFIRMED' });
      const petHeld = await petHold(true);
      const [petOrder] =
        await sql`SELECT policy_snapshot, amount_rent_minor FROM booking_order WHERE id=${petHeld.orderId}`;
      assert.deepEqual(petOrder.policy_snapshot.pets, {
        count: 1,
        confirmed: true,
        confirmation: 'My pets are dogs',
        unit: 'per_stay',
        amount: 500,
        totalMinor: 50000,
      });
      assert.equal(petOrder.policy_snapshot.petPolicy.version, 2);
      const [petVisit] =
        await sql`SELECT slot_snapshot FROM booking WHERE order_id=${petHeld.orderId}`;
      assert.equal(petVisit.slot_snapshot.petMinor, 50000);
      await releaseUnstartedCheckout(sql, session, petHeld.orderId, env);
      // Farm search: pets hide listings whose effective policy refuses them (saved, SQL NULL or JSON null + legacy flag).
      const found = async (pets) =>
        (
          await searchDiscovery(parseDiscoveryQuery({ pets: String(pets) }).filters, null, sql)
        ).items.some((i) => i.id === f.listing);
      assert.equal(await found(0), true);
      assert.equal(await found(2), true);
      assert.equal(await found(3), false, 'over maxPets');
      await sql`UPDATE rentable SET pet_policy='null'::jsonb, house_rules=house_rules || '{"petsAllowed":true}'::jsonb WHERE id=${f.listing}`;
      assert.equal(await found(1), true, 'JSON null falls back to the legacy yes (1 pet)');
      assert.equal(await found(2), false);
      await sql`UPDATE rentable SET house_rules=house_rules || '{"petsAllowed":false}'::jsonb WHERE id=${f.listing}`;
      assert.equal(await found(1), false, 'legacy no');
      await sql`UPDATE rentable SET pet_policy=${sql.json({ status: 'not_allowed' })} WHERE id=${f.listing}`;
      await assert.rejects(
        createBookingQuote(
          sql,
          { rentableId: f.listing, dates: [petDay], slot: 'day', guests: 2, pets: 1 },
          { customerId: booked.customer, variables: env },
        ),
        { code: 'PETS_NOT_ALLOWED' },
      );
      await sql`UPDATE rentable SET pet_policy=NULL WHERE id=${f.listing}`;

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
      // Story 2.5: approval alone never confirms; only a verified payment does.
      const [approvedOrder] =
        await sql`SELECT state FROM booking_order WHERE id=${requested.orderId}`;
      assert.equal(approvedOrder.state, 'held');
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
      // Story 2.5: a repeated callback is idempotent, and Razorpay Test collects no bank money.
      const replay = await verifyCheckoutPayment(
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
      assert.equal(replay.state, 'confirmed');
      const [{ captures }] = await sql`SELECT count(*)::int AS captures FROM payment_transaction t
        JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order p ON p.id=a.payment_order_id WHERE p.booking_order_id=${requested.orderId} AND t.kind='capture'`;
      assert.equal(captures, 1);
      const [confirmed] =
        await sql`SELECT payload FROM booking_lifecycle_event WHERE order_id=${requested.orderId} AND kind='confirmed'`;
      assert.equal(confirmed.payload.actualCollectedMinor, 0);

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

      // Story 2.4: changing the setting never converts a pending request into a payable hold.
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: true });
      assert.deepEqual(
        (await listBookingRequests(sql, f.owner)).map((r) => r.orderId),
        [again.orderId],
      );
      await assert.rejects(startCheckoutPayment(sql, session, again.orderId, opts), {
        code: 'AWAITING_OWNER',
      });
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: false });

      // Back to instant book: the next checkout is an ordinary 10-minute hold.
      await sql`UPDATE booking_order SET hold_expires_at=now()-interval '1 second' WHERE id=${again.orderId}`;
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: true });
      const instant = await hold(other);
      assert.equal(instant.approval, null);
      assert.ok(new Date(instant.holdExpiresAt) - Date.now() <= 10 * 60_000);

      // Story 2.5: a provider timeout is unknown, never failed, and never sends a second order.
      const down = {
        env,
        fetcher: async () => {
          throw new Error('socket hang up');
        },
      };
      const unknown = await startCheckoutPayment(sql, session, instant.orderId, down);
      assert.notEqual(unknown.paymentState, 'failed');
      const [execution] =
        await sql`SELECT e.state FROM payment_execution e JOIN payment_order p ON p.id=e.payment_order_id
        WHERE p.booking_order_id=${instant.orderId}`;
      assert.equal(execution.state, 'unknown');
      await startCheckoutPayment(sql, session, instant.orderId, down);
      const [{ attempts }] = await sql`SELECT count(*)::int AS attempts FROM payment_attempt a
        JOIN payment_order p ON p.id=a.payment_order_id WHERE p.booking_order_id=${instant.orderId}`;
      assert.equal(attempts, 1, 'no second provider order');

      // Story 2.4: an expired hold (expired above) cannot be paid, so it can never take back sold stock.
      await assert.rejects(startCheckoutPayment(sql, session, again.orderId, opts));

      // Story 2.4: both race orders on one date leave exactly one hold.
      const raceDay = addLocalDays(propertyToday(), 12);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: raceDay, to: raceDay });
      for (let round = 0; round < 2; round++) {
        const results = await Promise.allSettled([hold(raceDay), hold(raceDay)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, `round ${round}`);
        const winner = results.find((r) => r.status === 'fulfilled').value;
        await sql`UPDATE booking_order SET hold_expires_at=now()-interval '1 second' WHERE id=${winner.orderId}`;
      }

      // Story 2.4: the owner reply window is capped by arrival.
      const soon = addLocalDays(propertyToday(), 1);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: soon, to: soon });
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: false });
      const near = await hold(soon);
      const [{ starts_at }] =
        await sql`SELECT min(starts_at) AS starts_at FROM booking WHERE order_id=${near.orderId}`;
      const expected = Math.min(Date.now() + 24 * HOUR, +new Date(starts_at));
      assert.ok(
        Math.abs(+new Date(near.holdExpiresAt) - expected) < 60_000,
        'deadline = earlier of 24 h and arrival',
      );
      assert.ok(+new Date(near.holdExpiresAt) <= +new Date(starts_at));

      // Story 2.5: disabling payments stops checkout, never browsing or quoting.
      const [config] =
        await sql`SELECT version FROM payment_gateway_config ORDER BY version DESC LIMIT 1`;
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: f.admin,
          expectedVersion: config.version,
          provider: 'razorpay',
          environment: 'test',
          enabled: false,
          collectionPurpose: 'full',
        },
        env,
      );
      const browsing = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [raceDay], slot: 'day', guests: 2 },
        { customerId: booked.customer, variables: env },
      );
      assert.ok(browsing.totals.totalMinor > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await fixture.drop();
    }
  },
);
