import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { insertFixtureOrder } from '../helpers/fixture-order.js';
import { listBookingRecords } from '../../src/services/booking/records.js';

test(
  'owner booking lists hide unpaid checkouts and show the most relevant visit first',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql);
      await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;
      const [customer] =
        await sql`INSERT INTO "user"(phone,role,account_status) VALUES ('9000022222','customer','active') RETURNING id`;
      const visit = async (title, days, { state = 'confirmed', order = 'confirmed' } = {}) => {
        const id = await insertFixtureOrder(sql, {
          customerId: customer.id,
          rentableId: f.listing,
          state: order,
          title,
        });
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,
            currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
          VALUES (${`V-${title}`},${f.listing},${customer.id},${id},1,(now() + ${days} * interval '1 day')::date,'day',${state},
            now() + ${days} * interval '1 day', now() + ${days} * interval '1 day' + interval '8 hours','INR','Asia/Kolkata',100000,8000,0)`;
      };
      // Created out of date order, so creation time can't fake the sort.
      await visit('recent', -3, { state: 'completed' });
      await visit('old', -400, { state: 'completed' });
      await visit('later', 20);
      await visit('soon', 2);
      const abandoned = await insertFixtureOrder(sql, {
        customerId: customer.id,
        rentableId: f.listing,
        title: 'abandoned',
      });
      await sql`UPDATE booking_order SET state='held',hold_expires_at=now()-interval '1 day' WHERE id=${abandoned}`;

      const owner = { kind: 'owner', id: f.owner };
      const titles = async (tab) =>
        (await listBookingRecords(sql, owner, { tab })).items.map((o) => o.title);
      assert.deepEqual(await titles('past'), ['recent', 'old'], 'past: newest first');
      assert.deepEqual(await titles('upcoming'), ['soon', 'later'], 'upcoming: next first');
      assert.deepEqual(
        await titles('all'),
        ['soon', 'later', 'recent', 'old'],
        'all: upcoming, then newest past',
      );
      assert.ok(
        !(await titles('cancelled')).includes('abandoned'),
        'an unpaid checkout is not a booking',
      );
    } finally {
      await fixture.drop();
    }
  },
);
