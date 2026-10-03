import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { ownerSearch, ownerSearchQuery } from '../../src/services/auth/owner-search.js';
import { canAccessRoute } from '../../src/services/auth/capabilities.js';

test(
  'owner search validates filters, scopes records, treats wildcards literally and paginates',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      const result = await ownerSearch(sql, f.owner, { q: 'Review River' });
      assert.equal(result.total, 2);
      assert.deepEqual(
        new Set(result.items.map((row) => row.type)),
        new Set(['property', 'booking']),
      );
      assert.equal((await ownerSearch(sql, f.other, { q: 'Review River' })).total, 0);
      assert.equal((await ownerSearch(sql, f.owner, { q: booking.order })).total, 0);
      const [order] = await sql`SELECT reference FROM booking_order WHERE id=${booking.order}`;
      const reference = await ownerSearch(sql, f.owner, { q: order.reference, type: 'booking' });
      assert.equal(reference.items[0].id, booking.order);
      assert.equal(reference.items[0].href, `/partner/bookings?booking=${booking.order}`);
      assert.equal('contact' in reference.items[0], false);
      await assert.rejects(ownerSearch(sql, booking.customer, { q: 'River' }));
      await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${f.other}`;
      await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code) SELECT ${f.other},'applicant-search','Applicant River Draft',category_id,city_id,area_id,'appsrc01' FROM rentable WHERE id=${f.listing}`;
      const pending = await ownerSearch(sql, f.other, { q: 'River' });
      assert.equal(pending.total, 1);
      assert.equal(pending.items[0].type, 'property');
      assert.ok(pending.items[0].href.endsWith('/setup'));
      for (let i = 0; i < 23; i++)
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code) SELECT ${f.owner},${'search-' + randomUUID()},${'Literal%_ ' + i},category_id,city_id,area_id,${'src' + String(i).padStart(5, '0')} FROM rentable WHERE id=${f.listing}`;
      const first = await ownerSearch(sql, f.owner, { q: '%_' }),
        second = await ownerSearch(sql, f.owner, { q: '%_', page: 2 });
      assert.equal(first.total, 23);
      assert.equal(first.items.length, 20);
      assert.equal(second.items.length, 3);
      assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 23);
      assert.ok(first.items.every((row) => row.title.includes('%_')));
      assert.ok(
        canAccessRoute(
          { role: 'client', accountStatus: 'pending_application' },
          'client',
          'GET',
          '/search',
        ),
      );
      assert.equal(
        canAccessRoute({ role: 'customer', accountStatus: 'active' }, 'client', 'GET', '/search'),
        false,
      );
      assert.equal(ownerSearchQuery.safeParse({ q: '' }).success, false);
      assert.equal(ownerSearchQuery.safeParse({ q: 'a'.repeat(101) }).success, false);
      assert.equal(ownerSearchQuery.safeParse({ q: 'River', page: 0 }).success, false);
    } finally {
      await db.drop();
    }
  },
);
