import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'saving a section of a live property without changes keeps it live; a real change sends it to review',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.SESSION_SECRET ??= 'owner-noop-save-disposable-secret-only';
      const f = await seedReviewFixture(sql);
      await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;
      await sql`UPDATE rentable SET status='live',bedrooms=3,farm_size=2,farm_size_unit='vigha' WHERE id=${f.listing}`;
      const { runWithContext } = await import('@/runtime/context.js');
      const { encryptSession } = await import('@/services/auth/session-crypto.js');
      const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
      const { saveBasics, saveCapacity, saveAmenities } = await import('@/services/auth/listings.js');
      const token = await encryptSession({
        role: 'client',
        userId: f.owner,
        sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
      });
      const asOwner = (action, values) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(values))
          for (const one of [value].flat()) form.append(key, String(one));
        return runWithContext({ req: { cookies: { rentra_session: token } } }, () => action(null, form));
      };
      const status = async () => (await sql`SELECT status FROM rentable WHERE id=${f.listing}`)[0].status;
      const [row] = await sql`SELECT * FROM rentable WHERE id=${f.listing}`;
      const amenityIds = (await sql`SELECT amenity_id FROM rentable_amenity WHERE rentable_id=${f.listing}`).map((r) => r.amenity_id);

      const basics = await asOwner(saveBasics, {
        id: f.listing,
        categoryId: row.category_id,
        title: row.title,
        description: `${row.description} Now with a mango orchard.`,
        highlight: '',
      });
      assert.equal(basics.ok, true);
      assert.equal(basics.sentBack, false, 'a description-only edit is not a trust edit');
      const capacity = await asOwner(saveCapacity, {
        id: f.listing,
        capacity: row.capacity,
        bedrooms: 3,
        farmSize: 2,
        farmSizeUnit: 'vigha',
      });
      assert.equal(capacity.sentBack, false);
      const amenities = await asOwner(saveAmenities, { id: f.listing, amenity: amenityIds });
      assert.equal(amenities.sentBack, false, 'the same amenity set is not a change');
      assert.equal(await status(), 'live');

      const grown = await asOwner(saveCapacity, {
        id: f.listing,
        capacity: row.capacity + 5,
        bedrooms: 3,
        farmSize: 2,
        farmSizeUnit: 'vigha',
      });
      assert.equal(grown.sentBack, true);
      assert.equal(await status(), 'pending_review');
    } finally {
      await fixture.drop();
    }
  },
);
