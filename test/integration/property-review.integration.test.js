import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import {
  submitProperty,
  listPropertyReviews,
  readPropertyReview,
  propertyReviewContext,
  assignPropertyReview,
  decidePropertyReview,
} from '@/services/admin/listings.js';

test(
  'CP06 immutable property submissions, scoped corrections, stale decisions and reviewer races',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      const f = await seedReviewFixture(sql),
        id = f.listing;
      const submit = (clientId) => submitProperty(sql, { id, clientId });
      const decide = (
        submissionId,
        outcome = 'approved_for_visit',
        adminId = f.admin,
        flagged = [],
      ) =>
        decidePropertyReview(sql, {
          id,
          adminId,
          input: {
            submissionId,
            outcome,
            reason: 'Reviewed the submitted property evidence',
            flagged,
          },
        });
      await assert.rejects(submit(f.other), { statusCode: 404 });
      const first = await submit(f.owner);
      await assert.rejects(submit(f.owner), { code: 'ALREADY_SUBMITTED' });
      assert.equal((await listPropertyReviews(sql, f.admin, {})).total, 1);
      assert.equal((await listPropertyReviews(sql, f.admin, { q: '%' })).total, 0);
      for (const status of ['all', 'draft', 'rejected', 'pending_verification'])
        await listPropertyReviews(sql, f.admin, { status });
      assert.equal((await listPropertyReviews(sql, f.admin, { status: 'all' })).total, 1);
      assert.equal((await listPropertyReviews(sql, f.admin, { assignee: 'unassigned' })).total, 1);
      const initial = await readPropertyReview(sql, id);
      assert.equal(initial.readiness.remaining.length, 0);
      assert.equal(initial.current.snapshot.listing.title, 'Review River Farm');
      assert.equal(initial.current.snapshot.documents[0].storageKey, undefined);
      await assert.rejects(
        sql`UPDATE listing_submission SET snapshot='{}' WHERE id=${first.submissionId}`,
      );
      await assert.rejects(sql`DELETE FROM listing_submission WHERE id=${first.submissionId}`);
      await assignPropertyReview(sql, {
        id,
        adminId: f.admin,
        submissionId: first.submissionId,
        action: 'claim',
      });
      await assert.rejects(decide(first.submissionId, 'rejected', f.second), {
        code: 'ASSIGNED_ELSEWHERE',
      });
      assert.equal((await listPropertyReviews(sql, f.admin, { assignee: 'me' })).total, 1);
      await assert.rejects(decide(first.submissionId, 'changes_requested'), { statusCode: 422 });
      await decide(first.submissionId, 'changes_requested', f.admin, ['rules', 'photos']);
      let detail = await readPropertyReview(sql, id);
      assert.equal(detail.property.status, 'draft');
      assert.deepEqual(detail.history[0].flaggedFields, ['rules', 'photos']);
      await sql`UPDATE rentable SET title='Updated River Farm' WHERE id=${id}`;
      const second = await submit(f.owner);
      await assert.rejects(decide(first.submissionId), { code: 'SUBMISSION_CHANGED' });
      // Child edits invalidate review, even when no property editor update follows.
      await sql`UPDATE rentable_price SET weekday=1200 WHERE rentable_id=${id}`;
      assert.equal((await propertyReviewContext(sql, id)).needsResubmission, true);
      await assert.rejects(decide(second.submissionId), { code: 'SUBMISSION_CHANGED' });
      const third = await submit(f.owner);
      const outcomes = await Promise.allSettled([
        decide(third.submissionId),
        decide(third.submissionId, 'rejected'),
      ]);
      assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(
        (await sql`SELECT id FROM listing_review WHERE submission_id=${third.submissionId}`).length,
        1,
      );
      assert.equal(
        (
          await sql`SELECT id FROM audit_log WHERE action='listing_review_decided' AND after->>'submissionId'=${third.submissionId}`
        ).length,
        1,
      );
      assert.equal(
        (await readPropertyReview(sql, id)).submissions.find((s) => s.id === first.submissionId)
          .snapshot.listing.title,
        'Review River Farm',
      );
      // No CP06 command can publish.
      await assert.rejects(decide(third.submissionId, 'published'), { statusCode: 422 });
      assert.notEqual((await readPropertyReview(sql, id)).property.status, 'live');
      // A content edit after approval requires a new review, including private evidence changes.
      await sql`UPDATE rentable SET status='pending_verification' WHERE id=${id}`;
      await sql`UPDATE document SET status='rejected' WHERE id=${f.document}`;
      assert.equal((await propertyReviewContext(sql, id)).needsResubmission, true);
      await assert.rejects(submit(f.owner), { statusCode: 422 });
      await sql`UPDATE document SET status='uploaded' WHERE id=${f.document}`;
      const fourth = await submit(f.owner);
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${f.owner}`;
      await assert.rejects(decide(fourth.submissionId), { code: 'CLIENT_NOT_ACTIVE' });
      await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;
      // Edit and decision share the same parent lock: changed content can never remain approved.
      await Promise.allSettled([
        decide(fourth.submissionId),
        sql`UPDATE rentable SET capacity=14 WHERE id=${id}`,
      ]);
      detail = await readPropertyReview(sql, id);
      assert.equal(detail.property.status, 'pending_review');
      assert.equal(detail.stale, true);
    } finally {
      await fixture.drop();
    }
  },
);
