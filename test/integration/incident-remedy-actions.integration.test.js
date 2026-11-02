import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileBackedRazorpay } from '../helpers/fake-razorpay.mjs';

test(
  'Story 4.4/4.5 remedy actions: FormData in, refusals as state',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = db.url;
      process.env.SESSION_SECRET = 'remedy-disposable-fixture-signing-secret-only';
      process.env.NODE_ENV = 'test';
      const f = await seedReviewFixture(sql),
        cash = await seedFinanceFixture(sql, f);
      const s = await cash.add('test');
      const [{ customer_id }] =
        await sql`SELECT customer_id FROM booking_order WHERE id=${s.orderId}`;
      const newCase = async (category, orderId) => {
        const key = randomUUID();
        const stay = category === 'stay_issue';
        const [c] =
          await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
        VALUES (${'SUP-' + key.slice(0, 12)},${customer_id},${orderId},${category},'Dirty room',
        ${JSON.stringify(stay ? { stayIssue: { affected: [{ visitId: s.bookingId }] } } : {})}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',${stay ? new Date().toISOString() : null},${stay ? false : null}) RETURNING id`;
        return c.id;
      };
      const caseId = await newCase('stay_issue', s.orderId);
      const plain = await newCase('other', null);

      const { runWithContext } = await import('../../src/runtime/context.js');
      const { createAdminSession } = await import('../../src/services/auth/admin.js');
      const { previewRemedy, decideRemedy, executeRemedy, incidentRepaymentLink } =
        await import('../../src/services/support/actions.js');
      let token;
      await runWithContext(
        { req: { cookies: {} }, res: { cookie: (_n, value) => (token = value) } },
        () => createAdminSession(f.admin, true),
      );
      const call = (action, entries) => {
        const form = new FormData();
        for (const [k, v] of entries) form.append(k, v);
        return runWithContext(
          { req: { cookies: { rentra_admin: token } }, res: { cookie() {}, clearCookie() {} } },
          () => action(null, form),
        );
      };

      const base = [
        ['id', caseId],
        ['targetPct', '100'],
        ['responsibility', 'proportional'],
      ];
      const both = [...base, ['visitIds', s.bookingId], ['visitIds', s.bookingId]];
      const p = (await call(previewRemedy, both)).preview;
      assert.deepEqual(p.visitIds, [s.bookingId], 'repeated visitIds collapse');
      assert.equal(p.supportRequestId, caseId);

      assert.ok(
        (
          await call(previewRemedy, [
            ['id', caseId],
            ['targetPct', ''],
            ['responsibility', 'proportional'],
          ])
        ).errors.targetPct,
        'empty % refused',
      );

      const short = await call(decideRemedy, [
        ...base,
        ['kind', 'award'],
        ['reason', 'short'],
        ['digest', p.digest],
        ['requestKey', randomUUID()],
      ]);
      assert.ok(short.errors.reason);

      const stale = await call(decideRemedy, [
        ['id', caseId],
        ['targetPct', '90'],
        ['responsibility', 'proportional'],
        ['kind', 'award'],
        ['reason', 'Room unusable all stay'],
        ['digest', p.digest],
        ['requestKey', randomUUID()],
      ]);
      assert.equal(stale.code, 'PREVIEW_CHANGED');
      assert.equal(stale.preview.targetPct, 90);

      const saved = await call(decideRemedy, [
        ...base,
        ['kind', 'award'],
        ['reason', 'Room unusable all stay'],
        ['digest', p.digest],
        ['requestKey', randomUUID()],
      ]);
      assert.equal(saved.decision.preview.additionalDueMinor, 108000);

      const none = await call(decideRemedy, [
        ['id', plain],
        ['kind', 'deny'],
        ['reason', 'Nothing to remedy here'],
        ['requestKey', randomUUID()],
      ]);
      assert.equal(none.code, 'REMEDY_UNAVAILABLE');
      assert.equal(none.status, 422);

      // Story 4.5: execute refusals come back as state; bad input as field errors.
      const staleRun = await call(executeRemedy, [
        ['id', caseId],
        ['decisionId', saved.decision.id],
        ['digest', 'b'.repeat(64)],
        ['requestKey', randomUUID()],
      ]);
      assert.equal(staleRun.code, 'PREVIEW_CHANGED');
      assert.equal(staleRun.preview.additionalDueMinor, 108000);
      const bad = await call(executeRemedy, [
        ['id', caseId],
        ['decisionId', saved.decision.id],
        ['digest', 'x'],
        ['requestKey', 'nope'],
      ]);
      assert.equal(bad.status, 422);
      assert.ok(bad.errors.digest && bad.errors.requestKey);
      const [ob] =
        await sql`INSERT INTO incident_owner_obligation(decision_id,owner_id,order_id,amount_minor,components,state)
        VALUES (${saved.decision.id},${f.owner},${s.orderId},500,'{"reassigned_fee_minor":250,"owner_fee_share_minor":250}','due') RETURNING id`;
      process.env.RAZORPAY_KEY_ID = 'rzp_test_ACTION45';
      process.env.RAZORPAY_KEY_SECRET = 'action-disposable-secret';
      const realFetch = globalThis.fetch;
      globalThis.fetch = fileBackedRazorpay(
        join(mkdtempSync(join(tmpdir(), 'act45-')), 'rzp.json'),
      );
      try {
        const linked = await call(incidentRepaymentLink, [
          ['id', caseId],
          ['obligationId', ob.id],
          ['requestKey', randomUUID()],
        ]);
        assert.equal(linked.link.amountMinor, '500');
        assert.equal(linked.link.incidentObligationId, ob.id);
      } finally {
        globalThis.fetch = realFetch;
      }
    } finally {
      await db.drop();
    }
  },
);
