import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedReviewModeration } from '../helpers/review-moderation-fixture.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (n) =>
  new File([Buffer.from([...PNG, ...Array(64).fill(n)])], `p${n}.png`, { type: 'image/png' });

test(
  'Story 5.4 actions: FormData report with photos, upheld resolve, dedupe, repeat reporter, already-hidden uphold',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = db.url;
      process.env.SESSION_SECRET = 'review-report-actions-disposable-fixture-secret';
      process.env.NODE_ENV = 'test';
      const { memoryEvidenceStore } = await import('../../src/services/uploads/evidence-store.js');
      globalThis.__rentraEvidenceStore = memoryEvidenceStore();
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing),
        fx = await seedReviewModeration(sql, f, booking, { pending: false }),
        id = fx.reviewId;
      await sql`UPDATE "user" SET profile_completed_at=now(),name=coalesce(name,'Asha Guest') WHERE id=${fx.customer.userId}`;

      const { runWithContext } = await import('../../src/runtime/context.js');
      const { createAdminSession } = await import('../../src/services/auth/admin.js');
      const { createSession } = await import('../../src/services/auth/session.js');
      const actions = await import('../../src/services/reviews/actions.js');
      const { resolveReviewReport, reviewDetail } =
        await import('../../src/services/reviews/service.js');
      const cookies = {};
      const res = { cookie: (n, v) => (cookies[n] = v), clearCookie() {} };
      await runWithContext({ req: { cookies: {}, headers: {} }, res }, () =>
        createAdminSession(f.admin, true),
      );
      await runWithContext({ req: { cookies: {}, headers: {} }, res }, () =>
        createSession({ ...fx.customer, accountStatus: 'active' }),
      );
      const call = (fn, entries, cookie) => {
        const form = new FormData();
        for (const [k, v] of entries) form.append(k, v);
        return runWithContext(
          { req: { cookies: cookie, headers: {} }, res: { cookie() {}, clearCookie() {} } },
          () => fn(null, form),
        );
      };
      const asCustomer = { rentra_session: cookies.rentra_session };
      const asAdmin = { rentra_admin: cookies.rentra_admin };
      const attachments = async () =>
        (await sql`SELECT count(*)::int n FROM review_report_attachment`)[0].n;
      const reason = ['reason', 'The review names the host staff and uses abusive language.'];

      // Customer report through FormData; the duplicated image is stored once.
      const saved = await call(
        actions.customerReviewReport,
        [['id', id], reason, ['photos', png(1)], ['photos', png(1)], ['photos', png(2)]],
        asCustomer,
      );
      assert.ok(saved.id, JSON.stringify(saved));
      assert.equal(await attachments(), 2);
      // Repeat reporter with new photos: original returned, nothing added.
      const again = await call(
        actions.customerReviewReport,
        [['id', id], reason, ['photos', png(7)]],
        asCustomer,
      );
      assert.equal(again.id, saved.id);
      assert.match(again.message, /new photos were not added/);
      assert.equal(await attachments(), 2);

      // Admin upholds through FormData: preview, then confirm.
      const version = String((await reviewDetail(sql, { kind: 'admin', id: f.admin }, id)).version);
      const base = [
        ['id', saved.id],
        ['outcome', 'upheld'],
        ['note', 'Harassment of named staff breaks the review rules.'],
        ['state', 'hidden'],
        ['category', 'harassment'],
        ['version', version],
      ];
      const preview = await call(
        actions.resolveReviewReport,
        [...base, ['mode', 'preview']],
        asAdmin,
      );
      assert.ok(preview.preview?.token, JSON.stringify(preview));
      await call(
        actions.resolveReviewReport,
        [...base, ['mode', 'apply'], ['previewToken', preview.preview.token]],
        asAdmin,
      );
      const after = await reviewDetail(sql, { kind: 'admin', id: f.admin }, id);
      assert.equal(after.state, 'hidden');
      assert.equal(after.reports[0].outcome, 'upheld');

      // Already hidden: a second report is upheld without a new moderation step.
      const [second] =
        await sql`INSERT INTO review_report(review_id,reporter_id,reason) VALUES(${id},${f.owner},'Owner also reported this abusive review text.') RETURNING id`;
      const before = after.version;
      // Missing version comes back as field errors, not a throw.
      const noVersion = await call(
        actions.resolveReviewReport,
        [
          ['id', second.id],
          ['outcome', 'upheld'],
          ['note', 'Missing version must not crash.'],
          ['state', 'hidden'],
          ['category', 'spam'],
        ],
        asAdmin,
      );
      assert.ok(noVersion.errors, JSON.stringify(noVersion));
      await resolveReviewReport(sql, f.admin, {
        reportId: second.id,
        outcome: 'upheld',
        note: 'Already hidden for harassment; report upheld.',
      });
      const final = await reviewDetail(sql, { kind: 'admin', id: f.admin }, id);
      assert.equal(final.version, before, 'not re-moderated');
      const closure = final.history.find(
        (h) => h.action === 'review_report_closed' && h.after.decisionAuditId,
      );
      assert.equal(closure.after.category, 'harassment');
    } finally {
      delete globalThis.__rentraEvidenceStore;
      await db.drop();
    }
  },
);
