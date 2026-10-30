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
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';

/**
 * Story 3.11: a whole apartment is quoted, held (exclusively, with turnover), paid, cancelled and left early
 * through the existing checkout, against the file-backed fake Razorpay. Every matrix row of the spec.
 */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_APT311KEY12',
  RAZORPAY_KEY_SECRET: 'apt311-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'apt311-disposable-webhook-secret',
};
const policy = (latePct) => ({
  version: 1,
  windows: [
    { hoursBefore: 720, pct: 100 },
    { hoursBefore: 0, pct: latePct },
  ],
  atOrAfterCheckInPct: 0,
  earlyDeparture: { offered: true, pct: 100 },
});

test(
  'Story 3.11: whole-apartment booking',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const dir = await mkdtemp(join(tmpdir(), 'apt311-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await fixture.drop();
    });
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    Object.assign(process.env, {
      RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
    });
    const { createBookingQuote, previewBookingQuote } =
      await import('@/services/booking/quotes.js');
    const { createCheckoutHold } = await import('@/services/booking/checkout.js');
    const { startCheckoutPayment, verifyCheckoutPayment } =
      await import('@/services/payments/checkout-service.js');
    const { setPaymentGatewayConfiguration } =
      await import('@/services/payments/gateway-settings.js');
    const { previewCancellation, commitCancellation } =
      await import('@/services/booking/cancellation.js');
    const { readBookingRecord } = await import('@/services/booking/records.js');
    const { expireInventoryHolds, withListingInventory } =
      await import('@/services/booking/inventory.js');
    const { decideBookingRequest } = await import('@/services/booking/booking-requests.js');
    const { apartmentCalendar, changeApartmentCalendar } =
      await import('@/services/booking/apartment-stays.js');
    const { searchDiscovery, clearDiscoveryRegistryCache, getDiscoveryRegistry } =
      await import('@/services/db/discovery.js');
    const { getListingByCode } = await import('@/services/db/queries.js');
    const { seedApartmentCategory } = await import('../../src/scripts/apartment-category.js');

    const h = await seedHotel(sql);
    await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
    await seedApartmentCategory(sql);
    const [category] = await sql`SELECT id FROM category WHERE slug='whole-apartment'`;
    await setPaymentGatewayConfiguration(
      sql,
      {
        actorId: h.admin,
        expectedVersion: 0,
        provider: 'razorpay',
        environment: 'test',
        enabled: true,
        collectionPurpose: 'advance',
      },
      env,
    );
    const providerFile = join(dir, 'provider.json');
    const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
    const sign = (orderId, paymentId) =>
      createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

    const [apt] =
      await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,status,capacity,house_rules,
        cancellation_tier,cancellation_policy,pet_policy,deposit_minor)
      VALUES (${h.owner},'river-apt','River two-bedroom apartment',${category.id},${h.city},${h.area},'apt31100','unit_night','live',3,'{}'::jsonb,
        'moderate',${JSON.stringify(policy(50))}::text::jsonb,
        ${JSON.stringify({ status: 'allowed', maxPets: 2, types: ['dog', 'cat'], maxSize: 'medium', fee: { unit: 'per_night', amount: 150 } })}::text::jsonb,0)
      RETURNING id`;
    await sql`INSERT INTO apartment_profile(rentable_id,bedrooms,bathrooms,beds,max_adults,max_children,max_occupants,min_nights,max_nights,arrival_rules,
        check_in_minute,check_out_minute,turnover_nights,cleaning_fee_minor,weekday_minor,weekend_minor,weekend_nights)
      VALUES (${apt.id},2,1,'[{"type":"double","count":1}]'::jsonb,2,1,3,1,90,'{"weekdays":{"sat":3},"ranges":[]}'::jsonb,
        840,660,1,100000,500000,700000,'{5,6}')`;

    const guest = async () => {
      const id = await seedCustomer(sql);
      const [row] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${id},now()+interval '1 day') RETURNING id`;
      return { role: 'customer', userId: id, sessionId: row.id };
    };
    const rejects = (promise, code) =>
      assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
      });
    const day = (n) => addLocalDays(propertyToday(), n);
    // The next date ≥ today+n that falls on `weekday` (0 = Sunday).
    const on = (n, weekday) => {
      let d = day(n);
      while (new Date(`${d}T00:00:00Z`).getUTCDay() !== weekday) d = addLocalDays(d, 1);
      return d;
    };
    const sel = (checkIn, checkOut, extra = {}) => ({
      kind: 'apartment',
      rentableId: apt.id,
      checkIn,
      checkOut,
      adults: 2,
      ...extra,
    });
    const quote = (session, selection) =>
      createBookingQuote(sql, selection, { customerId: session.userId });
    const hold = (session, q, extra = {}) =>
      createCheckoutHold(
        sql,
        session,
        {
          rentableId: apt.id,
          quoteId: q.id,
          hash: q.hash,
          version: q.version,
          idempotencyKey: randomUUID(),
          accepted: true,
          stay: { guestNames: ['Asha Patel'] },
          ...extra,
        },
        env,
      );
    let payments = 0;
    async function pay(session, held) {
      const started = await startCheckoutPayment(sql, session, held.orderId, opts);
      const id = `pay_APT${++payments}`;
      providerCaptures(providerFile, started.providerOrderId, id);
      return verifyCheckoutPayment(
        sql,
        session,
        { orderId: held.orderId, paymentId: id, signature: sign(started.providerOrderId, id) },
        opts,
      );
    }
    async function book(checkIn, checkOut, extra = {}) {
      const session = await guest();
      const q = await quote(session, sel(checkIn, checkOut, extra));
      const held = await hold(session, q, extra.pets ? { petsConfirmed: true } : {});
      const done = await pay(session, held);
      assert.equal(done.state, 'confirmed');
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
      return { session, q, held, visitId: visit.id };
    }
    const reservation = async (orderId) =>
      (
        await sql`SELECT r.state::text, r.blocked_start_at, r.blocked_end_at FROM inventory_reservation r
      JOIN booking b ON b.id=r.booking_id WHERE b.order_id=${orderId}`
      )[0];
    const refunded = async (orderId) =>
      Number(
        (
          await sql`SELECT coalesce(sum(ra.expected_minor),0)::bigint n FROM refund_allocation ra
      JOIN booking b ON b.id=ra.booking_id WHERE b.order_id=${orderId}`
        )[0].n,
      );
    const paid = async (orderId) =>
      Number(
        (
          await sql`SELECT coalesce(sum(a.actual_minor),0)::bigint n FROM payment_allocation a
      JOIN booking b ON b.id=a.booking_id WHERE b.order_id=${orderId}`
        )[0].n,
      );

    // Move a booked stay `shift` days into the past (accepted terms are otherwise immutable).
    async function shiftBack(visitId, shift) {
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE booking DISABLE TRIGGER USER`;
        const [b] = await tx`SELECT slot_snapshot FROM booking WHERE id=${visitId}`;
        const s = b.slot_snapshot;
        const back = (d) => addLocalDays(d, -shift);
        const snapshot = {
          ...s,
          date: back(s.date),
          checkIn: back(s.checkIn),
          checkOut: back(s.checkOut),
          apartment: {
            ...s.apartment,
            nightly: s.apartment.nightly.map((n) => ({ ...n, night: back(n.night) })),
          },
        };
        await tx`UPDATE booking SET local_day=${back(s.date)}, starts_at=starts_at-make_interval(days=>${shift}), ends_at=ends_at-make_interval(days=>${shift}),
      blocked_start_at=blocked_start_at-make_interval(days=>${shift}), blocked_end_at=blocked_end_at-make_interval(days=>${shift}),
      slot_snapshot=${JSON.stringify(snapshot)}::text::jsonb WHERE id=${visitId}`;
        await tx`ALTER TABLE booking ENABLE TRIGGER USER`;
        await tx`UPDATE inventory_reservation SET blocked_start_at=blocked_start_at-make_interval(days=>${shift}),
      blocked_end_at=blocked_end_at-make_interval(days=>${shift}) WHERE booking_id=${visitId}`;
      });
    }

    await t.test(
      '3 nights Fri-Mon: weekend, weekend, weekday + cleaning, one fee; paid in full and confirmed',
      async () => {
        const fri = on(20, 5);
        const { q, held, session } = await book(fri, addLocalDays(fri, 3));
        assert.deepEqual(
          q.visits[0].apartment.nightly.map((n) => n.rateMinor),
          [700000, 700000, 500000],
        );
        assert.equal(q.totals.rentMinor, 2000000, '₹20,000 before the fee');
        assert.equal(q.totals.cleaningMinor, 100000);
        assert.equal(q.totals.totalMinor, 2000000 + q.totals.feeMinor);
        assert.ok(q.totals.feeMinor > 0);
        assert.equal(
          held.expectedMinor,
          q.totals.totalMinor,
          'whole stay up front even when the gateway default is an advance',
        );
        const parts =
          await sql`SELECT a.component::text, a.actual_minor::int amount FROM payment_allocation a JOIN booking b ON b.id=a.booking_id
        WHERE b.order_id=${held.orderId} ORDER BY a.component::text`;
        assert.deepEqual(
          parts.map((p) => [p.component, p.amount]),
          [
            ['fee', q.totals.feeMinor],
            ['rent', 2000000],
          ],
        );
        assert.equal((await reservation(held.orderId)).state, 'committed');
        const record = await readBookingRecord(
          sql,
          { kind: 'customer', session },
          held.orderId,
          env,
        );
        assert.equal(record.stay.apartment.cleaningMinor, 100000);
        assert.equal(record.stay.apartment.nightly.length, 3);
        assert.equal(record.stay.details.guestNames[0], 'Asha Patel');
      },
    );

    await t.test('night, arrival, maximum and occupancy rules are 422-class refusals', async () => {
      const session = await guest();
      await sql`UPDATE apartment_profile SET min_nights=3, version=version+1 WHERE rentable_id=${apt.id}`;
      const tue = on(40, 2);
      await rejects(quote(session, sel(tue, addLocalDays(tue, 2))), 'MIN_NIGHTS');
      await sql`UPDATE apartment_profile SET min_nights=1, version=version+1 WHERE rentable_id=${apt.id}`;
      const sat = on(40, 6);
      await assert.rejects(quote(session, sel(sat, addLocalDays(sat, 2))), {
        code: 'MIN_NIGHTS',
        message: 'Minimum 3 nights for Saturday arrival',
      });
      await rejects(quote(session, sel(day(40), day(131))), 'MAX_NIGHTS');
      await rejects(quote(session, sel(day(40), day(42), { adults: 3 })), 'OCCUPANCY');
      await rejects(quote(session, sel(day(40), day(42), { childAges: [3, 9] })), 'OCCUPANCY');
    });

    await t.test(
      'turnover: booked 10-12 with 1 buffer night refuses 12-14; with 0 allows it',
      async () => {
        const a = on(60, 2);
        await book(a, addLocalDays(a, 2));
        const session = await guest();
        await rejects(
          quote(session, sel(addLocalDays(a, 2), addLocalDays(a, 4))),
          'DATES_UNAVAILABLE',
        );
        await sql`UPDATE apartment_profile SET turnover_nights=0, version=version+1 WHERE rentable_id=${apt.id}`;
        // The first booking keeps its accepted turnover (its reservation still holds the buffer night).
        await rejects(
          quote(session, sel(addLocalDays(a, 2), addLocalDays(a, 4))),
          'DATES_UNAVAILABLE',
        );
        const b = on(70, 2);
        await book(b, addLocalDays(b, 2));
        const next = await quote(session, sel(addLocalDays(b, 2), addLocalDays(b, 4)));
        assert.ok(next.id, 'turnover 0: the next guest arrives on checkout day');
        await sql`UPDATE apartment_profile SET turnover_nights=1, version=version+1 WHERE rentable_id=${apt.id}`;
      },
    );

    await t.test(
      'two guests holding the same dates at once: exactly one wins, the other gets DATES_UNAVAILABLE',
      async () => {
        const a = on(80, 3);
        const [s1, s2] = [await guest(), await guest()];
        const [q1, q2] = [
          await quote(s1, sel(a, addLocalDays(a, 2))),
          await quote(s2, sel(addLocalDays(a, 1), addLocalDays(a, 3))),
        ];
        const results = await Promise.allSettled([hold(s1, q1), hold(s2, q2)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const [lost] = results.filter((r) => r.status === 'rejected');
        assert.equal(lost.reason.code, 'DATES_UNAVAILABLE');
        // The exclusion constraint itself, from two raw transactions racing on overlapping ranges.
        const range = {
          start: `${addLocalDays(a, 10)}T00:00:00+05:30`,
          end: `${addLocalDays(a, 12)}T00:00:00+05:30`,
        };
        const insert = () =>
          sql.begin(
            (
              tx,
            ) => tx`INSERT INTO inventory_reservation(rentable_id,source,blocked_start_at,blocked_end_at,state,created_by,reason)
        VALUES (${apt.id},'owner_block',${range.start},${range.end},'committed',${h.owner},'race test')`,
          );
        const raw = await Promise.allSettled([insert(), insert()]);
        assert.equal(raw.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(raw.find((r) => r.status === 'rejected').reason.code, '23P01');
        await sql`UPDATE inventory_reservation SET state='released', released_at=now() WHERE reason='race test'`;
      },
    );

    await t.test(
      'owner blocks: quotes over them refused; a block over booked nights refused; unblock reopens',
      async () => {
        const a = on(100, 1);
        const view = await apartmentCalendar(sql, h.owner, apt.id, { from: a, days: 14 });
        const blocked = await changeApartmentCalendar(sql, h.owner, apt.id, {
          action: 'block',
          from: addLocalDays(a, 2),
          to: addLocalDays(a, 3),
          version: view.version,
          calendarFrom: a,
          calendarDays: 14,
        });
        assert.deepEqual(
          blocked.nights.slice(1, 5).map((n) => n.state),
          ['open', 'blocked', 'blocked', 'open'],
        );
        const session = await guest();
        await rejects(
          quote(session, sel(addLocalDays(a, 1), addLocalDays(a, 3))),
          'DATES_UNAVAILABLE',
        );
        await rejects(
          changeApartmentCalendar(sql, h.owner, apt.id, {
            action: 'block',
            from: a,
            to: a,
            version: view.version,
            calendarFrom: a,
            calendarDays: 14,
          }),
          'CALENDAR_CHANGED',
        );
        const booked = await book(addLocalDays(a, 6), addLocalDays(a, 8));
        assert.ok(booked);
        const now = await apartmentCalendar(sql, h.owner, apt.id, { from: a, days: 14 });
        assert.deepEqual(
          now.nights.slice(6, 9).map((n) => n.state),
          ['booked', 'booked', 'buffer'],
        );
        await rejects(
          changeApartmentCalendar(sql, h.owner, apt.id, {
            action: 'block',
            from: addLocalDays(a, 7),
            to: addLocalDays(a, 7),
            version: now.version,
            calendarFrom: a,
            calendarDays: 14,
          }),
          'DATES_BOOKED',
        );
        const opened = await changeApartmentCalendar(sql, h.owner, apt.id, {
          action: 'unblock',
          from: addLocalDays(a, 2),
          to: addLocalDays(a, 3),
          version: now.version,
          calendarFrom: a,
          calendarDays: 14,
        });
        assert.equal(opened.nights[2].state, 'open');
        assert.ok((await quote(session, sel(addLocalDays(a, 1), addLocalDays(a, 3)))).id);
        await rejects(
          apartmentCalendar(sql, (await seedHotel(sql)).owner, apt.id, {}),
          'NOT_FOUND',
        );
      },
    );

    await t.test('manual approval: decline and hold expiry release the dates', async () => {
      await sql`UPDATE rentable SET instant_book=false WHERE id=${apt.id}`;
      const a = on(120, 2);
      const session = await guest();
      const held = await hold(session, await quote(session, sel(a, addLocalDays(a, 2))));
      assert.equal(held.approval, 'pending');
      assert.equal((await reservation(held.orderId)).state, 'held');
      await decideBookingRequest(sql, h.owner, { orderId: held.orderId, approve: false });
      assert.equal((await reservation(held.orderId)).state, 'expired');
      await sql`UPDATE rentable SET instant_book=true WHERE id=${apt.id}`;
      const again = await hold(session, await quote(session, sel(a, addLocalDays(a, 2))));
      await withListingInventory(sql, apt.id, (tx) =>
        expireInventoryHolds(tx, apt.id, new Date(Date.now() + 16 * 60_000)),
      );
      assert.equal((await reservation(again.orderId)).state, 'expired');
    });

    await t.test(
      'free cancel refunds everything incl. cleaning and pets; the dates reopen',
      async () => {
        const a = on(40, 2);
        const { session, held, visitId, q } = await book(a, addLocalDays(a, 2), { pets: 1 });
        assert.equal(q.totals.petMinor, 30000, '₹150 per night × 2 nights');
        const preview = await previewCancellation(sql, session, {
          orderId: held.orderId,
          visitIds: [visitId],
        });
        assert.equal(preview.refundMinor, q.totals.totalMinor);
        await commitCancellation(sql, session, {
          orderId: held.orderId,
          visitIds: [visitId],
          hash: preview.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        });
        assert.equal(await refunded(held.orderId), await paid(held.orderId));
        assert.equal((await reservation(held.orderId)).state, 'released');
      },
    );

    await t.test(
      'late cancel at 50%: rent, cleaning and pet at 50%; refund + charge = paid',
      async () => {
        const a = on(10, 2);
        const { session, held, visitId, q } = await book(a, addLocalDays(a, 2), { pets: 1 });
        const preview = await previewCancellation(sql, session, {
          orderId: held.orderId,
          visitIds: [visitId],
        });
        const [v] = preview.visits;
        const total = q.totals.totalMinor;
        assert.equal(preview.refundMinor, Math.floor(total / 2));
        assert.equal(v.apartment.cleaning, 50000);
        assert.equal(v.apartment.pet, 15000);
        assert.equal(v.apartment.rent + v.apartment.cleaning + v.apartment.pet, v.rent);
        assert.equal(preview.refundMinor + v.chargeMinor, total);
        await commitCancellation(sql, session, {
          orderId: held.orderId,
          visitIds: [visitId],
          hash: preview.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        });
        assert.equal((await refunded(held.orderId)) + v.chargeMinor, await paid(held.orderId));
      },
    );

    await t.test(
      'early departure after night 1 of 3: unused nights refunded, cleaning kept, nights released',
      async () => {
        const a = on(150, 1);
        const { session, held, visitId, q } = await book(a, addLocalDays(a, 3));
        // Move the stay so night 1 has started and night 2 has not (property time 14:00 check-in).
        const istHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
        const checkIn = istHour >= 14 ? day(0) : day(-1);
        const shift = Math.round(
          (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000,
        );
        await shiftBack(visitId, shift);
        const input = { orderId: held.orderId, visitIds: [visitId], operation: 'early_departure' };
        const preview = await previewCancellation(sql, session, input);
        const [v] = preview.visits;
        assert.deepEqual(v.apartment.consumedNights, [checkIn]);
        assert.equal(v.apartment.unusedNights.length, 2);
        const unusedRent = q.visits[0].apartment.nightly
          .slice(1)
          .reduce((sum, n) => sum + n.rateMinor, 0);
        assert.equal(v.rent, unusedRent, 'unused nights at 100%; cleaning kept');
        assert.ok(v.fee > 0 && v.fee < q.totals.feeMinor);
        await commitCancellation(sql, session, {
          ...input,
          hash: preview.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        });
        const r = await reservation(held.orderId);
        assert.equal(r.state, 'committed');
        assert.equal(
          new Date(r.blocked_end_at).toISOString(),
          new Date(`${addLocalDays(checkIn, 2)}T00:00:00+05:30`).toISOString(),
          'ends at the first unused night + 1 turnover night',
        );
        const [b] =
          await sql`SELECT state::text, slot_snapshot->>'checkOut' AS out FROM booking WHERE id=${visitId}`;
        assert.equal(b.out, addLocalDays(checkIn, 3), 'accepted history is kept');
        assert.equal(b.state, 'completed', 'the stay left early is completed');
        await rejects(previewCancellation(sql, session, input), 'EARLY_DEPARTURE_UNAVAILABLE');
        await sql`UPDATE apartment_profile SET arrival_rules='{"weekdays":{},"ranges":[]}'::jsonb, version=version+1 WHERE rentable_id=${apt.id}`;
        const s2 = await guest();
        assert.ok(
          (await quote(s2, sel(addLocalDays(checkIn, 2), addLocalDays(checkIn, 3)))).id,
          'the released night sells again',
        );
        await sql`UPDATE apartment_profile SET arrival_rules='{"weekdays":{"sat":3},"ranges":[]}'::jsonb, version=version+1 WHERE rentable_id=${apt.id}`;
      },
    );

    await t.test('a price change after the quote is QUOTE_CHANGED', async () => {
      const a = on(200, 2);
      const session = await guest();
      const q = await quote(session, sel(a, addLocalDays(a, 2)));
      await sql`UPDATE apartment_profile SET weekday_minor=550000, version=version+1 WHERE rentable_id=${apt.id}`;
      await rejects(hold(session, q), 'QUOTE_CHANGED');
      await sql`UPDATE apartment_profile SET weekday_minor=500000, version=version+1 WHERE rentable_id=${apt.id}`;
      await rejects(
        hold(session, await quote(session, sel(a, addLocalDays(a, 2), { pets: 1 }))),
        'PETS_UNCONFIRMED',
      );
    });

    await t.test('unblocking one night of a block keeps the others blocked', async () => {
      const a = on(260, 1);
      const view = await apartmentCalendar(sql, h.owner, apt.id, { from: a, days: 14 });
      const base = { calendarFrom: a, calendarDays: 14 };
      const blocked = await changeApartmentCalendar(sql, h.owner, apt.id, {
        action: 'block',
        from: addLocalDays(a, 2),
        to: addLocalDays(a, 7),
        version: view.version,
        ...base,
      });
      const after = await changeApartmentCalendar(sql, h.owner, apt.id, {
        action: 'unblock',
        from: addLocalDays(a, 4),
        to: addLocalDays(a, 4),
        version: blocked.version,
        ...base,
      });
      assert.deepEqual(
        after.nights.slice(2, 8).map((n) => n.state),
        ['blocked', 'blocked', 'open', 'blocked', 'blocked', 'blocked'],
      );
    });

    await t.test(
      'cancellation refuses when captured money differs from the booking amounts',
      async () => {
        const a = on(270, 2);
        const { session, held, visitId } = await book(a, addLocalDays(a, 2));
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE booking DISABLE TRIGGER USER`;
          await tx`UPDATE booking SET amount_fee_minor=amount_fee_minor+1 WHERE id=${visitId}`;
          await tx`ALTER TABLE booking ENABLE TRIGGER USER`;
        });
        await rejects(
          previewCancellation(sql, session, { orderId: held.orderId, visitIds: [visitId] }),
          'PAYMENT_MISMATCH',
        );
      },
    );

    await t.test(
      'a held apartment pays inside its hold even after the quote time ran out',
      async () => {
        const a = on(280, 2);
        const session = await guest();
        const q = await quote(session, sel(a, addLocalDays(a, 2)));
        const held = await hold(session, q);
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE booking_quote DISABLE TRIGGER USER`;
          await tx`UPDATE booking_quote SET expires_at=created_at+interval '1 millisecond' WHERE id=${q.id}`;
          await tx`ALTER TABLE booking_quote ENABLE TRIGGER USER`;
        });
        assert.equal((await pay(session, held)).state, 'confirmed');
      },
    );

    await t.test(
      'a normal stay completes after check-out through the visit lifecycle',
      async () => {
        const { recordVisitTransition, completeReturnedVisits } =
          await import('@/services/booking/visit-lifecycle.js');
        const a = on(300, 2);
        const { visitId } = await book(a, addLocalDays(a, 2));
        const shift = Math.round(
          (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${day(-4)}T00:00:00Z`)) / 86_400_000,
        );
        await shiftBack(visitId, shift);
        const owner = { kind: 'owner', id: h.owner };
        const at = async () =>
          (
            await sql`SELECT starts_at, ends_at, lifecycle_version FROM booking WHERE id=${visitId}`
          )[0];
        let v = await at();
        await recordVisitTransition(sql, owner, {
          visitId,
          phase: 'handover',
          occurredAt: new Date(v.starts_at).toISOString(),
          attested: true,
          expectedVersion: v.lifecycle_version,
          requestKey: randomUUID(),
        });
        v = await at();
        await recordVisitTransition(sql, owner, {
          visitId,
          phase: 'return',
          occurredAt: new Date(v.ends_at).toISOString(),
          attested: true,
          expectedVersion: v.lifecycle_version,
          requestKey: randomUUID(),
        });
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE visit_evidence DISABLE TRIGGER USER`;
          await tx`UPDATE visit_evidence SET recorded_at=now()-interval '25 hours' WHERE booking_id=${visitId} AND kind='return'`;
          await tx`ALTER TABLE visit_evidence ENABLE TRIGGER USER`;
        });
        await completeReturnedVisits(sql);
        assert.equal(
          (await sql`SELECT state::text FROM booking WHERE id=${visitId}`)[0].state,
          'completed',
        );
      },
    );

    await t.test(
      'search with dates and party shows eligible apartments with the stay total',
      async () => {
        clearDiscoveryRegistryCache(sql);
        assert.ok(
          (await getDiscoveryRegistry(sql)).categories.some((c) => c.slug === 'whole-apartment'),
        );
        const detail = await getListingByCode('apt31100');
        assert.equal(
          detail.rentalUnit,
          'unit_night',
          'public detail must render whole-unit booking',
        );
        assert.equal(detail.price, 5000, 'undated price comes from the apartment profile');
        assert.ok(detail.apartment);
        const a = on(220, 2);
        const search = (checkin, checkout, extra = {}) =>
          searchDiscovery(
            parseDiscoveryQuery({
              vertical: 'hotel',
              city: 'surat',
              checkin,
              checkout,
              adults: '2',
              ...extra,
            }).filters,
            null,
            sql,
          );
        const found = (await search(a, addLocalDays(a, 2))).items.find((i) => i.id === apt.id);
        const preview = await previewBookingQuote(sql, sel(a, addLocalDays(a, 2)));
        assert.equal(found.priceMinor, preview.totals.totalMinor);
        assert.equal(found.rentalUnit, 'unit_night');
        await book(a, addLocalDays(a, 2));
        assert.ok(
          !(await search(a, addLocalDays(a, 2))).items.some((i) => i.id === apt.id),
          'booked dates hide it',
        );
        const b = on(240, 2);
        assert.ok(
          !(await search(b, addLocalDays(b, 2), { adults: '3' })).items.some(
            (i) => i.id === apt.id,
          ),
          'too many guests hide it',
        );
        const sat = on(240, 6);
        assert.ok(
          !(await search(sat, addLocalDays(sat, 2))).items.some((i) => i.id === apt.id),
          'Saturday minimum hides it',
        );
        assert.ok(
          (await search(b, addLocalDays(b, 2))).items.some((i) => i.id === h.hotel),
          'hotels unchanged',
        );
      },
    );
  },
);
