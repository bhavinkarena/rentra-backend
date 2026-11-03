import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedReviewModeration } from '../helpers/review-moderation-fixture.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';
import * as service from '../../src/services/reviews/service.js';
import { moderationAllowed } from '../../src/services/reviews/policy.js';
const {
  moderateReview,
  reportReview,
  resolveReviewReport,
  reviewDetail,
  reviewQueue,
  publicReview,
  reviewReportAttachment,
} = service;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (n, size = 64) =>
  new File([Buffer.from([...PNG, ...Array(size).fill(n)])], `p${n}.png`, { type: 'image/png' });

test(
  'Story 5.4: report evidence, structured outcomes and no owner veto',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing),
        fx = await seedReviewModeration(sql, f, booking, { pending: false }),
        id = fx.reviewId;
      const owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin },
        store = memoryEvidenceStore();
      const reason = 'The review contains content that breaks the review rules.';
      const totals = async () =>
        (await sql`SELECT review_count FROM rentable WHERE id=${f.listing}`)[0].review_count;
      const reportCount = async () => (await sql`SELECT count(*)::int n FROM review_report`)[0].n;
      assert.equal(await totals(), 1);

      // Invalid evidence: nothing saved.
      for (const files of [
        [png(1), png(2), png(3), png(4)],
        [png(1, 3 * 1024 * 1024)],
        [new File([Buffer.from('%PDF-1.4 fake')], 'a.pdf', { type: 'application/pdf' })],
      ])
        await assert.rejects(reportReview(sql, owner, { id, reason }, process.env, files, store), {
          statusCode: 422,
        });
      await assert.rejects(
        reportReview(sql, owner, { id, reason }, process.env, [png(1)], {
          ...store,
          configured: () => false,
        }),
        { statusCode: 503 },
      );
      assert.equal(await reportCount(), 0);

      // Owner reports with two photos: open, audited, review still public and counted.
      const report = await reportReview(
        sql,
        owner,
        { id, reason },
        process.env,
        [png(1), png(2)],
        store,
      );
      const [{ n: files }] =
        await sql`SELECT count(*)::int n FROM review_report_attachment WHERE report_id=${report.id}`;
      assert.equal(files, 2);
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM audit_log WHERE action='review_report_created' AND entity_id=${report.id}`
        )[0].n,
        1,
      );
      assert.ok(await publicReview(sql, id));
      assert.equal(await totals(), 1);
      await assert.rejects(sql`DELETE FROM review_report_attachment WHERE report_id=${report.id}`);
      // Same reporter again: original returned.
      assert.equal(
        (await reportReview(sql, owner, { id, reason }, process.env, [png(9)], store)).id,
        report.id,
      );

      // Evidence access: admin and reporter; other owner/customer 404.
      const detail = await reviewDetail(sql, owner, id);
      const att = detail.reports[0].attachments[0];
      assert.equal(detail.reports[0].attachments.length, 2);
      assert.ok(await reviewReportAttachment(sql, owner, report.id, att.id, process.env, store));
      assert.ok(await reviewReportAttachment(sql, admin, report.id, att.id, process.env, store));
      await assert.rejects(
        reviewReportAttachment(
          sql,
          { kind: 'owner', id: f.other },
          report.id,
          att.id,
          process.env,
          store,
        ),
        { code: 'NOT_FOUND' },
      );
      await assert.rejects(
        reviewReportAttachment(
          sql,
          { kind: 'customer', session: fx.customer },
          report.id,
          att.id,
          process.env,
          store,
        ),
        { code: 'NOT_FOUND' },
      );
      assert.equal((await publicReview(sql, id)).myReport, null, 'never exposed publicly');

      // Guest report with no photos; queue total is exact.
      const guest = await reportReview(
        sql,
        { kind: 'customer', session: fx.customer },
        { id, reason: 'Rating unfair, I think the score is too low.' },
        process.env,
        [],
        store,
      );
      assert.equal((await reviewQueue(sql, admin)).openReportsTotal, 2);
      assert.equal((await publicReview(sql, id, fx.customer)).myReport.id, guest.id);

      // Not a violation: review unchanged; reporter sees outcome; close twice 409.
      const before = (await reviewDetail(sql, admin, id)).version;
      await resolveReviewReport(sql, f.admin, {
        reportId: guest.id,
        outcome: 'not_violation',
        note: 'A low rating alone is not a policy violation.',
      });
      assert.equal((await reviewDetail(sql, admin, id)).version, before);
      assert.equal(await totals(), 1);
      const mine = (await publicReview(sql, id, fx.customer)).myReport;
      assert.deepEqual(
        [mine.outcome, mine.resolution],
        ['not_violation', 'A low rating alone is not a policy violation.'],
      );
      await assert.rejects(
        resolveReviewReport(sql, f.admin, {
          reportId: guest.id,
          outcome: 'not_violation',
          note: 'Second close attempt for the same report.',
        }),
        { code: 'ALREADY_CLOSED', statusCode: 409 },
      );
      assert.equal((await reviewQueue(sql, admin)).openReportsTotal, 1);

      // Upheld guards.
      const note = 'Harassment of the host staff by name in the review.';
      await assert.rejects(
        resolveReviewReport(sql, f.admin, { reportId: report.id, outcome: 'upheld', note }),
        {
          code: 'MODERATION_REQUIRED',
          statusCode: 422,
        },
      );
      await assert.rejects(
        resolveReviewReport(sql, f.admin, {
          reportId: report.id,
          outcome: 'upheld',
          note,
          moderation: { state: 'hidden', reason: 'meets_policy', version: before },
        }),
        { name: 'ZodError' },
      );
      const upheld = {
        reportId: report.id,
        outcome: 'upheld',
        note,
        moderation: { state: 'hidden', reason: 'harassment', version: before },
      };
      await assert.rejects(resolveReviewReport(sql, f.admin, upheld), { code: 'PREVIEW_REQUIRED' });
      const preview = await resolveReviewReport(sql, f.admin, {
        ...upheld,
        moderation: { ...upheld.moderation, preview: true },
      });
      await assert.rejects(
        resolveReviewReport(sql, f.admin, {
          ...upheld,
          moderation: {
            ...upheld.moderation,
            version: before + 5,
            previewToken: preview.preview.token,
          },
        }),
        { code: 'CHANGED', statusCode: 409 },
      );
      assert.equal(
        (await reviewDetail(sql, admin, id)).reports.find((r) => r.id === report.id).state,
        'open',
      );

      // Upheld with hide + harassment: hidden, closed, owner notified, counts drop, history joined.
      await resolveReviewReport(sql, f.admin, {
        ...upheld,
        moderation: { ...upheld.moderation, previewToken: preview.preview.token },
      });
      const after = await reviewDetail(sql, admin, id);
      assert.equal(after.state, 'hidden');
      assert.equal(after.reports.find((r) => r.id === report.id).outcome, 'upheld');
      assert.equal(await totals(), 0);
      assert.equal((await reviewQueue(sql, admin)).openReportsTotal, 0);
      assert.ok(after.history.some((h) => h.action === 'review_moderated'));
      assert.ok(
        after.history.some(
          (h) => h.action === 'review_report_closed' && h.after.outcome === 'upheld',
        ),
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM client_update WHERE client_id=${f.owner} AND action='review_report_closed'`
        )[0].n,
        1,
      );
      const ownerView = (await reviewDetail(sql, owner, id)).reports[0];
      assert.deepEqual([ownerView.outcome, ownerView.resolution], ['upheld', note]);

      // Manipulation reason is usable for hide/reject, never for publish.
      assert.ok(moderationAllowed('hidden', 'manipulation'));
      assert.ok(moderationAllowed('rejected', 'manipulation'));
      assert.ok(!moderationAllowed('published', 'manipulation'));
      const m = {
        id,
        version: after.version,
        state: 'rejected',
        category: 'manipulation',
        reason: 'Incentivised review offered a discount for five stars.',
      };
      const mp = await moderateReview(sql, f.admin, { ...m, preview: true });
      await moderateReview(sql, f.admin, { ...m, previewToken: mp.preview.token });

      // No owner veto path: the service exposes no owner delete/hide/approve command.
      for (const name of Object.keys(service))
        assert.ok(!/delete|hide|veto|approveReview|ownerModerat/i.test(name), name);
    } finally {
      await db.drop();
    }
  },
);
