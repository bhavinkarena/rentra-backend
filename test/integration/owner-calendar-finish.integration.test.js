import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import {
  ownerPortfolioCalendar,
  calendarSnapshot,
  calendarCommand,
} from '../../src/services/booking/owner-calendar.js';
import {
  changeCalendarCells,
  undoCalendarCells,
} from '../../src/services/booking/calendar-bulk.js';
import { ownerCalendarPage } from '../../src/services/booking/calendar-page.js';
import {
  createOwnerBlock,
  releaseOwnerBlock,
  withListingSnapshot,
} from '../../src/services/booking/inventory.js';
import { setAutoOpen } from '../../src/services/booking/owner-settings.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

process.env.SESSION_SECRET ||= 'calendar-finish-test-secret';

test(
  'Phase 7 calendar finish: batched 10x30 portfolio, block Undo, block pages, Full-day alignment, auto-open offer and schedule',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const f = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = f.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = f.url;
      const ids = await seedReviewFixture(sql),
        today = propertyToday(),
        day = addLocalDays(today, 10);
      const day0 = (d) => `${d}T00:00:00+05:30`;
      // Ten properties, thirty open days each, with blocks to enrich.
      await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,capacity,farm_size,exact_address,check_in_from,check_out_by,photos,booking_config,location)
        SELECT client_id,slug||n,title||' '||n,description,category_id,city_id,area_id,'perf'||lpad(n::text,4,'0'),capacity,farm_size,exact_address,check_in_from,check_out_by,photos,booking_config,location
        FROM rentable CROSS JOIN generate_series(2,10) n WHERE id=${ids.listing}`;
      await sql`UPDATE rentable SET photos='[{"url":"https://res.cloudinary.com/fixture/image/upload/farm.jpg","alt":"Farm"}]'::jsonb`;
      await sql`INSERT INTO rentable_price(rentable_id,slot,weekday_minor,weekend_minor) SELECT id,'day',100000,150000 FROM rentable WHERE id<>${ids.listing}`;
      await sql`INSERT INTO availability(rentable_id,day,slot,units_available)
        SELECT r.id,d::date,s::availability_slot,1 FROM rentable r CROSS JOIN generate_series(${today}::date,${today}::date+40,interval '1 day') d CROSS JOIN unnest(ARRAY['day','night']) s`;
      for (const { id } of await sql`SELECT id FROM rentable`)
        await createOwnerBlock(sql, ids.owner, {
          rentableId: id,
          blockedStartAt: `${addLocalDays(today, 3)}T10:00:00+05:30`,
          blockedEndAt: `${addLocalDays(today, 3)}T12:00:00+05:30`,
          reason: 'Pool cleaning',
        });
      await ownerPortfolioCalendar(sql, ids.owner, { from: today, days: 30 }); // warm-up
      const started = performance.now();
      const portfolio = await ownerPortfolioCalendar(sql, ids.owner, { from: today, days: 30 });
      const elapsed = Math.round(performance.now() - started);
      console.log(`CAL-01 portfolio 10 properties x 30 days: ${elapsed} ms`);
      assert.equal(portfolio.items.length, 10);
      assert.ok(elapsed < 1500, `portfolio read took ${elapsed} ms`);
      assert.equal(portfolio.items[0].cells.length, 90);
      assert.ok(portfolio.items[0].photo?.url);
      // The batched version is the command guard's version for the same window.
      const single = await withListingSnapshot(sql, ids.listing, (tx, listing) =>
        calendarSnapshot(tx, listing, { from: day0(today), to: day0(addLocalDays(today, 30)) }),
      );
      assert.equal(portfolio.items.find((i) => i.id === ids.listing).version, single.version);

      // CAL-03: release a block, Undo restores it; a newer change in the window refuses Undo.
      const [block] =
        await sql`SELECT id FROM inventory_reservation WHERE rentable_id=${ids.listing} AND source='owner_block'`;
      const release = (preview, previewToken) =>
        calendarCommand(
          sql,
          ids.owner,
          {
            rentableId: ids.listing,
            command: 'unblock',
            values: { blockId: block.id, rentableId: ids.listing },
            expectedCalendarVersion: 'page',
            preview,
            previewToken,
          },
          (database) =>
            releaseOwnerBlock(database, ids.owner, { rentableId: ids.listing, blockId: block.id }),
        );
      let preview = await release(true);
      let released = await release(false, preview.preview.token);
      assert.ok(released.undoToken);
      await undoCalendarCells(sql, ids.owner, released.undoToken);
      assert.equal(
        (await sql`SELECT state FROM inventory_reservation WHERE id=${block.id}`)[0].state,
        'committed',
      );
      preview = await release(true);
      released = await release(false, preview.preview.token);
      await createOwnerBlock(sql, ids.owner, {
        rentableId: ids.listing,
        blockedStartAt: `${addLocalDays(today, 3)}T15:00:00+05:30`,
        blockedEndAt: `${addLocalDays(today, 3)}T16:00:00+05:30`,
        reason: 'Newer block',
      });
      await assert.rejects(
        undoCalendarCells(sql, ids.owner, released.undoToken),
        (e) => e.code === 'CALENDAR_CHANGED',
      );

      // Active blocks are paged, 20 at a time.
      for (let n = 0; n < 22; n += 1)
        await createOwnerBlock(sql, ids.owner, {
          rentableId: ids.listing,
          blockedStartAt: `${addLocalDays(today, 20 + n)}T01:00:00+05:30`,
          blockedEndAt: `${addLocalDays(today, 20 + n)}T02:00:00+05:30`,
          reason: `Repair ${n}`,
        });
      const first = await ownerCalendarPage(sql, ids.owner, ids.listing);
      const second = await ownerCalendarPage(sql, ids.owner, ids.listing, { blocksPage: 2 });
      assert.equal(first.blocks.length, 20);
      assert.equal(first.blocksHasMore, true);
      assert.equal(second.blocks.length, 3);
      assert.equal(second.blocksHasMore, false);

      // CAL-04: Day + Night above Full day offers one-click alignment in the same change.
      const config = (await sql`SELECT booking_config FROM rentable WHERE id=${ids.listing}`)[0]
        .booking_config;
      const slot = (startTime, endTime, endDayOffset) => ({
        ...config.slots.day,
        startTime,
        endTime,
        endDayOffset,
      });
      await sql`UPDATE rentable SET booking_config=${JSON.stringify({ ...config, slots: { day: config.slots.day, night: slot('19:00', '08:00', 1), full_day: slot('09:00', '08:00', 1) } })}::text::jsonb WHERE id=${ids.listing}`;
      await sql`INSERT INTO rentable_price(rentable_id,slot,weekday_minor,weekend_minor) VALUES (${ids.listing},'night',120000,150000),(${ids.listing},'full_day',200000,250000)`;
      const change = {
        cells: [
          { date: day, slot: 'day' },
          { date: day, slot: 'night' },
        ],
        command: 'prices',
        rentMinor: 150000,
      };
      const input = {
        rentableId: ids.listing,
        change,
        expectedCalendarVersion: 'page',
        preview: true,
      };
      const warned = await changeCalendarCells(sql, ids.owner, input);
      assert.equal(warned.preview.result.warnings.length, 1);
      const aligned = { ...input, change: { ...change, alignFullDay: true } };
      const alignPreview = await changeCalendarCells(sql, ids.owner, aligned);
      const full = alignPreview.preview.result.affected.find((c) => c.slot === 'full_day');
      assert.equal(full.after, 300000);
      assert.equal(alignPreview.preview.result.warnings.length, 0);
      await changeCalendarCells(sql, ids.owner, {
        ...aligned,
        preview: false,
        previewToken: alignPreview.preview.token,
      });
      assert.equal(
        Number(
          (
            await sql`SELECT rent_minor FROM booking_price_override WHERE rentable_id=${ids.listing} AND day=${day} AND slot='full_day'`
          )[0].rent_minor,
        ),
        300000,
      );

      // CAL-02: one-time Today offer for existing properties, one click, then the daily worker job.
      const { ownerToday } = await import('../../src/services/auth/owner-today.js');
      await sql`UPDATE rentable SET status='live' WHERE id=${ids.listing}`;
      const offer = (await ownerToday(sql, ids.owner, 'needsYou')).tasks.find(
        (t) => t.key === `auto_open_offer:${ids.listing}`,
      );
      assert.equal(offer?.action, 'Turn on');
      await setAutoOpen(sql, ids.owner, { rentableId: ids.listing, enabled: true });
      assert.equal(
        (await ownerToday(sql, ids.owner, 'needsYou')).tasks.some((t) =>
          t.key.startsWith('auto_open_offer:'),
        ),
        false,
      );
      await assert.rejects(setAutoOpen(sql, ids.other, { rentableId: ids.listing, enabled: true }));
      const { createJobs } = await import('../../src/cron/jobs.js');
      const job = createJobs(sql).find((j) => j.name === 'auto-open-dates');
      assert.equal(job.intervalMs, 86400000);
      await sql`DELETE FROM availability WHERE rentable_id=${ids.listing} AND day>${today}::date+60`;
      const ran = await job.run();
      assert.ok(ran.properties >= 1);
      const [{ last }] =
        await sql`SELECT max(day)::text AS last FROM availability WHERE rentable_id=${ids.listing}`;
      assert.equal(last, addLocalDays(today, config.bookingHorizonDays));
    } finally {
      await f.drop();
    }
  },
);
