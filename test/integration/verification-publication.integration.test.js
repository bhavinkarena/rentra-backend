import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

const future = (days, time = '11:00') => {
  const date = new Date(Date.now() + days * 86400000 + 5.5 * 3600000);
  return `${date.toISOString().slice(0, 10)}T${time}`;
};
const ALL = [
  'ownerIdentity',
  'matchesPhotos',
  'amenitiesPresent',
  'locationMatches',
  'ownershipOriginal',
  'safeForGuests',
];
const FINDINGS = 'Walked the property with the owner; photos, pool and access road match.';

test(
  'CP07 verification scheduling, evidence rules and revision-exact publication',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const f = await seedReviewFixture(sql);
      const id = f.listing;
      const { submitProperty, decidePropertyReview, readPropertyReview, propertyReviewContext } =
        await import('@/services/admin/listings.js');
      const v = await import('@/services/admin/verification.js');
      const { getListingByCode } = await import('@/services/db/queries.js');

      const approve = async () => {
        const { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
        await decidePropertyReview(sql, {
          id,
          adminId: f.admin,
          input: { submissionId, outcome: 'approved_for_visit', reason: 'Ready for verification' },
        });
        return submissionId;
      };
      const schedule = (submissionId, mode = 'video_call', at = future(3)) =>
        v.scheduleVerification(sql, {
          adminId: f.admin,
          id,
          input: { submissionId, mode, scheduledAt: at },
        });
      const record = (visitId, expectedVersion, outcome, extra = {}) =>
        v.recordVerificationOutcome(sql, {
          adminId: f.admin,
          id,
          visitId,
          input: { expectedVersion, outcome, findings: FINDINGS, checklist: ALL, ...extra },
        });
      const publish = (submissionId) =>
        v.publishProperty(sql, { adminId: f.admin, id, input: { submissionId } });

      // 1. Approved for verification is not publishable without evidence.
      let submission = await approve();
      let state = await v.publicationState(sql, id);
      assert.equal(state.eligible, false);
      assert.ok(state.blockers.some((b) => /No passed verification/.test(b)));
      await assert.rejects(publish(submission), { statusCode: 409, code: 'PUBLICATION_BLOCKED' });

      // 2. Scheduling rules.
      await assert.rejects(
        schedule(submission, 'video_call', '2020-01-01T10:00'),
        (e) => e.statusCode === 422 && Boolean(e.fields.scheduledAt),
      );
      const first = await schedule(submission);
      await assert.rejects(schedule(submission), { code: 'VERIFICATION_ALREADY_SCHEDULED' });
      assert.equal((await propertyReviewContext(sql, id)).verification.mode, 'video_call');
      await assert.rejects(
        v.rescheduleVerification(sql, {
          adminId: f.admin,
          id,
          visitId: first.visitId,
          input: { expectedVersion: 9, scheduledAt: future(4), reason: 'Owner travelling' },
        }),
        { code: 'VERIFICATION_CHANGED' },
      );
      const moved = await v.rescheduleVerification(sql, {
        adminId: f.admin,
        id,
        visitId: first.visitId,
        input: { expectedVersion: 1, scheduledAt: future(4), reason: 'Owner travelling' },
      });
      assert.equal(moved.version, 2);

      // 3. Failed verification returns the property to the client with the findings.
      const failed = await record(first.visitId, 2, 'failed', { checklist: [] });
      assert.equal(failed.status, 'draft');
      let detail = await readPropertyReview(sql, id);
      assert.equal(detail.property.status, 'draft');

      // 4. No-show closes the visit and keeps the property waiting.
      submission = await approve();
      const missed = await schedule(submission);
      await record(missed.visitId, 1, 'no_show', { findings: '', checklist: [] });
      assert.equal((await readPropertyReview(sql, id)).property.status, 'pending_verification');

      // 5. Insufficient evidence cannot pass; video with full evidence passes.
      const video = await schedule(submission);
      await assert.rejects(record(video.visitId, 1, 'passed', { checklist: ALL.slice(1) }), {
        statusCode: 422,
      });
      await assert.rejects(record(video.visitId, 1, 'passed', { findings: 'short' }), {
        statusCode: 422,
      });
      await record(video.visitId, 1, 'passed');
      state = await v.publicationState(sql, id);
      assert.equal(state.eligible, true);
      assert.equal(state.inventory.bookable, false, 'no confirmed schedule yet');

      // 6. A content change after a passed verification blocks publication.
      await sql`UPDATE rentable SET title='Review River Farm Renamed' WHERE id=${id}`;
      await assert.rejects(publish(submission), { statusCode: 409 });
      assert.equal((await readPropertyReview(sql, id)).property.status, 'pending_review');

      // 7. The new revision needs its own verification; an open visit for the old one is superseded.
      submission = await approve();
      assert.ok(
        (await v.publicationState(sql, id)).blockers.some((b) => /No passed verification/.test(b)),
      );
      const physical = await schedule(submission, 'physical');
      await sql`UPDATE rentable SET capacity=13 WHERE id=${id}`;
      submission = await approve();
      const replacement = await schedule(submission, 'physical');
      const [superseded] =
        await sql`SELECT cancel_reason FROM verification_visit WHERE id=${physical.visitId}`;
      assert.match(superseded.cancel_reason, /Superseded/);
      await assert.rejects(record(replacement.visitId, 1, 'passed'), (e) =>
        Boolean(e.fields?.geoLat),
      );

      // 8. Restricted clients cannot be verified or published.
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${f.owner}`;
      assert.ok((await v.publicationState(sql, id)).blockers.some((b) => /client account/.test(b)));
      await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;
      await record(replacement.visitId, 1, 'passed', { geoLat: 21.17, geoLng: 72.83 });

      // 9. Publish exactly once; the published revision is attributed and not marked stale.
      const [before] = await sql`SELECT content_version FROM rentable WHERE id=${id}`;
      const race = await Promise.allSettled([publish(submission), publish(submission)]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      const [live] =
        await sql`SELECT status, content_version, published_submission_id, published_by,
          verified_at, approved_snapshot->'listing'->>'title' AS title FROM rentable WHERE id=${id}`;
      assert.equal(live.status, 'live');
      assert.equal(
        live.content_version,
        before.content_version,
        'publication is not a content edit',
      );
      assert.equal(live.published_submission_id, submission);
      assert.equal(live.published_by, f.admin);
      assert.ok(live.verified_at);
      assert.equal(live.title, 'Review River Farm Renamed');
      assert.equal(
        (await sql`SELECT id FROM audit_log WHERE action='listing_published'`).length,
        1,
      );

      // 10. Public read shows the property and the physical badge, never the evidence.
      const publicListing = await getListingByCode('review01');
      assert.ok(publicListing);
      assert.equal(publicListing.physicallyVerified, true);
      const text = JSON.stringify(publicListing);
      for (const secret of ['12 Private Lane', '21.17', FINDINGS, 'ownerIdentity'])
        assert.equal(text.includes(secret), false, `public read leaks ${secret}`);
      assert.equal((await propertyReviewContext(sql, id)).verification, null);
      detail = await readPropertyReview(sql, id);
      assert.equal(detail.publication.blockers[0], 'Already published.');
      assert.equal(detail.verifications.filter((x) => x.outcome === 'passed').length, 2);
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
