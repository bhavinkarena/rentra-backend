import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'review queues and revision context reflect full data; document proxy rejects replaced evidence',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    const originalFetch = globalThis.fetch;
    try {
      globalThis.__rentraSql = sql;
      Object.assign(process.env, {
        DATABASE_URL: fixture.url,
        NODE_ENV: 'test',
        NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3163',
        SESSION_SECRET: 'phase5-disposable-session-secret-only',
        CLOUDINARY_CLOUD_NAME: 'phase5-fixture',
        CLOUDINARY_API_KEY: 'fixture',
        CLOUDINARY_API_SECRET: 'fixture-only',
      });
      const f = await seedReviewFixture(sql);
      const { submitProperty, listPropertyReviews, readPropertyReview, decidePropertyReview } =
        await import('../../src/services/admin/listings.js');
      const { listApplications } = await import('../../src/services/admin/applications.js');
      await sql`INSERT INTO client_application(user_id,status,legal_name,submitted_at) VALUES (${f.other},'submitted','SLA boundary',now()-interval '48 hours 15 minutes')`;
      const applications = await listApplications(sql, f.admin, { q: 'SLA boundary' });
      assert.equal(applications.counts.overdue, 1);
      assert.equal(applications.items[0].ageHours, 48);
      assert.equal(applications.items[0].overdue, true);
      const first = await submitProperty(sql, { id: f.listing, clientId: f.owner });
      let queue = await listPropertyReviews(sql, f.admin, {});
      assert.deepEqual(queue.counts, { total: 1, waiting: 1, unassigned: 1, verification: 0 });
      assert.equal(queue.items[0].ownerName, 'Property Owner');
      assert.equal(queue.items[0].verificationScheduled, false);
      const initial = await readPropertyReview(sql, f.listing);
      assert.equal(initial.draftSnapshot.listing.title, initial.current.snapshot.listing.title);
      await sql`UPDATE rentable SET title='Changed current property' WHERE id=${f.listing}`;
      const changed = await readPropertyReview(sql, f.listing);
      assert.equal(changed.stale, true);
      assert.equal(changed.current.id, first.submissionId);
      assert.equal(changed.current.snapshot.listing.title, 'Review River Farm');
      assert.equal(changed.draftSnapshot.listing.title, 'Changed current property');
      await assert.rejects(
        decidePropertyReview(sql, {
          id: f.listing,
          adminId: f.admin,
          input: {
            submissionId: first.submissionId,
            outcome: 'approved_for_visit',
            reason: 'Reviewed original',
          },
        }),
      );
      const second = await submitProperty(sql, { id: f.listing, clientId: f.owner });
      const current = await readPropertyReview(sql, f.listing);
      assert.equal(current.submissions.length, 2);
      assert.equal(current.current.id, second.submissionId);
      assert.equal(
        current.submissions.find((s) => s.id === first.submissionId).snapshot.listing.title,
        'Review River Farm',
      );
      assert.equal(JSON.stringify(current.draftSnapshot).includes('storageKey'), false);
      await decidePropertyReview(sql, {
        id: f.listing,
        adminId: f.admin,
        input: {
          submissionId: second.submissionId,
          outcome: 'approved_for_visit',
          reason: 'Ready for verification',
        },
      });
      queue = await listPropertyReviews(sql, f.admin, { status: 'all' });
      assert.equal(queue.counts.waiting, 0);
      assert.equal(queue.counts.verification, 1);
      assert.equal((await listPropertyReviews(sql, f.admin, { q: 'no match' })).counts.total, 0);
      let fetches = 0;
      globalThis.fetch = async () => {
        fetches++;
        return new Response('fixture bytes', { headers: { 'content-type': 'image/jpeg' } });
      };
      const { readDocumentFile } = await import('../../src/services/auth/document-file.js');
      const opened = await readDocumentFile(f.admin, f.document);
      assert.equal(opened.status, 200);
      assert.equal(fetches, 1);
      assert.equal(
        (
          await sql`SELECT count(*)::int count FROM audit_log WHERE action='document_viewed' AND entity_id=${f.document}`
        )[0].count,
        1,
      );
      await sql`UPDATE document SET status='superseded' WHERE id=${f.document}`;
      assert.deepEqual(await readDocumentFile(f.admin, f.document), { status: 404 });
      await sql`UPDATE document SET deleted_at=now() WHERE id=${f.document}`;
      assert.deepEqual(await readDocumentFile(f.admin, f.document), { status: 404 });
      assert.equal(fetches, 1, 'Replaced/deleted evidence must never reach storage');
    } finally {
      globalThis.fetch = originalFetch;
      await fixture.drop();
    }
  },
);
