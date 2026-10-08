import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import {
  createOwnerBlock,
  withListingInventory,
  expireInventoryHolds,
} from '../../src/services/booking/inventory.js';
import { getTimeSlots, getHourlyAvailability } from '../../src/services/booking/time-slots.js';
import { previewCancellation } from '../../src/services/booking/cancellation.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import {
  startCheckoutPayment,
  verifyCheckoutPayment,
} from '../../src/services/payments/checkout-service.js';
import {
  addLocalDays,
  isWeekendLocalDate,
  propertyToday,
} from '../../src/services/domain/booking-dates.js';

/** Entertainment plan, Phase 4: a box-cricket venue with two courts, booked by the hour. */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_HOURLY1234',
  RAZORPAY_KEY_SECRET: 'hourly-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'hourly-disposable-webhook-secret',
};

function fakeProvider() {
  const orders = new Map();
  const payments = new Map();
  let counter = 0;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    let reply = null;
    if (path === 'orders' && body) {
      const id = `order_HOURLY${++counter}`;
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
  const capture = (order, id) =>
    payments.set(id, {
      id,
      order_id: order.id,
      amount: order.amount,
      currency: 'INR',
      status: 'captured',
      captured: true,
    });
  return { fetcher, orders, capture };
}

async function customer(sql, n) {
  const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
    VALUES (${`player${n}@fixture.invalid`},${`90000001${String(n).padStart(2, '0')}`},'customer','active',${`Player ${n}`}) RETURNING id`;
  const [session] =
    await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${user.id},now()+interval '1 day') RETURNING id`;
  return { id: user.id, session: { role: 'customer', userId: user.id, sessionId: session.id } };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

test(
  'Phase 4: hourly quote, time grid, court assignment, races, owner blocks, hold cap, payment and hour-based cancellation',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const v = await seedVenue(sql);
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: v.admin,
          expectedVersion: 0,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      const [a, b, c] = [await customer(sql, 1), await customer(sql, 2), await customer(sql, 3)];
      let date = addLocalDays(propertyToday(), 10);
      while (isWeekendLocalDate(date)) date = addLocalDays(date, 1);
      const base = {
        kind: 'hourly',
        rentableId: v.venue,
        activity: 'box-cricket',
        date,
        durationMinutes: 60,
        guests: 6,
      };
      const quote = (who, extra) =>
        createBookingQuote(sql, { ...base, ...extra }, { customerId: who.id, variables: env });
      const hold = (who, q) =>
        createCheckoutHold(
          sql,
          who.session,
          {
            rentableId: v.venue,
            quoteId: q.id,
            hash: q.hash,
            version: q.version,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        );
      const courtOf = async (orderId) =>
        (await sql`SELECT resource_id FROM booking WHERE order_id=${orderId}`)[0].resource_id;

      // Phase 13: stale prices must be accepted again before inventory can be held.
      const stale = await quote(c, { start: '09:00' });
      await sql`UPDATE rentable_rate SET hourly_rate_minor=hourly_rate_minor+100 WHERE rentable_id=${v.venue}`;
      await rejectsWith(hold(c, stale), 'QUOTE_CHANGED');
      await sql`UPDATE rentable_rate SET hourly_rate_minor=hourly_rate_minor-100 WHERE rentable_id=${v.venue}`;

      // Pricing: peak band, split across 18:00, fee on rent, hour bands in the policy, no court ids in the quote.
      const peak = await quote(a, { start: '18:00' });
      assert.equal(peak.totals.rentMinor, 120000);
      assert.equal(peak.totals.feeMinor, 9600);
      assert.equal(peak.visits[0].slot, 'hourly');
      assert.equal(peak.policy.cancellation.bandUnit, 'hours');
      assert.equal('freeCourts' in peak, false);
      const split = await quote(a, { start: '17:00', durationMinutes: 120 });
      assert.equal(split.totals.rentMinor, 200000);
      assert.deepEqual(
        split.visits[0].segments.map((s) => s.hourlyRateMinor),
        [80000, 120000],
      );
      await rejectsWith(quote(a, { start: '17:30' }), 'START_INVALID');
      await rejectsWith(quote(a, { start: '18:00', durationMinutes: 90 }), 'DURATION_INVALID');
      await rejectsWith(quote(a, { start: '05:00' }), 'OUTSIDE_OPENING_HOURS');
      await rejectsWith(quote(a, { start: '18:00', guests: 13 }), 'CAPACITY_EXCEEDED');
      await rejectsWith(quote(a, { start: '18:00', activity: 'bowling' }), 'ACTIVITY_UNAVAILABLE');
      await rejectsWith(
        createBookingQuote(
          sql,
          { rentableId: v.venue, dates: [date], slot: 'day', guests: 2 },
          { customerId: a.id, variables: env },
        ),
        'SLOT_UNAVAILABLE',
      );

      // The grid: 06:00–23:00 starts for one hour, both courts free, peak from 18:00.
      let grid = await getTimeSlots(sql, {
        rentableId: v.venue,
        date,
        activity: 'box-cricket',
        durationMinutes: 60,
        guests: 6,
      });
      assert.equal(grid.times.length, 18);
      assert.equal(grid.times[0].start, '06:00');
      assert.equal(grid.times.at(-1).start, '23:00');
      assert.equal(grid.times.find((t) => t.start === '18:00').freeResourceIds.length, 2);
      assert.equal(grid.times.find((t) => t.start === '10:00').peak, false);
      assert.equal(grid.times.find((t) => t.start === '18:00').peak, true);
      assert.deepEqual(grid.durations, [60, 120, 180]);
      assert.equal(JSON.stringify(grid).includes('booking'), false);

      // "Any court" fills Court 1, then Court 2; a third guest is told nothing is free.
      const heldA = await hold(a, await quote(a, { start: '18:00' }));
      const heldB = await hold(b, await quote(b, { start: '18:00' }));
      assert.equal(await courtOf(heldA.orderId), v.court1);
      assert.equal(await courtOf(heldB.orderId), v.court2);
      await assert.rejects(quote(c, { start: '18:00' }), (error) => {
        assert.equal(error.code, 'AVAILABILITY_CONFLICT');
        assert.equal(error.conflicts[0].code, 'NO_RESOURCE_AVAILABLE');
        return true;
      });
      grid = await getTimeSlots(sql, {
        rentableId: v.venue,
        date,
        activity: 'box-cricket',
        durationMinutes: 60,
        guests: 6,
      });
      assert.equal(
        grid.times.some((t) => t.start === '18:00'),
        false,
      );

      // A requested court is honoured.
      const heldC = await hold(c, await quote(c, { start: '19:00', resourceId: v.court2 }));
      assert.equal(await courtOf(heldC.orderId), v.court2);
      await rejectsWith(
        quote(a, { start: '19:00', resourceId: v.court2 }),
        'AVAILABILITY_CONFLICT',
      );

      // An owner block on one court leaves the other; two guests race for the last court.
      await createOwnerBlock(sql, v.owner, {
        rentableId: v.venue,
        resourceId: v.court2,
        blockedStartAt: new Date(`${date}T21:00:00+05:30`).toISOString(),
        blockedEndAt: new Date(`${date}T22:00:00+05:30`).toISOString(),
        reason: 'Net repair',
      });
      const [qa, qb] = [await quote(a, { start: '21:00' }), await quote(b, { start: '21:00' })];
      const race = await Promise.allSettled([hold(a, qa), hold(b, qb)]);
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'AVAILABILITY_CONFLICT');
      const raceWinner = race.find((r) => r.status === 'fulfilled').value;
      assert.equal(await courtOf(raceWinner.orderId), v.court1);

      // A venue-wide closure blocks every court.
      await createOwnerBlock(sql, v.owner, {
        rentableId: v.venue,
        blockedStartAt: new Date(`${date}T22:00:00+05:30`).toISOString(),
        blockedEndAt: new Date(`${date}T23:00:00+05:30`).toISOString(),
        reason: 'Private event',
      });
      await assert.rejects(
        quote(c, { start: '22:00' }),
        (error) => error.conflicts?.[0]?.code === 'OWNER_BLOCKED',
      );
      await rejectsWith(
        createOwnerBlock(sql, v.owner, {
          rentableId: v.venue,
          resourceId: v.court1,
          blockedStartAt: new Date(`${date}T18:30:00+05:30`).toISOString(),
          blockedEndAt: new Date(`${date}T19:30:00+05:30`).toISOString(),
          reason: 'Clash with a hold',
        }),
        'INVENTORY_CONFLICT',
      );

      // Live holds per customer are capped at three.
      const holder = race[0].status === 'fulfilled' ? a : b;
      await hold(holder, await quote(holder, { start: '10:00' })); // its third live hold (18:00 or 19:00 aside)
      await rejectsWith(hold(holder, await quote(holder, { start: '12:00' })), 'TOO_MANY_HOLDS');

      // An expired hold frees its court.
      // Holds last 10 minutes; fast-forward this one (the terms guard pins hold_expires_at, so bypass triggers here).
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`UPDATE booking_order SET hold_expires_at=now()-interval '1 minute' WHERE id=${heldB.orderId}`;
        await tx`UPDATE inventory_reservation r SET hold_expires_at=now()-interval '1 minute'
          FROM booking b WHERE r.booking_id=b.id AND b.order_id=${heldB.orderId}`;
      });
      grid = await getTimeSlots(sql, {
        rentableId: v.venue,
        date,
        activity: 'box-cricket',
        durationMinutes: 60,
        guests: 6,
      });
      assert.deepEqual(grid.times.find((t) => t.start === '18:00')?.freeResourceIds, [v.court2]);

      // The worker's expiry operation releases the order as well as the advisory grid.
      await withListingInventory(sql, v.venue, (tx) => expireInventoryHolds(tx, v.venue));
      assert.equal(
        (await sql`SELECT state FROM booking_order WHERE id=${heldB.orderId}`)[0].state,
        'expired',
      );

      // The date strip counts free starts per day.
      const strip = await getHourlyAvailability(sql, {
        rentableId: v.venue,
        from: date,
        days: 2,
        activity: 'box-cricket',
        durationMinutes: 60,
        guests: 6,
      });
      assert.equal(strip.days[date].open, true);
      assert.ok(strip.days[date].freeStarts < 18);
      assert.equal(strip.days[addLocalDays(date, 1)].freeStarts, 18);

      // Payment confirms the visit and commits the court; cancellation uses hour bands.
      const provider = fakeProvider();
      const opts = { env, fetcher: provider.fetcher };
      const started = await startCheckoutPayment(sql, a.session, heldA.orderId, opts);
      const order = provider.orders.get(started.providerOrderId);
      provider.capture(order, 'pay_HOURLY1');
      await verifyCheckoutPayment(
        sql,
        a.session,
        {
          orderId: heldA.orderId,
          paymentId: 'pay_HOURLY1',
          signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET)
            .update(`${order.id}|pay_HOURLY1`)
            .digest('hex'),
        },
        opts,
      );
      const [confirmed] =
        await sql`SELECT b.id,b.state,b.slot_snapshot,r.state AS reservation,r.resource_id
        FROM booking b JOIN inventory_reservation r ON r.booking_id=b.id WHERE b.order_id=${heldA.orderId}`;
      assert.deepEqual(
        [confirmed.state, confirmed.reservation, confirmed.resource_id],
        ['confirmed', 'committed', v.court1],
      );
      assert.equal(confirmed.slot_snapshot.resourceName, 'Court 1');
      const estimate = await previewCancellation(sql, a.session, {
        orderId: heldA.orderId,
        visitIds: [confirmed.id],
      });
      assert.equal(JSON.stringify(estimate).includes('"rate":1'), true, JSON.stringify(estimate));

      // Phase 13: the same physical court cannot be sold for a second sport.
      const [football] = await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit)
        VALUES ('football','Football','entertainment','hour') RETURNING id`;
      await sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id)
        VALUES (${v.court1},${v.venue},${football.id})`;
      await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
        SELECT rentable_id,${football.id},day_kind,start_minute,end_minute,hourly_rate_minor
        FROM rentable_rate WHERE rentable_id=${v.venue} AND category_id=(SELECT id FROM category WHERE slug='box-cricket')`;
      await rejectsWith(
        quote(c, { activity: 'football', start: '18:00' }),
        'AVAILABILITY_CONFLICT',
      );

      // Late captured hourly payment must create a refund obligation, never reacquire a court.
      const lateGuest = await customer(sql, 9);
      const lateHold = await hold(lateGuest, await quote(lateGuest, { start: '15:00' }));
      const lateStart = await startCheckoutPayment(sql, lateGuest.session, lateHold.orderId, opts);
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role=replica`;
        await tx`UPDATE booking_order SET hold_expires_at=now()-interval '1 minute' WHERE id=${lateHold.orderId}`;
        await tx`UPDATE inventory_reservation SET hold_expires_at=now()-interval '1 minute'
          WHERE booking_id IN (SELECT id FROM booking WHERE order_id=${lateHold.orderId})`;
      });
      await withListingInventory(sql, v.venue, (tx) => expireInventoryHolds(tx, v.venue));
      provider.capture(provider.orders.get(lateStart.providerOrderId), 'pay_HOURLYLATE');
      await verifyCheckoutPayment(
        sql,
        lateGuest.session,
        {
          orderId: lateHold.orderId,
          paymentId: 'pay_HOURLYLATE',
          signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET)
            .update(`${lateStart.providerOrderId}|pay_HOURLYLATE`)
            .digest('hex'),
        },
        opts,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int AS n FROM booking_lifecycle_event
        WHERE order_id=${lateHold.orderId} AND kind='refund_required'`
        )[0].n,
        1,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int AS n FROM inventory_reservation
        WHERE booking_id IN (SELECT id FROM booking WHERE order_id=${lateHold.orderId}) AND state IN ('held','committed')`
        )[0].n,
        0,
      );

      // Phase 10: refunds follow the moderate hour bands to the paisa (24h → 100%, 6h → 50%, then 0).
      const [{ amount_rent_minor: rentMinor }] =
        await sql`SELECT amount_rent_minor FROM booking WHERE id=${confirmed.id}`;
      for (const [hoursAhead, rate] of [
        [30, 1],
        [12, 0.5],
        [3, 0],
      ]) {
        await sql.begin(async (tx) => {
          // Accepted visits are trigger-protected; move the start in a fixture-only transaction.
          await tx`SET LOCAL session_replication_role=replica`;
          await tx`UPDATE booking SET starts_at=statement_timestamp()+make_interval(hours=>${hoursAhead}),
            ends_at=statement_timestamp()+make_interval(hours=>${hoursAhead + 1}),
            blocked_start_at=statement_timestamp()+make_interval(hours=>${hoursAhead}),
            blocked_end_at=statement_timestamp()+make_interval(hours=>${hoursAhead + 1}) WHERE id=${confirmed.id}`;
        });
        const preview = await previewCancellation(sql, a.session, {
          orderId: heldA.orderId,
          visitIds: [confirmed.id],
        });
        const visit = preview.visits[0];
        assert.equal(visit.rate, rate, `${hoursAhead}h ahead`);
        assert.equal(
          visit.refundMinor,
          Math.floor(Number(rentMinor) * rate),
          `${hoursAhead}h refund`,
        );
        assert.equal(visit.fee, 0, 'moderate keeps the fee');
      }
    } finally {
      await fixture.drop();
    }
  },
);

test(
  'Phase 4: 50 guests racing for two courts at the same hour get exactly two holds',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const v = await seedVenue(sql);
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: v.admin,
          expectedVersion: 0,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      let date = addLocalDays(propertyToday(), 12);
      while (isWeekendLocalDate(date)) date = addLocalDays(date, 1);
      const players = [];
      for (let n = 10; n < 60; n += 1) players.push(await customer(sql, n));
      const selection = {
        kind: 'hourly',
        rentableId: v.venue,
        activity: 'box-cricket',
        date,
        start: '20:00',
        durationMinutes: 60,
        guests: 6,
      };
      // Every quote is taken before any hold, so all 50 believe a court is free.
      const quotes = await Promise.all(
        players.map((p) =>
          createBookingQuote(sql, selection, { customerId: p.id, variables: env }),
        ),
      );
      const results = await Promise.allSettled(
        players.map((p, i) =>
          createCheckoutHold(
            sql,
            p.session,
            {
              rentableId: v.venue,
              quoteId: quotes[i].id,
              hash: quotes[i].hash,
              version: quotes[i].version,
              idempotencyKey: randomUUID(),
              accepted: true,
            },
            env,
          ),
        ),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      assert.equal(won.length, 2);
      assert.ok(
        results
          .filter((r) => r.status === 'rejected')
          .every((r) => ['AVAILABILITY_CONFLICT', 'QUOTE_CHANGED'].includes(r.reason.code)),
        results.find((r) => r.status === 'rejected')?.reason?.code,
      );
      const courts =
        await sql`SELECT resource_id FROM inventory_reservation WHERE rentable_id=${v.venue} AND state='held' ORDER BY resource_id`;
      assert.deepEqual(courts.map((r) => r.resource_id).sort(), [v.court1, v.court2].sort());
    } finally {
      await fixture.drop();
    }
  },
);
