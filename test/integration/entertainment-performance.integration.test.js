import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { getSearchTimeSlots, getTimeSlots } from '../../src/services/booking/time-slots.js';
import {
  createOwnerBlock,
  withListingSnapshot,
  prepareInventoryCheck,
  inventoryWindow,
} from '../../src/services/booking/inventory.js';
import {
  addLocalDays,
  propertyToday,
  visitInterval,
} from '../../src/services/domain/booking-dates.js';

test(
  'Phase 12: batch grids equal individual snapshots and do not wait for the listing mutex',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const venue = await seedVenue(sql);
      const date = addLocalDays(propertyToday(), 10);
      const selection = {
        rentableId: venue.venue,
        date,
        activity: 'box-cricket',
        durationMinutes: 60,
        guests: 6,
      };
      const compare = async () => {
        const single = await getTimeSlots(sql, selection);
        const batch = await getSearchTimeSlots(sql, [selection]);
        assert.ifError(batch.get(venue.venue).error);
        assert.deepEqual(batch.get(venue.venue).times, single.times);
        return single;
      };
      await compare();
      await createOwnerBlock(sql, venue.owner, {
        rentableId: venue.venue,
        blockedStartAt: `${date}T18:00:00+05:30`,
        blockedEndAt: `${date}T20:00:00+05:30`,
        reason: 'Performance parity fixture',
      });
      const blocked = await compare();
      assert.equal(
        blocked.times.some((t) => t.start === '18:00'),
        false,
      );
      for (const durationMinutes of [60, 120, 180]) {
        const input = { ...selection, durationMinutes };
        assert.deepEqual(
          (await getSearchTimeSlots(sql, [input])).get(venue.venue).times,
          (await getTimeSlots(sql, input)).times,
        );
      }
      // Keep a writer open. A lock-taking reader would fail its statement timeout.
      await sql.begin(async (writer) => {
        await writer`UPDATE rentable SET updated_at=updated_at WHERE id=${venue.venue}`;
        await sql.begin(async (reader) => {
          await reader`SET LOCAL statement_timeout='1500ms'`;
          assert.deepEqual(
            (await getSearchTimeSlots(reader, [selection])).get(venue.venue).times,
            blocked.times,
          );
        });
      });
      // Different venue, court and price in the same batch must not leak into each other.
      const [other] =
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity)
        SELECT client_id,'other-arena','Other arena',category_id,city_id,area_id,'venue002','hour',12
        FROM rentable WHERE id=${venue.venue} RETURNING id,category_id`;
      const [court] = await sql`INSERT INTO rentable_resource(rentable_id,name,capacity)
        VALUES (${other.id},'Other court',12) RETURNING id`;
      await sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id)
        VALUES (${court.id},${other.id},${other.category_id})`;
      await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
        SELECT ${other.id},category_id,day_kind,start_minute,end_minute,hourly_rate_minor+10000
        FROM rentable_rate WHERE rentable_id=${venue.venue} AND category_id=${other.category_id}`;
      await sql`UPDATE rentable SET status='live',booking_config=(SELECT booking_config FROM rentable WHERE id=${venue.venue})
        WHERE id=${other.id}`;
      const otherSelection = { ...selection, rentableId: other.id };
      const multi = await getSearchTimeSlots(sql, [selection, otherSelection]);
      assert.deepEqual(multi.get(venue.venue).times, blocked.times);
      assert.deepEqual(multi.get(other.id).times, (await getTimeSlots(sql, otherSelection)).times);
      assert.ok(
        multi
          .get(other.id)
          .times.every(
            (time) => time.freeResourceIds.length === 1 && time.freeResourceIds[0] === court.id,
          ),
      );
      // Deterministic randomized farmhouse calendar: full and windowed decisions agree.
      const [category] = await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit)
        VALUES ('performance-farm','Performance farm','farmhouse','slot') RETURNING id`;
      const schedule = {
        enabled: true,
        startTime: '09:00',
        endTime: '08:00',
        endDayOffset: 1,
        bufferBeforeMinutes: 30,
        bufferAfterMinutes: 30,
      };
      const config = { inventoryReady: true, slots: { night: schedule } };
      const [farm] =
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity,booking_config)
        SELECT client_id,'performance-farm','Performance farm',${category.id},city_id,area_id,'perffarm','slot',12,${sql.json(config)}
        FROM rentable WHERE id=${venue.venue} RETURNING id`;
      let random = 1212;
      const next = () => {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        return random;
      };
      for (let day = 0; day < 80; day++) {
        await sql`INSERT INTO availability(rentable_id,day,slot,units_available)
          VALUES (${farm.id},${addLocalDays(date, day)},'night',${next() % 3 === 0 ? 0 : 1})`;
      }
      await withListingSnapshot(sql, farm.id, async (tx, listing) => {
        const full = await prepareInventoryCheck(tx, listing);
        for (let sample = 0; sample < 60; sample++) {
          const visit = { date: addLocalDays(date, next() % 80), slot: 'night' };
          Object.assign(visit, visitInterval({ ...visit, schedule }));
          const windowed = await prepareInventoryCheck(tx, listing, inventoryWindow([visit]));
          assert.deepEqual(windowed([visit]), full([visit]));
        }
      });
      await sql`UPDATE vertical SET status='hidden' WHERE code='entertainment'`;
      assert.equal(
        (await getSearchTimeSlots(sql, [selection])).get(venue.venue).error.code,
        'LISTING_UNAVAILABLE',
      );
    } finally {
      await fixture.drop();
    }
  },
);
