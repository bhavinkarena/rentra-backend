import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Story 1.5 correction requests: itemized, revision-bound, durable notice, replay-safe, owner-safe view',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      Object.assign(process.env, { DATABASE_URL: fixture.url, NODE_ENV: 'test' });
      globalThis.__rentraSql = sql;
      const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
      const { detail } = await import('@/controllers/listings.controller.js');
      const f = await seedReviewFixture(sql),
        id = f.listing;
      const REASON = 'Add a clear photo of the pool and correct the map pin.';
      const { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
      const decide = (input) =>
        decidePropertyReview(sql, {
          id,
          adminId: f.admin,
          input: { submissionId, outcome: 'changes_requested', reason: REASON, ...input },
        });

      // Itemized: at least one section is required.
      await assert.rejects(decide({ flagged: [] }), (e) => Boolean(e.fields?.flagged));
      await decide({ flagged: ['photos', 'location'] });

      // Durable portal request plus a tracked email intent, from one logical decision.
      const updates = await sql`SELECT id, kind, detail FROM client_update
        WHERE client_id=${f.owner} AND action='listing_review_decided'`;
      assert.equal(updates.length, 1);
      assert.equal(updates[0].kind, 'action');
      assert.equal(updates[0].detail.reason, REASON);
      const emails = await sql`SELECT id FROM owner_notification
        WHERE user_id=${f.owner} AND channel='email' AND event_key=${'audit:' + (await sql`SELECT id FROM audit_log WHERE action='listing_review_decided'`)[0].id}`;
      assert.equal(emails.length, 1);

      // Email failure never erases the portal request.
      await sql`UPDATE owner_notification SET state='failed' WHERE id=${emails[0].id}`;
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM client_update WHERE id=${updates[0].id}`)[0].n,
        1,
      );

      // Repeat clicks and stale versions create no second logical request.
      await assert.rejects(decide({ flagged: ['photos'] }), { code: 'SUBMISSION_CHANGED' });
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM listing_review WHERE rentable_id=${id}`)[0].n,
        1,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int AS n FROM client_update WHERE client_id=${f.owner} AND action='listing_review_decided'`
        )[0].n,
        1,
      );

      // The owner sees actionable items and the reason, never who reviewed it.
      const read = async (clientId) => {
        let body, error;
        await detail(
          { params: { id }, user: { id: clientId } },
          {
            success: (_status, data) => (body = data),
          },
          (e) => (error = e),
        );
        return { body, error };
      };
      const own = await read(f.owner);
      assert.ok(own.body, own.error?.message);
      assert.deepEqual(own.body.listing.reviewFlags.map((flag) => flag.section).sort(), [
        'location',
        'photos',
      ]);
      assert.equal(own.body.listing.reviewOutcome, 'changes_requested');
      const text = JSON.stringify(own.body);
      assert.ok(text.includes(REASON));
      assert.ok(!text.includes('reviewer@fixture.invalid'), 'reviewer email stays internal');
      assert.ok(!text.includes(f.admin), 'reviewer id stays internal');
      assert.ok(own.body.reviews.every((r) => !('reviewedBy' in r)));
      assert.equal('assignee' in own.body.review, false);

      // Another owner gets nothing.
      const other = await read(f.other);
      assert.equal(other.body, undefined);
      assert.equal(other.error?.statusCode, 404);
    } finally {
      await fixture.drop();
    }
  },
);
