import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { listBookingRecords } from '../../src/services/booking/records.js';
import { propertyToday } from '../../src/services/domain/booking-dates.js';

test(
  'admin records expose owner, protected guest identity and visit range in order and today scopes',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql);
      const booking = await seedConfirmedBooking(sql, f.listing);
      await sql`UPDATE booking_order SET listing_snapshot=listing_snapshot || '{"contact":{"name":"Fixture Guest","phone":"secret-phone"}}'::jsonb WHERE id=${booking.order}`;
      const actor = { kind: 'admin', id: f.admin };
      const records = await listBookingRecords(sql, actor);
      const item = records.items.find((row) => row.id === booking.order);
      assert.equal(item.owner.name, 'Property Owner');
      assert.equal(item.guestName, 'Fixture Guest');
      assert.equal(item.lastVisit, item.firstVisit);
      assert.equal(item.contact, undefined);
      await sql`UPDATE booking SET local_day=${propertyToday()}::date,starts_at=now(),ends_at=now()+interval '1 hour',blocked_start_at=now(),blocked_end_at=now()+interval '1 hour',hours_known=true WHERE order_id=${booking.order}`;
      const today = await listBookingRecords(sql, actor, { tab: 'today', unit: 'visits' });
      assert.equal(today.items[0].owner.id, f.owner);
      assert.equal(today.items[0].guestName, 'Fixture Guest');
      assert.equal(today.items[0].lastVisit, propertyToday());
      await sql`UPDATE booking SET state='cancelled' WHERE order_id=${booking.order}`;
      const closed = await listBookingRecords(sql, actor);
      assert.equal(closed.items[0].guestName, null);
      assert.equal(closed.items[0].guestWithheld, true);
      const owner = await listBookingRecords(sql, { kind: 'owner', id: f.owner });
      assert.equal(owner.items[0].owner, undefined);
      assert.equal(owner.items[0].guestName, undefined);
    } finally {
      await fixture.drop();
    }
  },
);
