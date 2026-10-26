import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, makePublishable } from '../helpers/listing-review-fixture.js';

test(
  'Story 2.1 automatic publication: approval without a visit, identity and dates required, no bypass',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      Object.assign(process.env, { DATABASE_URL: fixture.url, NODE_ENV: 'test' });
      globalThis.__rentraSql = sql;
      const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
      const v = await import('@/services/admin/verification.js');
      const f = await seedReviewFixture(sql),
        id = f.listing;
      const status = async () => (await sql`SELECT status FROM rentable WHERE id=${id}`)[0].status;
      const decide = (submissionId, outcome = 'approved') =>
        decidePropertyReview(sql, {
          id,
          adminId: f.admin,
          input: { submissionId, outcome, reason: 'Evidence and listing checked' },
        });

      // Approved without a visit, but identity unapproved and no open dates: stays non-public.
      let { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
      assert.equal((await decide(submissionId)).status, 'pending_verification');
      let state = await v.publicationState(sql, id);
      assert.ok(state.blockers.includes('The owner identity is not approved.'));
      assert.ok(state.blockers.some((b) => /no open dates/.test(b)));
      assert.ok(!state.blockers.some((b) => /verification/.test(b)), 'no visit required');
      await assert.rejects(decide(submissionId), { code: 'SUBMISSION_CHANGED' });
      assert.equal(await v.autoPublishReady(sql), 0);
      assert.equal(await status(), 'pending_verification');

      // Identity approved alone is not enough; opening dates completes setup and the sweep publishes.
      await makePublishable(sql, f.owner, id, { openDates: false });
      assert.equal(await v.autoPublishReady(sql), 0);
      await makePublishable(sql, f.owner, id);
      assert.equal(await v.autoPublishReady(sql), 1);
      assert.equal(await v.autoPublishReady(sql), 0, 'publishes once');
      const [live] = await sql`SELECT status, verified_at, published_by, published_submission_id
        FROM rentable WHERE id=${id}`;
      assert.equal(live.status, 'live');
      assert.equal(live.verified_at, null, 'approval is not a completed verification');
      assert.equal(live.published_by, null);
      assert.equal(live.published_submission_id, submissionId);
      const [notice] = await sql`SELECT kind FROM client_update
        WHERE client_id=${f.owner} AND action='listing_published'`;
      assert.equal(notice.kind, 'info');
      const [entry] = await sql`SELECT actor_type, reason FROM audit_log
        WHERE action='listing_published' AND entity_id=${id}`;
      assert.equal(entry.actor_type, 'system');
      assert.ok(entry.reason);

      // A restriction is never bypassed: hidden or paused properties are not auto-published.
      await sql`UPDATE rentable SET status='hidden', prior_status='pending_verification' WHERE id=${id}`;
      assert.equal(await v.autoPublishProperty(sql, id), false);
      assert.equal(await status(), 'hidden');

      // Legacy "approve for verification" still requires a passed visit before publication.
      await sql`UPDATE rentable SET status='draft', content_version=content_version+1 WHERE id=${id}`;
      ({ submissionId } = await submitProperty(sql, { id, clientId: f.owner }));
      await decide(submissionId, 'approved_for_visit');
      state = await v.publicationState(sql, id);
      assert.deepEqual(state.blockers, [
        'No passed verification of this exact revision is recorded.',
      ]);
      assert.equal(await status(), 'pending_verification');

      // A visit the reviewer scheduled after approving holds publication until it finishes.
      await sql`UPDATE rentable SET status='draft', content_version=content_version+1 WHERE id=${id}`;
      ({ submissionId } = await submitProperty(sql, { id, clientId: f.owner }));
      await sql`UPDATE rentable SET status='pending_review' WHERE id=${id}`;
      await sql.begin(async (tx) => {
        await tx`INSERT INTO listing_review(rentable_id,pass_number,submission_id,outcome,reason,flagged_fields,reviewed_by)
          SELECT ${id}, pass_number, id, 'approved', 'ok', '[]'::jsonb, ${f.admin} FROM listing_submission WHERE id=${submissionId}`;
        await tx`UPDATE rentable SET status='pending_verification' WHERE id=${id}`;
        await tx`INSERT INTO verification_visit(rentable_id, submission_id, mode, scheduled_at)
          VALUES (${id}, ${submissionId}, 'video_call', now() + interval '1 day')`;
      });
      assert.ok(
        (await v.publicationState(sql, id)).blockers.includes(
          'A scheduled verification visit has not finished.',
        ),
      );
      assert.equal(await v.autoPublishReady(sql), 0);

      // When everything is already complete, approval publishes at once.
      await sql`UPDATE rentable SET status='draft', content_version=content_version+1 WHERE id=${id}`;
      ({ submissionId } = await submitProperty(sql, { id, clientId: f.owner }));
      assert.equal((await decide(submissionId)).status, 'live');
    } finally {
      await fixture.drop();
    }
  },
);
