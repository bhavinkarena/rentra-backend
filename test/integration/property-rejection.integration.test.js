import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Story 1.8 direct rejection: reason, from/to history, same-listing resubmission, replay and scoping',
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
      const REASON = 'This property is outside the areas Rentra serves.';
      const first = await submitProperty(sql, { id, clientId: f.owner });
      const reject = (submissionId, reason = REASON) =>
        decidePropertyReview(sql, {
          id,
          adminId: f.admin,
          input: { submissionId, outcome: 'rejected', reason },
        });

      // A reason is required; no correction cycle is needed first.
      await assert.rejects(reject(first.submissionId, 'no'), { statusCode: 422 });
      await reject(first.submissionId);
      const [row] = await sql`SELECT status, rejection_reason FROM rentable WHERE id=${id}`;
      assert.deepEqual({ ...row }, { status: 'rejected', rejection_reason: REASON });
      const [entry] = await sql`SELECT actor_id, at, after FROM audit_log
        WHERE action='listing_review_decided' AND entity_id=${id}`;
      assert.equal(entry.actor_id, f.admin);
      assert.ok(entry.at);
      assert.equal(entry.after.from, 'pending_review');
      assert.equal(entry.after.status, 'rejected');

      // Repeats and stale decisions cannot produce a conflicting outcome.
      await assert.rejects(reject(first.submissionId), { code: 'SUBMISSION_CHANGED' });
      await assert.rejects(
        decidePropertyReview(sql, {
          id,
          adminId: f.admin,
          input: {
            submissionId: first.submissionId,
            outcome: 'approved_for_visit',
            reason: 'ok now',
          },
        }),
        { code: 'SUBMISSION_CHANGED' },
      );

      // The owner sees the outcome and reason, never internal identity.
      const read = async (clientId) => {
        let body, error;
        await detail(
          { params: { id }, user: { id: clientId } },
          { success: (_s, d) => (body = d) },
          (e) => (error = e),
        );
        return { body, error };
      };
      const own = await read(f.owner);
      assert.equal(own.body.listing.reviewOutcome, 'rejected');
      assert.ok(JSON.stringify(own.body).includes(REASON));
      assert.ok(!JSON.stringify(own.body).includes(f.admin));
      assert.equal((await read(f.other)).error?.statusCode, 404);

      // Corrected and explicitly resubmitted: same listing, history kept, review resumes, nothing published.
      await sql`UPDATE rentable SET content_version=content_version+1 WHERE id=${id}`;
      const second = await submitProperty(sql, { id, clientId: f.owner });
      const [after] = await sql`SELECT id, status, published_at FROM rentable WHERE id=${id}`;
      assert.equal(after.id, id);
      assert.equal(after.status, 'pending_review');
      assert.equal(after.published_at, null);
      assert.equal(second.pass, 2);
      const history =
        await sql`SELECT pass_number, outcome FROM listing_review WHERE rentable_id=${id}`;
      assert.deepEqual(
        history.map((h) => ({ ...h })),
        [{ pass_number: 1, outcome: 'rejected' }],
      );
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM listing_submission WHERE rentable_id=${id}`)[0].n,
        2,
      );
    } finally {
      await fixture.drop();
    }
  },
);
