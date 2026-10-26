import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Story 1.3 property video evidence: request, private upload, explicit response, history and access',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      Object.assign(process.env, {
        DATABASE_URL: fixture.url,
        NODE_ENV: 'test',
        EVIDENCE_VIDEO_UPLOADS: 'true',
      });
      globalThis.__rentraSql = sql;
      const { memoryVideoStore } = await import('../../src/services/uploads/video-store.js');
      const store = memoryVideoStore();
      globalThis.__rentraVideoStore = store;
      const { submitProperty, readPropertyReview } = await import('@/services/admin/listings.js');
      const evidence = await import('@/services/admin/evidence-requests.js');
      const f = await seedReviewFixture(sql),
        id = f.listing;
      const { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
      const reason = 'Show the pool area and the boundary wall facing the road.';
      const ask = (input = { submissionId, reason }) =>
        evidence.requestVideo(sql, { id, adminId: f.admin, input });
      const rentableState = () =>
        sql`SELECT status,content_version,review_pass FROM rentable WHERE id=${id}`;
      const before = await rentableState();

      // Validation, release gate and stale scope.
      await assert.rejects(ask({ submissionId, reason: 'short' }), { statusCode: 422 });
      store.configured = () => false;
      await assert.rejects(ask(), { code: 'VIDEO_EVIDENCE_DISABLED' });
      store.configured = () => true;
      await assert.rejects(ask({ submissionId: f.owner, reason }), { code: 'SUBMISSION_CHANGED' });

      // One logical request and one owner update, however often it is replayed.
      const first = await ask();
      const again = await ask();
      assert.equal(again.requestId, first.requestId);
      assert.equal(again.replayed, true);
      const requestId = first.requestId;
      const updates =
        await sql`SELECT kind,action FROM client_update WHERE client_id=${f.owner} AND event_key=${'evidence_request:' + requestId}`;
      assert.deepEqual(
        updates.map((u) => ({ ...u })),
        [{ kind: 'action', action: 'evidence_requested' }],
      );
      assert.ok(
        (
          await sql`SELECT 1 FROM owner_notification WHERE user_id=${f.owner} AND channel='email' AND event_key=${'evidence_request:' + requestId}`
        ).length,
        'email notice queued',
      );
      assert.deepEqual(await rentableState(), before, 'requesting video changes no review state');

      // Ownership.
      const owner = { clientId: f.owner, id, requestId };
      await assert.rejects(evidence.ownerEvidenceRequests(sql, { clientId: f.other, id }), {
        statusCode: 404,
      });
      await assert.rejects(evidence.signVideoUpload(sql, { ...owner, clientId: f.other }), {
        statusCode: 404,
      });
      const view = await evidence.ownerEvidenceRequests(sql, { clientId: f.owner, id });
      assert.equal(view.requests[0].state, 'requested');
      assert.equal(view.limits.maxBytes, 52428800);
      assert.equal(JSON.stringify(view).includes('property-evidence/'), false);

      // Oversized and wrong-container uploads are destroyed and leave the request open.
      for (const meta of [
        { format: 'mp4', bytes: 60 * 1024 * 1024 },
        { format: 'avi', bytes: 1000 },
      ]) {
        const { publicId } = await evidence.signVideoUpload(sql, owner);
        store.files.set(publicId, meta);
        await assert.rejects(evidence.confirmVideoUpload(sql, { ...owner, publicId }), {
          statusCode: 422,
        });
        assert.ok(store.removed.includes(publicId));
        const [row] =
          await sql`SELECT pending_public_id FROM property_evidence_request WHERE id=${requestId}`;
        assert.equal(row.pending_public_id, null, 'a destroyed upload is not left pending');
      }
      // An upload that never reached storage is a recoverable error.
      const lost = await evidence.signVideoUpload(sql, owner);
      await assert.rejects(
        evidence.confirmVideoUpload(sql, { ...owner, publicId: lost.publicId }),
        {
          statusCode: 422,
        },
      );
      // A public id the server did not sign is refused.
      await assert.rejects(
        evidence.confirmVideoUpload(sql, { ...owner, publicId: 'property-evidence/forged' }),
        { code: 'UPLOAD_CHANGED' },
      );

      // Upload, replace before sending (old asset removed), then submit explicitly.
      const a = await evidence.signVideoUpload(sql, owner);
      store.files.set(a.publicId, { format: 'mov', bytes: 2_000_000 });
      await evidence.confirmVideoUpload(sql, { ...owner, publicId: a.publicId });
      const b = await evidence.signVideoUpload(sql, owner);
      store.files.set(b.publicId, { format: 'mp4', bytes: 3_000_000 });
      await evidence.confirmVideoUpload(sql, { ...owner, publicId: b.publicId });
      assert.ok(store.removed.includes(a.publicId));
      assert.equal(
        (await evidence.ownerEvidenceRequests(sql, { clientId: f.owner, id })).requests[0].state,
        'uploaded',
      );
      await assert.rejects(evidence.submitVideoResponse(sql, { ...owner, publicId: a.publicId }), {
        code: 'UPLOAD_CHANGED',
      });
      await evidence.submitVideoResponse(sql, { ...owner, publicId: b.publicId });
      assert.equal(
        (
          await evidence.submitVideoResponse(sql, {
            ...owner,
            publicId: b.publicId.split('/').pop(),
          })
        ).replayed,
        true,
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='evidence_response_submitted' AND entity_id=${id}`
        )[0].n,
        1,
      );

      // Submitted evidence is immutable and cannot be replaced.
      await assert.rejects(evidence.signVideoUpload(sql, owner), { code: 'EVIDENCE_SUBMITTED' });
      await assert.rejects(
        sql`UPDATE property_evidence_request SET video_public_id='x' WHERE id=${requestId}`,
      );
      await assert.rejects(sql`DELETE FROM property_evidence_request WHERE id=${requestId}`);
      assert.ok(store.files.has(b.publicId));

      // A later, distinct request for the same submission is allowed.
      const later = await ask();
      assert.notEqual(later.requestId, requestId);

      // Reviewer sees attributable history; playback is audited; nothing was approved.
      const review = await readPropertyReview(sql, id);
      const shown = review.evidenceRequests.find((r) => r.id === requestId);
      assert.equal(shown.state, 'submitted');
      assert.equal(shown.passNumber, 1);
      assert.equal(shown.video.format, 'mp4');
      assert.equal(JSON.stringify(review.evidenceRequests).includes('property-evidence/'), false);
      const played = await evidence.streamEvidenceVideo(sql, { id, requestId, adminId: f.admin });
      assert.equal(await played.text(), 'video-bytes');
      // A mid-file Range request is still an audited view.
      await evidence.streamEvidenceVideo(sql, {
        id,
        requestId,
        adminId: f.admin,
        range: 'bytes=5000-',
      });
      await assert.rejects(
        evidence.streamEvidenceVideo(sql, { id, requestId: later.requestId, adminId: f.admin }),
        { statusCode: 404 },
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='evidence_video_viewed'`
        )[0].n,
        2,
      );
      assert.deepEqual(await rentableState(), before, 'evidence flow never changes review state');
    } finally {
      delete globalThis.__rentraVideoStore;
      await fixture.drop();
    }
  },
);
