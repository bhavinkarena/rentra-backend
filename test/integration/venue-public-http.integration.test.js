import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import {
  addLocalDays,
  isWeekendLocalDate,
  propertyToday,
} from '../../src/services/domain/booking-dates.js';

/**
 * Entertainment plan, Phase 4: the public HTTP contract for venues, through the
 * real Express app. The app's pool reads DATABASE_URL at import, so this file
 * points it at its own disposable database before importing the app (node
 * --test runs each file in its own process).
 */
let fixture, server, base, date;
const skip = !process.env.PORTAL_TEST_DATABASE_URL;

before(async () => {
  if (skip) return;
  fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  process.env.DATABASE_URL = fixture.url;
  process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
  const [{ udt_name: geometryType }] =
    await fixture.sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
  if (geometryType !== 'geometry') {
    await fixture.sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
    await fixture.sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  }
  await seedVenue(fixture.sql, { vertical: 'hidden' });
  date = addLocalDays(propertyToday(), 8);
  while (isWeekendLocalDate(date)) date = addLocalDays(date, 1);
  const { createApp } = await import('@/app.js');
  const { config } = await import('@/config/env.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}${config().API_PREFIX}`;
});

after(async () => {
  if (skip) return;
  server?.close();
  const { sql } = await import('@/config/database.js');
  await sql.end({ timeout: 5 }).catch(() => {});
  await fixture.drop();
});

const get = async (path) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json(), headers: response.headers };
};

test(
  'Phase 4: hidden venues leave no public trace; public venues serve cards, detail, times and availability',
  { skip },
  async () => {
    // Hidden vertical: detail, times and cards behave as if the venue did not exist.
    assert.equal((await get('/discovery/listings/venue001')).status, 404);
    assert.equal(
      (
        await get(
          `/discovery/listings/venue001/times?date=${date}&activity=box-cricket&duration=60`,
        )
      ).status,
      404,
    );
    assert.deepEqual((await get('/discovery/listings?vertical=entertainment')).body.data, []);
    assert.deepEqual(
      (await get('/discovery/registry')).body.data.verticals.map((v) => v.code),
      ['farmhouse'],
    );

    await fixture.sql`UPDATE vertical SET status='public' WHERE code='entertainment'`;
    // The admin command clears this process's 60s registry cache after its write; do the same here.
    (await import('@/services/db/discovery.js')).clearDiscoveryRegistryCache();

    // Cards: farmhouse by default (unchanged contract), venues on request.
    assert.deepEqual((await get('/discovery/listings')).body.data, []);
    const cards = (await get('/discovery/listings?vertical=entertainment')).body.data;
    assert.equal(cards.length, 1);
    assert.deepEqual(
      [
        cards[0].unit,
        cards[0].price,
        cards[0].resourceCount,
        cards[0].maxPlayers,
        cards[0].vertical,
      ],
      ['hour', 600, 3, 12, 'entertainment'],
    );

    // Detail: courts, activities, hours and rate bands; no slot prices.
    // A farmhouse-only amenity never reaches a venue page, not even as "not confirmed".
    const [pool] =
      await fixture.sql`INSERT INTO amenity(slug,group_slug,label_en,is_filterable) VALUES ('venue-test-pool','outdoors','Venue test pool',true) RETURNING id`;
    await fixture.sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${pool.id},'farmhouse')`;
    const detail = (await get('/discovery/listings/venue001')).body.data;
    assert.ok(!JSON.stringify(detail.amenities).includes('Venue test pool'));
    assert.equal(detail.bookable, true);
    assert.equal(detail.rentalUnit, 'hour');
    assert.deepEqual(
      detail.resources.map((r) => r.name),
      ['Court 1', 'Court 2', 'Pickleball 1'],
    );
    assert.equal(
      detail.rates.find(
        (r) => r.activity === 'box-cricket' && r.dayKind === 'weekday' && r.from === '18:00',
      ).hourlyRate,
      1200,
    );
    assert.equal(detail.openingHours.stepMinutes, 60);
    assert.deepEqual([detail.prices, detail.slotSchedules], [{}, []]);

    // Times: no-store, rate-limited, and only free/busy facts.
    const times = await get(
      `/discovery/listings/venue001/times?date=${date}&activity=box-cricket&duration=60&guests=6`,
    );
    assert.equal(times.status, 200);
    assert.equal(times.headers.get('cache-control'), 'no-store');
    assert.ok(
      times.headers.get('ratelimit-policy') || times.headers.get('ratelimit'),
      'discovery limiter headers present',
    );
    assert.equal(times.body.data.times.length, 18);
    assert.equal(times.body.data.times.find((t) => t.start === '18:00').rentMinor, 120000);
    assert.equal(
      (await get(`/discovery/listings/venue001/times?date=${date}&activity=bowling&duration=60`))
        .body.code,
      'ACTIVITY_UNAVAILABLE',
    );
    assert.equal(
      (await get(`/discovery/listings/venue001/times?date=${date}`)).body.code,
      'BAD_TIMES_QUERY',
    );

    // Availability on a venue is the date strip.
    const strip = (
      await get(
        `/discovery/listings/venue001/availability?from=${date}&days=3&activity=box-cricket&duration=60`,
      )
    ).body.data;
    assert.equal(strip.days[date].freeStarts, 18);
    assert.equal(
      (await get('/discovery/listings/venue001/availability?days=3')).body.code,
      'BAD_DATE_RANGE',
    );

    // Next dates and search.
    assert.ok((await get('/discovery/listings/venue001/next-dates')).body.data.hourly.length > 0);
    const search = (
      await get(
        `/discovery/search?vertical=entertainment&category=box-cricket&date=${date}&start=20:00&duration=60`,
      )
    ).body.data;
    assert.equal(search.items[0].times[0].start, '20:00');
    const landing = (await get('/discovery/route-count?path=/surat/entertainment')).body.data;
    assert.equal(landing.count, 1);
  },
);
