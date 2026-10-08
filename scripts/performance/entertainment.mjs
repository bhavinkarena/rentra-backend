/** Local-only Phase 12 gate. Creates and drops its own migrated database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import express from 'express';
import { createDisposableDatabase } from '../../test/helpers/disposable-db.js';
import { seedVenue } from '../../test/helpers/venue-fixture.js';

const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
process.env.DATABASE_URL = fixture.url;
const { sql } = fixture;
let server, apiSql;
try {
  const { createBookingQuote } = await import('../../src/services/booking/quotes.js');
  const { createCheckoutHold } = await import('../../src/services/booking/checkout.js');
  const { setPaymentGatewayConfiguration } =
    await import('../../src/services/payments/gateway-settings.js');
  const { addLocalDays, propertyToday } =
    await import('../../src/services/domain/booking-dates.js');
  const { default: discovery } = await import('../../src/routes/discovery.route.js');
  apiSql = (await import('../../src/services/db/index.js')).sql;
  const v = await seedVenue(sql);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    RAZORPAY_KEY_ID: 'rzp_test_PERFORMANCE',
    RAZORPAY_KEY_SECRET: 'local-performance-fixture',
    RAZORPAY_WEBHOOK_SECRET: 'local-performance-webhook',
  };
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
  const date = addLocalDays(propertyToday(), 10);
  const customers = [];
  for (let i = 0; i < 5; i++) {
    const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
      VALUES (${`load${i}@fixture.invalid`},${`900000020${i}`},'customer','active','Load fixture') RETURNING id`;
    const [session] =
      await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${user.id},now()+interval '1 day') RETURNING id`;
    const selection = {
      kind: 'hourly',
      rentableId: v.venue,
      activity: 'box-cricket',
      date,
      start: `${10 + i}:00`,
      durationMinutes: 60,
      guests: 6,
    };
    const quote = await createBookingQuote(sql, selection, { customerId: user.id, variables: env });
    customers.push({
      session: { role: 'customer', userId: user.id, sessionId: session.id },
      quote,
      selection,
    });
  }
  const app = express();
  const { responseEnhancer } = await import('../../src/middlewares/responseEnhancer.middleware.js');
  app.use(responseEnhancer);
  app.use('/discovery', discovery);
  app.use((error, req, res, _next) => {
    res.status(500).json({ code: error.code, message: error.message });
  });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/discovery/listings/venue001/times?date=${date}&activity=box-cricket&duration=60&guests=6`;
  const request = async () => {
    const start = performance.now();
    const response = await fetch(endpoint);
    if (response.status !== 200) throw new Error(await response.text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.data.advisory, false);
    return performance.now() - start;
  };
  const { getTimeSlots } = await import('../../src/services/booking/time-slots.js');
  await getTimeSlots(apiSql, {
    rentableId: v.venue,
    date,
    activity: 'box-cricket',
    durationMinutes: 60,
    guests: 6,
  });
  await request();
  const holdLatencies = [];
  const hold = async ({ session, quote }) => {
    const started = performance.now();
    const result = await createCheckoutHold(
      sql,
      session,
      {
        rentableId: v.venue,
        quoteId: quote.id,
        hash: quote.hash,
        version: quote.version,
        idempotencyKey: randomUUID(),
        accepted: true,
      },
      env,
    );
    holdLatencies.push(performance.now() - started);
    return result;
  };
  const [latencies, holds] = await Promise.all([
    Promise.all(Array.from({ length: 50 }, request)),
    Promise.all(customers.map(hold)),
  ]);
  assert.equal(holds.length, 5);
  // 20 persisted quotes alongside another hold.
  const input = customers[0];
  const extraQuote = await createBookingQuote(
    sql,
    { ...input.selection, start: '22:00' },
    { customerId: input.session.userId, variables: env },
  );
  const [quotes] = await Promise.all([
    Promise.all(
      Array.from({ length: 20 }, () =>
        createBookingQuote(
          sql,
          { ...input.selection, start: '21:00' },
          { customerId: input.session.userId, variables: env },
        ),
      ),
    ),
    hold({ ...input, quote: extraQuote }),
  ]);
  assert.equal(new Set(quotes.map((q) => q.hash)).size, 1);
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  const [farmCategory] = await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit)
    VALUES ('load-farm','Load farm','farmhouse','slot') RETURNING id`;
  const farmConfig = {
    inventoryReady: true,
    timeZone: 'Asia/Kolkata',
    leadTimeMinutes: 60,
    bookingHorizonDays: 90,
    slots: {
      day: {
        enabled: true,
        startTime: '09:00',
        endTime: '18:00',
        endDayOffset: 0,
        bufferBeforeMinutes: 30,
        bufferAfterMinutes: 30,
        capacity: 12,
        includedGuests: 12,
        extraGuestChargeMinor: 0,
      },
      night: { enabled: false },
      full_day: { enabled: false },
    },
  };
  const [farm] =
    await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity)
    SELECT client_id,'load-farm','Load farm',${farmCategory.id},city_id,area_id,'loadfarm','slot',12
    FROM rentable WHERE id=${v.venue} RETURNING id`;
  await sql`INSERT INTO rentable_price(rentable_id,slot,weekday_minor,weekend_minor)
    VALUES (${farm.id},'day',100000,100000)`;
  await sql`UPDATE rentable SET booking_config=${sql.json(farmConfig)},status='live' WHERE id=${farm.id}`;
  const farmhouseCheckoutMs = [];
  for (let i = 0; i < 50; i++) {
    const [user] = await sql`INSERT INTO "user"(email,phone,role,account_status,name)
      VALUES (${`farmload${i}@fixture.invalid`},${`910000${String(i).padStart(4, '0')}`},'customer','active','Farm load fixture') RETURNING id`;
    const [session] =
      await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${user.id},now()+interval '1 day') RETURNING id`;
    const who = { session: { role: 'customer', userId: user.id, sessionId: session.id } };
    const day = addLocalDays(date, i);
    await sql`INSERT INTO availability(rentable_id,day,slot,units_available) VALUES (${farm.id},${day},'day',1)`;
    const started = performance.now();
    const q = await createBookingQuote(
      sql,
      { rentableId: farm.id, dates: [day], slot: 'day', guests: 6 },
      { customerId: who.session.userId, variables: env },
    );
    await createCheckoutHold(
      sql,
      who.session,
      {
        rentableId: farm.id,
        quoteId: q.id,
        hash: q.hash,
        version: q.version,
        idempotencyKey: randomUUID(),
        accepted: true,
      },
      env,
    );
    farmhouseCheckoutMs.push(Number((performance.now() - started).toFixed(2)));
  }
  // Enough terminal-free ledger history for the planner to choose a selective range scan.
  await sql`INSERT INTO inventory_reservation(rentable_id,resource_id,source,blocked_start_at,blocked_end_at,state,created_by,reason)
    SELECT ${v.venue},${v.court1},'owner_block',
      '2020-01-01'::timestamptz + n * interval '2 hours',
      '2020-01-01'::timestamptz + n * interval '2 hours' + interval '1 hour',
      'committed',${v.owner},'Performance history' FROM generate_series(0,9999) n`;
  await sql`ANALYZE inventory_reservation`;
  const plan = await sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM inventory_reservation
    WHERE rentable_id=${v.venue} AND state IN ('held','committed')
    AND tstzrange(blocked_start_at,blocked_end_at,'[)') &&
      tstzrange(${date}::date-interval '2 days',${date}::date+interval '3 days','[)')`;
  const queryPlan = plan[0]['QUERY PLAN'];
  assert.match(JSON.stringify(queryPlan), /reservation_active_overlap_excl/);
  const report = {
    date: new Date().toISOString(),
    requests: 50,
    concurrentHolds: 5,
    holdMaxMs: Number(Math.max(...holdLatencies).toFixed(2)),
    p95Ms: Number(p95.toFixed(2)),
    maxMs: Number(latencies.at(-1).toFixed(2)),
    quoteHashesEqual: true,
    farmhouseCheckoutMs,
    reservationPlan: queryPlan,
  };
  await writeFile(
    new URL('../../docs/entertainment-performance.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({ ...report, reservationPlan: 'GiST index verified' }));
  assert.ok(p95 < 150, `times p95 ${p95.toFixed(2)}ms exceeds 150ms`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (apiSql && apiSql !== sql) await apiSql.end();
  await fixture.drop();
}
