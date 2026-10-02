import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import {
  seedReviewFixture,
  seedConfirmedBooking,
  seedBusyOwnerVisits,
} from '../helpers/listing-review-fixture.js';

test(
  'Today shares owner-scoped visit counts, overnight boundaries and action queues with Bookings',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const { ownerToday, bookedRent } = await import('../../src/services/auth/owner-today.js');
      const { listBookingRecords } = await import('../../src/services/booking/records.js');
      const [date] =
        await sql`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date`;
      await sql`UPDATE booking SET starts_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '9 hours',ends_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '18 hours',local_day=${date.date},blocked_start_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '9 hours',blocked_end_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '18 hours',hours_known=true WHERE order_id=${booked.order}`;
      await sql`UPDATE booking_order SET listing_snapshot=jsonb_set(listing_snapshot,'{contact}','{"name":"Guest Test","phone":"9876543210"}'::jsonb) WHERE id=${booked.order}`;
      const first = await ownerToday(sql, f.owner, 'visits');
      assert.equal(first.total, 1);
      assert.equal(first.arrivalCount, 1);
      assert.equal(first.departureCount, 1);
      assert.equal(first.arrivals[0].contact.name, 'Guest');
      assert.equal((await ownerToday(sql, f.other, 'visits')).total, 0);
      // A second visit of the same order crosses midnight into today.
      await sql`INSERT INTO booking(reference,rentable_id,customer_id,slot,state,starts_at,ends_at,order_id,item_position,local_day,currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor,blocked_start_at,blocked_end_at,hours_known)
      SELECT 'TODAY-NIGHT',rentable_id,customer_id,'night','handed_over',(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')-interval '5 hours',(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '10 hours',order_id,2,${date.date}::date-1,currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor,(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')-interval '5 hours',(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '10 hours',true FROM booking WHERE order_id=${booked.order} LIMIT 1`;
      const overnight = await ownerToday(sql, f.owner, 'visits');
      assert.equal(overnight.total, 2);
      assert.equal(overnight.arrivalCount, 1);
      assert.equal(overnight.departureCount, 2);
      const records = await listBookingRecords(
        sql,
        { kind: 'owner', id: f.owner },
        { tab: 'today' },
      );
      assert.equal(records.total, overnight.total);
      assert.equal(records.items.length, 2);
      assert.notEqual(records.items[0].visitId, records.items[1].visitId);
      const week = await ownerToday(sql, f.owner, 'week');
      assert.equal(week.length, 7);
      assert.equal(week[0].count, 2);
      await seedBusyOwnerVisits(sql, booked.order, 3, 40);
      const busy = await ownerToday(sql, f.owner, 'visits');
      assert.equal(busy.total, 40);
      assert.equal(busy.arrivals.length, 5);
      const page2 = await listBookingRecords(
        sql,
        { kind: 'owner', id: f.owner },
        { tab: 'today', page: 2 },
      );
      assert.equal(page2.total, 40);
      assert.equal(page2.items.length, 20);
      await sql`UPDATE booking SET state='disputed' WHERE rentable_id=${f.listing}`;
      const actions = await listBookingRecords(
        sql,
        { kind: 'owner', id: f.owner },
        { tab: 'action_needed' },
      );
      assert.equal(actions.total, 0);
      assert.equal(actions.summary.with_rentra, 39);
      assert.equal(
        (await listBookingRecords(sql, { kind: 'owner', id: f.owner }, { tab: 'with_rentra' }))
          .total,
        39,
      );
      assert.equal(
        bookedRent([
          { bookingId: 'a', component: 'fee', quoteRentMinor: '100' },
          { bookingId: 'a', component: 'deposit', quoteRentMinor: '100' },
          { bookingId: 'a', component: 'rent', quoteRentMinor: '100' },
          { bookingId: 'a', component: 'rent', quoteRentMinor: '100' },
        ]),
        '100',
      );
      const properties = await ownerToday(sql, f.owner, 'properties');
      assert.equal(properties.length, 1);
      assert.ok(properties[0].strength >= 0);
      const needs = await ownerToday(sql, f.owner, 'needsYou');
      assert.ok(needs.tasks.some((t) => t.key === 'visits_with_rentra' && t.count === 39));
      await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${f.other}`;
      await assert.rejects(
        ownerToday(sql, f.other, 'visits'),
        (e) => e.statusCode === 403 || e.status === 403,
      );
    } finally {
      await fixture.drop();
    }
  },
);
