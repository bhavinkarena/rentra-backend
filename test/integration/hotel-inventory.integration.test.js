import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { insertStayBooking, seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import {
  withListingInventory,
  expireInventoryHolds,
} from '../../src/services/booking/inventory.js';
import {
  confirmHotelRooms,
  finishHotelRooms,
  getHotelAvailability,
  holdHotelRooms,
  previewHotelCancellation,
  quoteHotelStay,
  releaseHotelRooms,
  resolveCommission,
} from '../../src/services/booking/hotel-stays.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { verticalCommand } from '../../src/services/catalogues/verticals.js';

/**
 * Hotel plan, Phase 2. The schema is built through 0063 per file, then 0064 runs
 * through the real drizzle migrator in ONE transaction, as `npm run db:migrate`
 * does, so a use of the new 'stay' enum value inside the migration would fail (55P04).
 */
const HEAD = '0063_owner_bookings_finish';
const journal = JSON.parse(
  await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
);
const headWhen = journal.entries.find((entry) => entry.tag === HEAD).when;
const skip = !process.env.PORTAL_TEST_DATABASE_URL;

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

async function nightsOf(sql, roomTypeId) {
  return (
    await sql`SELECT to_char(night,'YYYY-MM-DD') AS night, allotment, sold, held FROM room_night
    WHERE room_type_id=${roomTypeId} ORDER BY night`
  ).map((row) => ({ ...row }));
}

/** First Thursday at least 10 days out: Thu + Fri nights = one weekday and one weekend night. */
function stayDates() {
  let checkIn = addLocalDays(propertyToday(), 10);
  while (new Date(`${checkIn}T00:00:00Z`).getUTCDay() !== 4) checkIn = addLocalDays(checkIn, 1);
  return { checkIn, checkOut: addLocalDays(checkIn, 2) };
}

async function hold(sql, fixture, customerId, rooms, dates = stayDates()) {
  const quote = await quoteHotelStay(sql, { rentableId: fixture.hotel, ...dates, rooms });
  return withListingInventory(sql, fixture.hotel, async (tx, listing) => {
    const ids = await insertStayBooking(tx, { customerId, rentableId: fixture.hotel, quote });
    await holdHotelRooms(tx, listing, { bookingId: ids.bookingId, quote });
    return { ...ids, quote };
  });
}

test('hotel inventory: schema, pricing, holds, overbooking and expiry', { skip }, async (t) => {
  const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
    through: HEAD,
  });
  t.after(() => db.drop());
  await migrateWithDrizzle(db.url, headWhen);
  const { sql } = db;
  const fixture = await seedHotel(sql);
  const guest = await seedCustomer(sql);
  const dates = stayDates();
  const deluxe = (extra = {}) => ({
    roomTypeId: fixture.deluxe,
    ratePlanId: fixture.deluxeBreakfast,
    adults: 2,
    ...extra,
  });

  await t.test('migration: hidden vertical, GST slabs, guards', async () => {
    assert.deepEqual(
      [...(await sql`SELECT code, slug, status FROM vertical WHERE code='hotel'`)].map((r) => ({
        ...r,
      })),
      [{ code: 'hotel', slug: 'hotels', status: 'hidden' }],
    );
    assert.deepEqual(
      (await sql`SELECT max_rate_minor::int, tax_bps FROM tax_slab ORDER BY min_rate_minor`).map(
        (r) => [r.max_rate_minor, r.tax_bps],
      ),
      [
        [750000, 500],
        [null, 1800],
      ],
    );
    const [farm] = await sql`INSERT INTO category(slug,name) VALUES ('farm-x','Farm') RETURNING id`;
    const [listing] =
      await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code)
      VALUES (${fixture.owner},'farm-x','Farm X',${farm.id},${fixture.city},${fixture.area},'farmx001') RETURNING id`;
    await rejectsWith(
      sql`INSERT INTO room_type(rentable_id,name,max_adults,max_occupancy,room_count) VALUES (${listing.id},'Room',2,2,1)`,
      '23514',
    );
    await rejectsWith(
      sql`INSERT INTO rate_plan(room_type_id,rentable_id,name,derived_from) VALUES (${fixture.deluxe},${fixture.hotel},'Chain',${fixture.deluxeBreakfast})`,
      '23514',
    );
    await rejectsWith(
      sql`INSERT INTO rate_override(rate_plan_id,night,rate_minor) VALUES (${fixture.deluxeBreakfast},${dates.checkIn},300000)`,
      '23514',
    );
    await rejectsWith(
      sql`INSERT INTO room_night(room_type_id,night,allotment) VALUES (${fixture.deluxe},${dates.checkIn},4)`,
      '23514',
    );
    await rejectsWith(
      sql`INSERT INTO hotel_profile(rentable_id,gst_registered) VALUES (${listing.id},true)`,
      '23514',
    );
  });

  await t.test('admins can open Hotels to owners but not to guests yet', async () => {
    const [vertical] = await sql`SELECT version FROM vertical WHERE code='hotel'`;
    const input = (status) => ({
      version: vertical.version,
      name: 'Hotels',
      sortOrder: 30,
      status,
      reason: 'Hotel launch switch check',
      preview: true,
    });
    await rejectsWith(
      verticalCommand(sql, { kind: 'admin', id: fixture.admin }, 'hotel', input('public')),
      'NOT_READY',
    );
    const preview = await verticalCommand(
      sql,
      { kind: 'admin', id: fixture.admin },
      'hotel',
      input('partners'),
    );
    assert.equal(preview.preview, true);
  });

  await t.test('availability and quote price every night with the right slab', async () => {
    const availability = await getHotelAvailability(sql, { rentableId: fixture.hotel, ...dates });
    const room = availability.roomTypes.find((row) => row.id === fixture.deluxe);
    assert.equal(room.available, 3);
    assert.deepEqual(
      room.plans.map((p) => [p.name, p.totalMinor]),
      [
        ['Room only', 260000 + 300000 + 13000 + 15000],
        ['Breakfast included', 310000 + 350000 + 15500 + 17500],
        ['Non-refundable', 234000 + 270000 + 11700 + 13500],
      ],
    );
    assert.equal(
      room.plans[0].terms.freeUntil,
      new Date(new Date(`${dates.checkIn}T06:30:00Z`).getTime() - 48 * 3_600_000).toISOString(),
    );
    const quote = await quoteHotelStay(sql, {
      rentableId: fixture.hotel,
      ...dates,
      rooms: [deluxe({ adults: 3, childAges: [4] })],
    });
    assert.deepEqual(
      quote.lines[0].nights.map((n) => [n.rateMinor, n.taxBps]),
      [
        [405000, 500],
        [445000, 500],
      ],
      '3 adults: +₹700 extra adult, +₹250 breakfast each; the 4-year-old is free',
    );
    assert.equal(quote.totals.totalMinor, quote.lines[0].roomMinor + quote.lines[0].taxMinor);
    await rejectsWith(
      quoteHotelStay(sql, {
        rentableId: fixture.hotel,
        ...dates,
        rooms: [deluxe(), deluxe(), deluxe(), deluxe()],
      }),
      'SOLD_OUT',
    );
    await rejectsWith(
      quoteHotelStay(sql, { rentableId: fixture.hotel, ...dates, rooms: [deluxe({ adults: 5 })] }),
      'OCCUPANCY',
    );
    await rejectsWith(
      quoteHotelStay(sql, {
        rentableId: fixture.hotel,
        ...dates,
        rooms: [{ roomTypeId: fixture.standard, ratePlanId: fixture.deluxeBase, adults: 2 }],
      }),
      'ROOM_UNAVAILABLE',
    );
  });

  await t.test('hold → confirm → release moves held and sold counts', async () => {
    const { bookingId } = await hold(sql, fixture, guest, [deluxe(), deluxe()]);
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => [n.sold, n.held]),
      [
        [0, 2],
        [0, 2],
      ],
    );
    assert.equal(
      (await getHotelAvailability(sql, { rentableId: fixture.hotel, ...dates })).roomTypes[0]
        .available,
      1,
    );
    await confirmHotelRooms(sql, bookingId);
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => [n.sold, n.held]),
      [
        [2, 0],
        [2, 0],
      ],
    );
    const preview = await previewHotelCancellation(sql, bookingId, new Date());
    assert.equal(preview.chargeMinor, 0, 'free cancellation 10 days ahead');
    assert.equal(await releaseHotelRooms(sql, bookingId), 2);
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => [n.sold, n.held]),
      [
        [0, 0],
        [0, 0],
      ],
    );
    await rejectsWith(
      sql`UPDATE booking_room SET state='booked' WHERE booking_id=${bookingId}`,
      '23514',
    );
    await rejectsWith(confirmHotelRooms(sql, bookingId), 'HOLD_MISSING');
  });

  await t.test('stayed and no-show keep the rooms sold', async () => {
    const { bookingId } = await hold(sql, fixture, guest, [deluxe()]);
    await confirmHotelRooms(sql, bookingId);
    assert.equal(await finishHotelRooms(sql, bookingId, 'no_show'), 1);
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => n.sold),
      [1, 1],
    );
    await sql`UPDATE booking_room SET state='released' WHERE booking_id=${bookingId}`;
  });

  await t.test('stop-sell, room count changes and stale quotes are refused', async () => {
    await sql`INSERT INTO room_night(room_type_id,night,allotment,stop_sell) VALUES (${fixture.standard},${dates.checkIn},2,true)`;
    const quote = await quoteHotelStay(sql, {
      rentableId: fixture.hotel,
      ...dates,
      rooms: [deluxe()],
    });
    await sql`UPDATE room_night SET stop_sell=true WHERE room_type_id=${fixture.deluxe} AND night=${dates.checkIn}`;
    await rejectsWith(
      withListingInventory(sql, fixture.hotel, async (tx, listing) => {
        const ids = await insertStayBooking(tx, {
          customerId: guest,
          rentableId: fixture.hotel,
          quote,
        });
        await holdHotelRooms(tx, listing, { bookingId: ids.bookingId, quote });
      }),
      'CLOSED',
    );
    await sql`UPDATE room_night SET stop_sell=false WHERE room_type_id=${fixture.deluxe}`;
    await sql`INSERT INTO rate_override(rate_plan_id,night,rate_minor) VALUES (${fixture.deluxeBase},${dates.checkIn},280000)`;
    await rejectsWith(
      withListingInventory(sql, fixture.hotel, async (tx, listing) => {
        const ids = await insertStayBooking(tx, {
          customerId: guest,
          rentableId: fixture.hotel,
          quote,
        });
        await holdHotelRooms(tx, listing, { bookingId: ids.bookingId, quote });
      }),
      'QUOTE_CHANGED',
    );
    await sql`DELETE FROM rate_override`;
    const { bookingId } = await hold(sql, fixture, guest, [deluxe(), deluxe()]);
    await rejectsWith(sql`UPDATE room_type SET room_count=1 WHERE id=${fixture.deluxe}`, '23514');
    await sql`UPDATE room_type SET room_count=5 WHERE id=${fixture.deluxe}`;
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => n.allotment),
      [5, 5],
    );
    await sql`UPDATE room_type SET room_count=3 WHERE id=${fixture.deluxe}`;
    await releaseHotelRooms(sql, bookingId);
  });

  await t.test('expired holds go back on sale', async () => {
    const { orderId } = await hold(sql, fixture, guest, [deluxe(), deluxe(), deluxe()]);
    await rejectsWith(
      quoteHotelStay(sql, { rentableId: fixture.hotel, ...dates, rooms: [deluxe()] }),
      'SOLD_OUT',
    );
    await sql`UPDATE booking_order SET hold_expires_at = now() - interval '1 minute' WHERE id=${orderId}`;
    const free = await getHotelAvailability(sql, { rentableId: fixture.hotel, ...dates });
    assert.equal(free.roomTypes[0].available, 3, 'expired but unswept holds already read as free');
    await withListingInventory(sql, fixture.hotel, (tx) => expireInventoryHolds(tx, fixture.hotel));
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => n.held),
      [0, 0],
    );
    assert.deepEqual(
      (
        await sql`SELECT DISTINCT b.state FROM booking_room b JOIN booking k ON k.id=b.booking_id WHERE k.order_id=${orderId}`
      ).map((r) => r.state),
      ['released'],
    );
  });

  await t.test('concurrency: 12 checkouts race for 3 rooms; exactly 3 win', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => hold(sql, fixture, guest, [deluxe()])),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 3);
    assert.ok(
      lost.every((r) => r.reason.code === 'SOLD_OUT'),
      lost.map((r) => r.reason.code).join(),
    );
    assert.deepEqual(
      (await nightsOf(sql, fixture.deluxe)).map((n) => [n.held, n.allotment]),
      [
        [3, 3],
        [3, 3],
      ],
    );
    for (const r of won) await releaseHotelRooms(sql, r.value.bookingId);
  });

  await t.test('property: writers that skip the mutex still cannot oversell', async () => {
    const quote = await quoteHotelStay(sql, {
      rentableId: fixture.hotel,
      ...dates,
      rooms: [deluxe()],
    });
    const bookings = [];
    for (let i = 0; i < 20; i += 1)
      bookings.push(
        (await insertStayBooking(sql, { customerId: guest, rentableId: fixture.hotel, quote }))
          .bookingId,
      );
    const raw = postgres(db.url, { max: 20, onnotice: () => {} });
    t.after(() => raw.end());
    let seed = 11;
    const random = (max) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const line = quote.lines[0];
    const insert = (bookingId, checkIn, checkOut) =>
      raw.begin(async (tx) => {
        await tx`SELECT pg_sleep(${random(5) / 1000})`;
        await tx`INSERT INTO booking_room (booking_id, rentable_id, room_type_id, rate_plan_id, check_in, check_out, adults, nights, amount_room_minor, amount_tax_minor, plan_snapshot)
        VALUES (${bookingId}, ${fixture.hotel}, ${fixture.deluxe}, ${line.ratePlanId}, ${checkIn}, ${checkOut}, 2, '[]'::jsonb, 0, 0, '{}'::jsonb)`;
      });
    const attempts = bookings.map((bookingId) => {
      const start = random(3);
      return insert(
        bookingId,
        addLocalDays(dates.checkIn, start),
        addLocalDays(dates.checkIn, start + 1 + random(3)),
      );
    });
    const settled = await Promise.allSettled(attempts);
    for (const r of settled.filter((x) => x.status === 'rejected')) {
      assert.ok(
        ['23514', '40P01'].includes(r.reason.code),
        `${r.reason.code}: ${r.reason.message}`,
      );
    }
    const rows = await nightsOf(sql, fixture.deluxe);
    assert.ok(
      rows.every((n) => n.sold + n.held <= n.allotment),
      JSON.stringify(rows),
    );
    const [counted] =
      await sql`SELECT count(*)::int AS lines FROM booking_room WHERE room_type_id=${fixture.deluxe} AND state='held'`;
    const perNight =
      await sql`SELECT to_char(d,'YYYY-MM-DD') AS night, count(*)::int AS rooms FROM booking_room br,
      generate_series(br.check_in, br.check_out - 1, interval '1 day') d WHERE br.room_type_id=${fixture.deluxe} AND br.state='held' GROUP BY 1`;
    for (const { night, rooms } of perNight)
      assert.equal(rows.find((n) => n.night === night).held, rooms, `counter drift on ${night}`);
    assert.ok(counted.lines > 0 && counted.lines < 20);
  });

  await t.test('commission: property rule beats city rule beats vertical rule', async () => {
    const insert = (values) =>
      sql`INSERT INTO commission_rule ${sql({ vertical_code: 'hotel', created_by: fixture.admin, reason: 'test', valid_from: '2026-01-01', ...values })}`;
    await insert({ rate_bps: 1300 });
    await insert({
      rate_bps: 1000,
      city_id: fixture.city,
      tier: 'founding',
      valid_to: '2027-11-30',
    });
    assert.deepEqual(
      await resolveCommission(sql, { rentableId: fixture.hotel, date: '2027-06-01' }).then((r) => [
        r.rateBps,
        r.tier,
      ]),
      [1000, 'founding'],
    );
    assert.equal(
      (await resolveCommission(sql, { rentableId: fixture.hotel, date: '2027-12-01' })).rateBps,
      1300,
    );
    await insert({
      rate_bps: 1500,
      rentable_id: fixture.hotel,
      tier: 'preferred',
      valid_from: '2027-01-01',
    });
    assert.equal(
      (await resolveCommission(sql, { rentableId: fixture.hotel, date: '2027-06-01' })).rateBps,
      1500,
    );
    await rejectsWith(insert({ rate_bps: 1200, valid_from: '2026-06-01' }), '23P01');
    await rejectsWith(
      resolveCommission(sql, { rentableId: fixture.hotel, date: '2025-01-01' }),
      'COMMISSION_UNCONFIGURED',
    );
  });
});
