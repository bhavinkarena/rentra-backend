import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedHotel } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';
import { pointHex } from '../../src/services/domain/geo.js';

/** Hotel plan, Phase 6: search, landmarks, hotel page data and card = page = quote prices. */
test(
  'Phase 6: hotel discovery',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    t.after(() => fixture.drop());
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { searchDiscovery, clearDiscoveryRegistryCache, suggestDestinations, getLandingRoutes } =
      await import('@/services/db/discovery.js');
    const { getHotelAvailability, quoteHotelStay } = await import('@/services/booking/hotel-stays.js');
    const search = async (query) => {
      const { filters, errors } = parseDiscoveryQuery({ vertical: 'hotel', ...query });
      assert.deepEqual(errors, []);
      return searchDiscovery(filters, null, sql);
    };

    const a = await seedHotel(sql);
    const b = await seedHotel(sql);
    const c = await seedHotel(sql);
    // a and b near the station, c far away; b is couple-friendly, c is a resort with no free cancellation.
    const pin = (latitude, longitude) => pointHex({ latitude, longitude });
    await sql`UPDATE rentable SET location=${pin(21.19, 72.838)}, title='Textile Inn' WHERE id=${a.hotel}`;
    // Scores are derived from published reviews; the cache guard is off only for this fixture row.
    await sql`ALTER TABLE rentable DISABLE TRIGGER review_cache_guard`;
    await sql`UPDATE rentable SET location=${pin(21.21, 72.865)}, title='Diamond Court', rating_avg=4.6, review_count=12 WHERE id=${b.hotel}`;
    await sql`ALTER TABLE rentable ENABLE TRIGGER review_cache_guard`;
    await sql`UPDATE rentable SET location=${pin(21.079, 72.716)}, title='Dumas Retreat' WHERE id=${c.hotel}`;
    await sql`UPDATE hotel_profile SET policies='{"couples":true,"localId":true}'::jsonb WHERE rentable_id=${b.hotel}`;
    await sql`UPDATE rate_plan SET free_cancel_hours=NULL WHERE rentable_id=${c.hotel}`;
    await sql`INSERT INTO landmark(city_id,slug,name,kind,latitude,longitude) VALUES (${a.city},'surat-railway-station','Surat Railway Station','station',21.2052,72.8408)`;
    const checkin = addLocalDays(propertyToday(), 12);
    const checkout = addLocalDays(checkin, 2);

    await t.test('hidden or partners-only Hotels are not searchable', async () => {
      await sql`UPDATE vertical SET status='partners' WHERE code='hotel'`;
      clearDiscoveryRegistryCache(sql);
      const { filters } = parseDiscoveryQuery({ vertical: 'hotel' });
      const result = await searchDiscovery(filters, null, sql);
      assert.equal(result.total, 0);
      assert.match(result.errors[0], /available kind of place/);
      await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
      clearDiscoveryRegistryCache(sql);
    });

    await t.test('Story 3.1: zero results tell no inventory from no match', async () => {
      const match = await search({ city: 'surat', min: '99999999' });
      assert.equal(match.total, 0);
      assert.equal(match.meta.inventory, 3);
      const none = await search({ city: 'surat', q: 'no-such-place', min: '1' });
      assert.equal(none.total, 0);
      assert.equal(none.meta.inventory, 0);
      assert.equal((await search({ city: 'surat', q: 'no-such-place' })).meta.inventory, 0);
      // Fully booked: hotels exist, only dates and party exclude them (frontend: booked copy).
      const booked = await search({ city: 'surat', checkin, checkout, rooms: '8', adults: '48' });
      assert.equal(booked.total, 0);
      assert.equal(booked.meta.inventory, 3);
      assert.equal((await search({ city: 'surat' })).meta, undefined);
    });

    await t.test('undated search shows every hotel from its lowest nightly rate', async () => {
      const result = await search({ city: 'surat' });
      assert.equal(result.total, 3);
      // Standard Room only ₹2,000 is below Deluxe Non-refundable (₹2,600 − 10%).
      for (const card of result.items) {
        assert.equal(card.isFromPrice, true);
        assert.equal(card.price, 2000);
        assert.equal(card.unit, 'night');
      }
    });

    await t.test('dated search prices the party; card = page = quote', async () => {
      const result = await search({ city: 'surat', checkin, checkout, rooms: '2', adults: '3', children: '7' });
      assert.equal(result.total, 3);
      const card = result.items.find((item) => item.id === a.hotel);
      assert.equal(card.isFromPrice, false);
      assert.ok(card.offer.roomTypeName);
      assert.match(card.href, new RegExp(`checkin=${checkin}&checkout=${checkout}&rooms=2&adults=3&children=7`));
      const page = await getHotelAvailability(sql, { rentableId: a.hotel, checkIn: checkin, checkOut: checkout, rooms: 2, adults: 3, childAges: [7] });
      const plans = page.roomTypes.flatMap((room) => room.plans.filter((plan) => plan.bookable));
      const cheapest = Math.min(...plans.map((plan) => plan.totalMinor));
      assert.equal(cheapest, card.priceMinor, 'card total equals the cheapest bookable plan on the page');
      const roomType = page.roomTypes.find((room) => room.plans.some((plan) => plan.totalMinor === cheapest));
      const plan = roomType.plans.find((row) => row.totalMinor === cheapest);
      const quote = await quoteHotelStay(sql, {
        rentableId: a.hotel, checkIn: checkin, checkOut: checkout,
        rooms: page.party.map((guests) => ({ roomTypeId: roomType.id, ratePlanId: plan.id, ...guests })),
      });
      assert.equal(quote.totals.totalMinor, card.priceMinor, 'quote total equals the card');
    });

    await t.test('filters: free cancellation, breakfast, couples, rating, budget', async () => {
      const free = await search({ city: 'surat', checkin, checkout, freecancel: '1' });
      assert.deepEqual(free.items.map((i) => i.id).sort(), [a.hotel, b.hotel].sort());
      const breakfast = await search({ city: 'surat', checkin, checkout, breakfast: '1' });
      assert.ok(breakfast.items.every((i) => i.offer.mealPlan !== 'EP'));
      assert.equal(breakfast.items[0].offer.meals, 'Breakfast included');
      const couples = await search({ city: 'surat', couples: '1' });
      assert.deepEqual(couples.items.map((i) => i.id), [b.hotel]);
      assert.equal(couples.items[0].couples, true);
      const rated = await search({ rating: '4.5' });
      assert.deepEqual(rated.items.map((i) => i.id), [b.hotel]);
      const budget = await search({ checkin, checkout, max: '1500' });
      assert.equal(budget.total, 0, 'per room per night incl. tax is above ₹1,500');
    });

    await t.test('near a landmark: within 5 km, sorted by distance', async () => {
      const result = await search({ near: 'surat-railway-station', sort: 'distance' });
      assert.deepEqual(result.items.map((i) => i.id), [a.hotel, b.hotel]);
      assert.ok(result.items[0].distanceKm < result.items[1].distanceKm);
      assert.equal(result.landmark.name, 'Surat Railway Station');
      const { filters } = parseDiscoveryQuery({ vertical: 'hotel', near: 'nowhere' });
      assert.match((await searchDiscovery(filters, null, sql)).errors[0], /landmark/);
    });

    await t.test('autocomplete groups places before hotels', async () => {
      const found = await suggestDestinations('sura', 'hotel', sql);
      assert.equal(found.cities[0].slug, 'surat');
      assert.equal(found.landmarks[0].slug, 'surat-railway-station');
      assert.deepEqual((await suggestDestinations('diamond', 'hotel', sql)).hotels.map((h) => h.name), ['Diamond Court']);
    });

    await t.test('sitemap: couple-friendly needs 3 couple-friendly hotels; landmark needs 3 nearby', async () => {
      let paths = (await getLandingRoutes(sql)).map((route) => route.path);
      assert.ok(paths.includes('/surat/hotels'));
      assert.ok(!paths.some((path) => path.endsWith('/intent/couple-friendly')));
      assert.ok(!paths.includes('/hotels/near/surat-railway-station'));
      await sql`UPDATE hotel_profile SET policies='{"couples":true}'::jsonb`;
      await sql`UPDATE rentable SET location=${pin(21.2, 72.84)} WHERE id=${c.hotel}`;
      clearDiscoveryRegistryCache(sql);
      paths = (await getLandingRoutes(sql)).map((route) => route.path);
      assert.ok(paths.some((path) => path.endsWith('/intent/couple-friendly')));
      assert.ok(paths.includes('/hotels/near/surat-railway-station'));
    });

    await t.test('dated search over 500 hotels: p95 under 300 ms (PERF_GATES=1)', async () => {
      // Clone the fixture hotel 497 times (with its room types and plans) in SQL.
      // DO blocks take no parameters; the id is our own fixture uuid.
      await sql.unsafe(`DO $$
        DECLARE src uuid := '${a.hotel}'; n int; h uuid; rt record; base uuid;
        BEGIN
          FOR n IN 1..497 LOOP
            INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity,status)
              SELECT client_id, slug || '-' || n, title || ' ' || n, category_id, city_id, area_id, 'p' || substr(md5(random()::text), 1, 9), 'night', capacity, 'draft'
              FROM rentable WHERE id = src RETURNING id INTO h;
            INSERT INTO hotel_profile(rentable_id, policies) VALUES (h, '{"couples":true}');
            FOR rt IN SELECT * FROM room_type WHERE rentable_id = src LOOP
              WITH t AS (INSERT INTO room_type(rentable_id,name,max_adults,max_children,max_occupancy,base_occupancy,room_count,extra_adult_minor,extra_child_minor,sort_order)
                VALUES (h, rt.name, rt.max_adults, rt.max_children, rt.max_occupancy, rt.base_occupancy, rt.room_count, rt.extra_adult_minor, rt.extra_child_minor, rt.sort_order) RETURNING id)
              INSERT INTO rate_plan(room_type_id,rentable_id,name,weekday_minor,weekend_minor,free_cancel_hours)
                SELECT t.id, h, 'Room only', 200000 + n * 100, 230000 + n * 100, 24 FROM t RETURNING id INTO base;
              INSERT INTO rate_plan(room_type_id,rentable_id,name,meal_plan,derived_from,derived_per_guest_minor,sort_order)
                SELECT room_type_id, h, 'Breakfast included', 'CP', base, 25000, 1 FROM rate_plan WHERE id = base;
            END LOOP;
            UPDATE rentable SET status = 'live' WHERE id = h;
          END LOOP;
        END $$`);
      const runs = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        const result = await search({ city: 'surat', checkin, checkout, rooms: '1', adults: '2', sort: 'price_asc' });
        runs.push(performance.now() - started);
        assert.equal(result.total, 500);
      }
      runs.sort((x, y) => x - y);
      const p95 = runs[Math.ceil(runs.length * 0.95) - 1];
      t.diagnostic(`p50 ${runs[10].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
      // The 300 ms acceptance gate is measured alone (PERF_GATES=1); beside the rest of the
      // suite the machine is shared, so the default run only catches a per-hotel query regression.
      assert.ok(p95 < (process.env.PERF_GATES === '1' ? 300 : 2000), `p95 ${p95.toFixed(0)} ms`);
    });
  },
);
