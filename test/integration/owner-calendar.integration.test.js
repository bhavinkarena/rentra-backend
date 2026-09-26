import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  calendarCommand,
  ownerPortfolioCalendar,
} from '../../src/services/booking/owner-calendar.js';
import {
  createOwnerBlock,
  releaseOwnerBlock,
  withListingInventory,
  findInventoryConflicts,
} from '../../src/services/booking/inventory.js';
import {
  openBookingDates,
  saveBookingPriceOverride,
} from '../../src/services/booking/owner-settings.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

test(
  'CP10 portfolio, atomic previews, interval conflicts and stale confirmations',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const f = await seedReviewFixture(sql);
      const booked = await seedConfirmedBooking(sql, f.listing);
      const day = addLocalDays(propertyToday(), 5),
        next = addLocalDays(day, 1);
      await sql`UPDATE rentable SET booking_config='{"inventoryReady":true,"timeZone":"Asia/Kolkata","slots":{}}'::jsonb WHERE id=${f.listing}`;
      const [visit] =
        await sql`UPDATE booking SET hours_known=true,starts_at=${day + 'T21:00:00+05:30'},ends_at=${next + 'T08:00:00+05:30'},blocked_start_at=${day + 'T20:00:00+05:30'},blocked_end_at=${next + 'T09:00:00+05:30'} WHERE order_id=${booked.order} RETURNING *`;
      const [reservation] =
        await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${visit.id},'booking','committed',${visit.blocked_start_at},${visit.blocked_end_at}) RETURNING id`;
      const read = () => ownerPortfolioCalendar(sql, f.owner, { from: day });
      const page = await read();
      assert.equal(page.items[0].intervals[0].order_id, booked.order);
      assert.ok(!JSON.stringify(page).includes('customer_id'));
      assert.equal(
        (await ownerPortfolioCalendar(sql, f.other, { property: f.listing })).items.length,
        0,
      );
      await assert.rejects(ownerPortfolioCalendar(sql, f.owner, { days: 366 }), RangeError);
      const command = async (kind, values, run, extra = {}) =>
        calendarCommand(
          sql,
          f.owner,
          {
            rentableId: f.listing,
            expectedCalendarVersion: (await read()).items[0].version,
            command: kind,
            values,
            preview: true,
            ...extra,
          },
          run,
        );
      const dates = { rentableId: f.listing, from: day, to: next };
      const open = (db) => openBookingDates(db, f.owner, dates);
      const [{ count: beforeAudit }] = await sql`SELECT count(*) FROM audit_log`;
      const preview = await command('open', dates, open);
      assert.equal(preview.preview.affected.length, 4);
      assert.equal(preview.preview.result.added, 4);
      assert.equal(
        (await sql`SELECT * FROM availability WHERE rentable_id=${f.listing}`).length,
        0,
      );
      assert.equal((await sql`SELECT count(*) FROM audit_log`)[0].count, beforeAudit);
      await command('open', dates, open, { preview: false, previewToken: preview.preview.token });
      assert.equal(
        (await sql`SELECT * FROM availability WHERE rentable_id=${f.listing}`).length,
        4,
      );
      await assert.rejects(
        command('open', { ...dates, to: day }, open, {
          preview: false,
          previewToken: preview.preview.token,
        }),
        { code: 'PREVIEW_REQUIRED' },
      );
      const blocked = {
        rentableId: f.listing,
        blockedStartAt: next + 'T08:30:00+05:30',
        blockedEndAt: next + 'T10:00:00+05:30',
        reason: 'Maintenance',
      };
      await assert.rejects(
        command('block', blocked, (db) => createOwnerBlock(db, f.owner, blocked)),
        { code: 'INVENTORY_CONFLICT' },
      );
      await assert.rejects(
        releaseOwnerBlock(sql, f.owner, { rentableId: f.listing, blockId: reservation.id }),
        { code: 'NOT_FOUND' },
      );
      assert.equal(
        (await sql`SELECT state FROM inventory_reservation WHERE id=${reservation.id}`)[0].state,
        'committed',
      );
      const price = { rentableId: f.listing, day, slot: 'day', rentMinor: 150000 };
      const priceRun = (db) => saveBookingPriceOverride(db, f.owner, price);
      const version = (await read()).items[0].version;
      const pricePreview = await command('override', price, priceRun);
      await saveBookingPriceOverride(sql, f.owner, { ...price, rentMinor: 160000 });
      await assert.rejects(
        command('override', price, priceRun, {
          preview: false,
          previewToken: pricePreview.preview.token,
          expectedCalendarVersion: version,
        }),
        { code: 'CALENDAR_CHANGED' },
      );
      assert.equal(Number((await read()).items[0].overrides[0].rent_minor), 160000);
      const raceDay = addLocalDays(day, 2);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: raceDay, to: raceDay });
      const interval = {
        date: raceDay,
        slot: 'day',
        startsAt: raceDay + 'T09:00:00+05:30',
        endsAt: raceDay + 'T18:00:00+05:30',
        blockedStartAt: raceDay + 'T09:00:00+05:30',
        blockedEndAt: raceDay + 'T18:00:00+05:30',
      };
      const race = await Promise.allSettled([
        createOwnerBlock(sql, f.owner, { rentableId: f.listing, ...interval, reason: 'Owner use' }),
        withListingInventory(sql, f.listing, async (tx, listing) => {
          assert.equal((await findInventoryConflicts(tx, listing, [interval])).length, 0);
          const [b] =
            await tx`INSERT INTO booking(reference,rentable_id,customer_id,day,slot,amount_rent,amount_fee,state,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,units_booked)
          VALUES ('CP10-RACE',${f.listing},${booked.customer},${raceDay},'day',1000,80,'confirmed',${interval.startsAt},${interval.endsAt},${interval.blockedStartAt},${interval.blockedEndAt},true,1) RETURNING id`;
          await tx`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${b.id},'booking','committed',${interval.blockedStartAt},${interval.blockedEndAt})`;
        }),
      ]);
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'one last-space winner');
      await sql`UPDATE inventory_reservation SET state='held',hold_expires_at=now()+interval '1 minute' WHERE id=${reservation.id}`;
      assert.equal(
        (await read()).items[0].intervals.find((r) => r.id === reservation.id).state,
        'held',
      );
      await sql`UPDATE inventory_reservation SET hold_expires_at=now()-interval '1 minute' WHERE id=${reservation.id}`;
      await sql`UPDATE booking_order SET state='held',hold_expires_at=now()-interval '1 minute' WHERE id=${booked.order}`;
      await sql`UPDATE booking SET state='requested' WHERE id=${visit.id}`;
      assert.ok(!(await read()).items[0].intervals.some((r) => r.id === reservation.id));
      const free = await createOwnerBlock(sql, f.owner, blocked);
      assert.equal(free.state, 'committed');
      assert.equal(
        (await sql`SELECT state FROM inventory_reservation WHERE id=${reservation.id}`)[0].state,
        'expired',
      );
      const v = (await read()).items[0].version;
      const release = (db) =>
        releaseOwnerBlock(db, f.owner, { rentableId: f.listing, blockId: free.id });
      const releasePreview = await command('unblock', { blockId: free.id }, release);
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          command('unblock', { blockId: free.id }, release, {
            preview: false,
            previewToken: releasePreview.preview.token,
            expectedCalendarVersion: v,
          }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      await sql`UPDATE availability SET blocked_by_client=true,units_available=0 WHERE rentable_id=${f.listing} AND day=${day} AND slot='day'`;
      const preserve = await command('open', dates, open);
      assert.equal(preserve.preview.result.added, 0);
      await command('open', dates, open, { preview: false, previewToken: preserve.preview.token });
      assert.equal(
        (
          await sql`SELECT blocked_by_client FROM availability WHERE rentable_id=${f.listing} AND day=${day} AND slot='day'`
        )[0].blocked_by_client,
        true,
      );
    } finally {
      await fixture.drop();
    }
  },
);
