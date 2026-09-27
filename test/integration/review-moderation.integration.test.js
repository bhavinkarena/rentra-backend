import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedReviewModeration } from '../helpers/review-moderation-fixture.js';
import {
  moderateReview,
  replyToReview,
  reportReview,
  closeReviewReport,
  reviewDetail,
  reviewQueue,
  publicReview,
} from '../../src/services/reviews/service.js';
test(
  'CP18 score-neutral previews, immutable review history, races, reports and public aggregates',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing),
        fixture = await seedReviewModeration(sql, f, booking),
        id = fixture.reviewId;
      const admin = { kind: 'admin', id: f.admin },
        owner = { kind: 'owner', id: f.owner };
      const totals = async () =>
        (await sql`SELECT review_count,rating_avg FROM rentable WHERE id=${f.listing}`)[0];
      const current = () => reviewDetail(sql, admin, id);
      const input = {
        id,
        version: 0,
        state: 'published',
        reason: 'Authentic negative experience without a policy violation.',
        category: 'meets_policy',
      };
      await assert.rejects(moderateReview(sql, f.limited, { ...input, preview: true }), {
        code: 'FORBIDDEN',
      });
      await assert.rejects(reviewDetail(sql, { kind: 'owner', id: f.other }, id), {
        code: 'NOT_FOUND',
      });
      await assert.rejects(
        moderateReview(sql, f.admin, { ...input, state: 'hidden', preview: true }),
        { code: 'INVALID_REASON' },
      );
      await assert.rejects(moderateReview(sql, f.admin, input), { code: 'PREVIEW_REQUIRED' });
      const p = await moderateReview(sql, f.admin, { ...input, preview: true });
      assert.equal((await totals()).review_count, 0);
      assert.equal((await current()).version, 0);
      assert.equal(p.preview.rating, 1);
      await assert.rejects(
        moderateReview(sql, f.admin, {
          ...input,
          reason: 'Changed reason after the preview',
          previewToken: p.preview.token,
        }),
        { code: 'PREVIEW_REQUIRED' },
      );
      const race = await Promise.allSettled(
        [1, 2].map(() => moderateReview(sql, f.admin, { ...input, previewToken: p.preview.token })),
      );
      assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
      assert.deepEqual(await totals(), { review_count: 1, rating_avg: 1 });
      assert.ok(await publicReview(sql, id));
      for (const body of [
        'We are sorry about the garden condition and will address it.',
        'Thank you for the feedback. The garden maintenance is now scheduled.',
      ]) {
        const v = (await current()).version,
          command = { id, version: v, body };
        const preview = await replyToReview(sql, f.owner, { ...command, preview: true });
        await replyToReview(sql, f.owner, { ...command, previewToken: preview.preview.token });
      }
      const detail = await reviewDetail(sql, owner, id);
      assert.equal(detail.history.length, 2);
      assert.match(detail.history[1].before.body, /sorry/);
      assert.match(detail.history[1].after.body, /scheduled/);
      const report = await reportReview(sql, owner, {
        id,
        reason: 'Please investigate whether this contains unrelated content.',
      });
      const guestReport = await reportReview(
        sql,
        { kind: 'customer', session: fixture.customer },
        { id, reason: 'Please check this review under the published review rules.' },
      );
      assert.equal((await current()).reports.length, 2);
      assert.equal((await reviewDetail(sql, owner, id)).reports.length, 1);
      assert.equal(
        (
          await reportReview(sql, owner, {
            id,
            reason: 'Duplicate report should preserve the original reason.',
          })
        ).id,
        report.id,
      );
      const close = await Promise.allSettled(
        [1, 2].map(() =>
          closeReviewReport(sql, f.admin, {
            id: report.id,
            resolution: 'The low score is not a violation. The review remains public.',
          }),
        ),
      );
      assert.equal(close.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal((await totals()).review_count, 1);
      await closeReviewReport(sql, f.admin, {
        id: guestReport.id,
        resolution: 'No policy violation found; retain the review and its score.',
      });
      const hide = {
        id,
        version: (await current()).version,
        state: 'hidden',
        category: 'private_information',
        reason: 'Private information discovered during the subsequent investigation.',
      };
      const hp = await moderateReview(sql, f.admin, { ...hide, preview: true });
      await moderateReview(sql, f.admin, { ...hide, previewToken: hp.preview.token });
      assert.deepEqual(await totals(), { review_count: 0, rating_avg: null });
      await assert.rejects(publicReview(sql, id), { code: 'NOT_FOUND' });
      assert.equal(
        (await reviewQueue(sql, owner)).rows.length,
        1,
        'owner can follow own report after removal',
      );
      assert.equal(
        (await current()).history.filter((h) => h.action === 'review_moderated').length,
        2,
      );
      await assert.rejects(sql`UPDATE review SET rating=5 WHERE id=${id}`);
      const restore = { ...input, version: (await current()).version };
      const rp = await moderateReview(sql, f.admin, { ...restore, preview: true });
      await moderateReview(sql, f.admin, { ...restore, previewToken: rp.preview.token });
      assert.deepEqual(await totals(), { review_count: 1, rating_avg: 1 });
      await assert.rejects(
        replyToReview(sql, f.other, {
          id,
          version: (await current()).version,
          body: 'An unauthorized owner must never replace this reply.',
          preview: true,
        }),
        { code: 'FORBIDDEN' },
      );
      await sql`UPDATE booking SET state='disputed' WHERE id=${fixture.visitId}`;
      assert.equal((await totals()).review_count, 0);
      await assert.rejects(publicReview(sql, id), { code: 'NOT_FOUND' });
    } finally {
      await db.drop();
    }
  },
);
