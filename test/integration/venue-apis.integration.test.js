import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue, venueConfig } from '../helpers/venue-fixture.js';
import { insertFixtureOrder } from '../helpers/fixture-order.js';
import {
  getDiscoveryRegistry,
  searchDiscovery,
  countDiscoveryRoute,
} from '../../src/services/db/discovery.js';
import { parseDiscoveryQuery, resolveDiscoveryRoute } from '../../src/services/domain/discovery.js';
import { listVerticals, verticalCommand } from '../../src/services/catalogues/verticals.js';
import { getCategories, getPartnerVerticals } from '../../src/services/db/listing-queries.js';
import { saveVenueResources } from '../../src/services/booking/venue.js';
import { changeHourlyRates } from '../../src/services/booking/hourly-rates.js';
import {
  saveBookingConfiguration,
  openBookingDates,
} from '../../src/services/booking/owner-settings.js';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import {
  addLocalDays,
  isWeekendLocalDate,
  propertyToday,
} from '../../src/services/domain/booking-dates.js';

/**
 * Entertainment plan, Phase 4: the launch switch, vertical-aware discovery, and
 * the owner/admin APIs for courts, hourly prices and opening hours. The
 * Drizzle-backed card queries use the app pool, so DATABASE_URL must point at the
 * same disposable server; they are exercised through searchDiscovery here.
 */
async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

test(
  'Phase 4: launch switch, venue discovery, courts, hourly prices and hours APIs',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const v = await seedVenue(sql, { vertical: 'hidden' });
      const admin = { kind: 'admin', id: v.admin };
      const [farmCategory] =
        await sql`INSERT INTO category(slug,name) VALUES ('farmhouse','Farmhouse') RETURNING id`;

      // Hidden: no public trace, no partner catalogue, no quotes.
      let registry = await getDiscoveryRegistry(sql);
      assert.deepEqual(
        registry.verticals.map((r) => r.code),
        ['farmhouse'],
      );
      assert.equal(
        registry.categories.some((c) => c.slug === 'box-cricket'),
        false,
      );
      assert.deepEqual(
        (await getPartnerVerticals(sql)).map((r) => r.code),
        ['farmhouse'],
      );
      let date = addLocalDays(propertyToday(), 9);
      while (isWeekendLocalDate(date)) date = addLocalDays(date, 1);
      const selection = {
        kind: 'hourly',
        rentableId: v.venue,
        activity: 'box-cricket',
        date,
        start: '18:00',
        durationMinutes: 60,
        guests: 6,
      };
      await rejectsWith(createBookingQuote(sql, selection), 'LISTING_UNAVAILABLE');

      // Admin launch switch: preview → apply; farmhouse cannot be hidden.
      const before = (await listVerticals(sql, admin)).items.find(
        (r) => r.code === 'entertainment',
      );
      const change = {
        version: before.version,
        name: 'Entertainment',
        sortOrder: 20,
        status: 'public',
        reason: 'Launch in Surat after pilot review',
      };
      const preview = await verticalCommand(sql, admin, 'entertainment', {
        ...change,
        preview: true,
      });
      assert.match(preview.effect, /Guests will see/);
      await rejectsWith(
        verticalCommand(sql, admin, 'entertainment', {
          ...change,
          preview: false,
          previewHash: '0'.repeat(64),
        }),
        'STALE_PREVIEW',
      );
      await verticalCommand(sql, admin, 'entertainment', {
        ...change,
        preview: false,
        previewHash: preview.previewHash,
      });
      const farm = (await listVerticals(sql, admin)).items.find((r) => r.code === 'farmhouse');
      await rejectsWith(
        verticalCommand(sql, admin, 'farmhouse', {
          version: farm.version,
          name: 'Farmhouse',
          sortOrder: 10,
          status: 'hidden',
          reason: 'Trying to hide farmhouses',
          preview: true,
        }),
        'MIGRATION_REQUIRED',
      );

      // Public: registry carries the vertical and its activities with icons and booking model.
      registry = await getDiscoveryRegistry(sql);
      assert.deepEqual(
        registry.verticals.map((r) => r.code),
        ['farmhouse', 'entertainment'],
      );
      const cricket = registry.categories.find((c) => c.slug === 'box-cricket');
      assert.deepEqual([cricket.vertical, cricket.rentalUnit], ['entertainment', 'hour']);

      // Search: undated from-price per hour; activity-scoped price; dated free times; capacity and mismatch.
      const search = async (query) =>
        searchDiscovery(parseDiscoveryQuery(query).filters, null, sql, registry);
      let result = await search({ vertical: 'entertainment', city: 'surat' });
      assert.equal(result.items.length, 1);
      assert.deepEqual(
        [result.items[0].unit, result.items[0].price, result.items[0].isFromPrice],
        ['hour', 600, true],
      );
      assert.equal(result.items[0].resourceCount, 3);
      assert.deepEqual(result.items[0].activities.map((a) => a.slug).sort(), [
        'box-cricket',
        'pickleball',
      ]);
      result = await search({ vertical: 'entertainment', city: 'surat', category: 'box-cricket' });
      assert.equal(result.items[0].price, 800);
      result = await search({
        vertical: 'entertainment',
        category: 'box-cricket',
        date,
        start: '18:00',
        duration: '60',
        players: '6',
      });
      assert.equal(result.items[0].times[0].start, '18:00');
      assert.deepEqual([result.items[0].price, result.items[0].isFromPrice], [1200, false]);
      assert.match(result.items[0].href, /\?activity=box-cricket&date=/);
      assert.equal(
        (await search({ vertical: 'entertainment', category: 'pickleball', players: '5' })).items
          .length,
        0,
      );
      assert.match(
        (await search({ vertical: 'entertainment', category: 'farmhouse' })).errors[0],
        /not in this kind of place/,
      );
      assert.equal(
        (await search({})).items.some((card) => card.id === v.venue),
        false,
        'farmhouse search never shows venues',
      );

      // Landing routes: an activity and the whole vertical in a city.
      const activityRoute = resolveDiscoveryRoute(registry, ['surat', 'box-cricket']);
      const verticalRoute = resolveDiscoveryRoute(registry, ['surat', 'entertainment']);
      assert.equal(await countDiscoveryRoute(activityRoute, sql), 1);
      assert.equal(await countDiscoveryRoute(verticalRoute, sql), 1);
      assert.equal(
        resolveDiscoveryRoute(registry, ['surat', 'box-cricket', 'intent', 'with-pool']),
        null,
      );

      // Partner catalogue is vertical-scoped.
      await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES ('floodlights','play','Floodlights')`;
      await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) SELECT id,'entertainment' FROM amenity WHERE slug='floodlights'`;
      const categoryList = await getCategories({ vertical: 'entertainment' }, sql);
      assert.deepEqual(categoryList.map((c) => c.slug).sort(), ['box-cricket', 'pickleball']);
      void farmCategory;

      // Courts: add one, and refuse to strand an upcoming booking.
      const [{ content_version: v1 }] =
        await sql`SELECT content_version FROM rentable WHERE id=${v.venue}`;
      const courts = [
        { id: v.court1, name: 'Court 1', capacity: 12, activities: ['box-cricket'], sortOrder: 1 },
        { id: v.court2, name: 'Court 2', capacity: 12, activities: ['box-cricket'], sortOrder: 2 },
        {
          name: 'Court 3',
          capacity: 14,
          isIndoor: true,
          activities: ['box-cricket'],
          sortOrder: 4,
          details: { size: '40 x 90 ft' },
        },
      ];
      await rejectsWith(
        saveVenueResources(sql, v.owner, {
          rentableId: v.venue,
          expectedVersion: v1 - 1,
          resources: courts,
        }),
        'LISTING_CHANGED',
      );
      const saved = await saveVenueResources(sql, v.owner, {
        rentableId: v.venue,
        expectedVersion: v1,
        resources: courts,
      });
      assert.equal(saved.resourceIds.length, 3);
      // Courts are trust content: changing them on a live venue sends it back to review (Phase 5).
      assert.equal(saved.sentBack, true);
      const [{ status: reviewStatus }] = await sql`SELECT status FROM rentable WHERE id=${v.venue}`;
      assert.equal(reviewStatus, 'pending_review');
      await sql`UPDATE rentable SET status='live' WHERE id=${v.venue}`; // re-approved, for the steps below
      const [{ capacity, active }] =
        await sql`SELECT r.capacity, (SELECT count(*)::int FROM rentable_resource WHERE rentable_id=r.id AND is_active) active FROM rentable r WHERE r.id=${v.venue}`;
      assert.deepEqual(
        [capacity, active],
        [14, 3],
        'pickleball court (omitted) deactivated; capacity follows the largest court',
      );
      const [customer] =
        await sql`INSERT INTO "user"(email,phone,role,account_status,name) VALUES ('booker@fixture.invalid','9000000222','customer','active','Booker') RETURNING id`;
      const orderId = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: v.venue,
      });
      const start = new Date(`${date}T21:00:00+05:30`),
        end = new Date(`${date}T22:00:00+05:30`);
      const [visit] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,resource_id,guests,state,
          starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,slot_snapshot)
        VALUES (${'T' + randomUUID().replaceAll('-', '').slice(0, 15)},${v.venue},${customer.id},${orderId},1,${date},'hourly',${v.court1},6,'confirmed',
          ${start.toISOString()},${end.toISOString()},${start.toISOString()},${end.toISOString()},true,'INR','Asia/Kolkata',120000,9600,0,
          ${sql.json({ activity: { id: cricket.id, slug: 'box-cricket', name: 'Box cricket' }, startMinute: 1260, durationMinutes: 60 })}) RETURNING id`;
      await sql`INSERT INTO inventory_reservation(booking_id,rentable_id,resource_id,source,blocked_start_at,blocked_end_at,state)
        VALUES (${visit.id},${v.venue},${v.court1},'booking',${start.toISOString()},${end.toISOString()},'committed')`;
      const [{ content_version: v2 }] =
        await sql`SELECT content_version FROM rentable WHERE id=${v.venue}`;
      await rejectsWith(
        saveVenueResources(sql, v.owner, {
          rentableId: v.venue,
          expectedVersion: v2,
          resources: courts.slice(1),
        }),
        'RESOURCE_HAS_BOOKINGS',
      );

      // Hourly prices: gaps are refused with the missing hours, then preview → apply.
      const weekdayOnly = [
        {
          activity: 'box-cricket',
          dayKind: 'weekday',
          from: '06:00',
          to: '01:00',
          toNextDay: true,
          hourlyRate: 900,
        },
      ];
      await rejectsWith(
        changeHourlyRates(sql, v.owner, v.venue, {
          rates: weekdayOnly,
          expectedVersion: v2,
          preview: true,
        }),
        'PRICE_GAP',
      );
      const full = [
        ...weekdayOnly,
        {
          activity: 'box-cricket',
          dayKind: 'weekend',
          from: '06:00',
          to: '01:00',
          toNextDay: true,
          hourlyRate: 1100,
        },
      ];
      const ratesPreview = await changeHourlyRates(sql, v.owner, v.venue, {
        rates: full,
        expectedVersion: v2,
        preview: true,
      });
      await rejectsWith(
        changeHourlyRates(sql, v.owner, v.venue, {
          rates: full,
          expectedVersion: v2,
          preview: false,
          previewToken: 'x',
        }),
        'PREVIEW_REQUIRED',
      );
      await changeHourlyRates(sql, v.owner, v.venue, {
        rates: full,
        expectedVersion: v2,
        preview: false,
        previewToken: ratesPreview.preview.token,
      });
      const quote = await createBookingQuote(sql, selection);
      assert.equal(quote.totals.rentMinor, 90000);

      // Opening hours: saved with the venue schema; bookings outside new hours are kept and listed.
      const [{ booking_config_version: cfg }] =
        await sql`SELECT booking_config_version FROM rentable WHERE id=${v.venue}`;
      const short = [{ open: '08:00', close: '20:00', closesNextDay: false }];
      const { inventoryReady, ...config } = venueConfig;
      void inventoryReady;
      const hours = await saveBookingConfiguration(sql, v.owner, {
        rentableId: v.venue,
        expectedVersion: cfg,
        configuration: {
          ...config,
          weeklyHours: Object.fromEntries(
            Object.keys(config.weeklyHours).map((day) => [day, short]),
          ),
        },
      });
      assert.equal(hours.outsideHours.length, 1);
      // A slot-shaped config on a venue fails the venue schema.
      await assert.rejects(
        saveBookingConfiguration(sql, v.owner, {
          rentableId: v.venue,
          expectedVersion: hours.version,
          configuration: {
            timeZone: 'Asia/Kolkata',
            leadTimeMinutes: 0,
            bookingHorizonDays: 30,
            slots: {},
          },
        }),
        (error) => error.name === 'ZodError',
      );
      await rejectsWith(
        openBookingDates(sql, v.owner, { rentableId: v.venue, from: date, to: date }),
        'UNSUPPORTED_INVENTORY',
      );
    } finally {
      await fixture.drop();
    }
  },
);
