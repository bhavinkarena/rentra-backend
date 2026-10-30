import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import {
  reservePayoutTransfer,
  dispatchPayoutTransfer,
} from '../../src/services/finance/payout-transfer-fixtures.js';
import { previewIncidentRemedy, decideIncidentRemedy } from '../../src/services/support/remedy.js';
import { readSupportRequest } from '../../src/services/support/service.js';

test(
  'Story 4.4 incident remedy preview and decision matrix',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        cash = await seedFinanceFixture(sql, f);
      const admin = { kind: 'admin', id: f.admin };
      const staff = async (permissions) => ({
        kind: 'admin',
        id: (
          await sql`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES (${randomUUID() + '@fixture.invalid'},'Staff','x',${JSON.stringify(permissions)}::text::jsonb) RETURNING id`
        )[0].id,
      });
      // A Test order paid 108000 = rent 100000 + fee 8000 (ledger rows are immutable; the unit test
      // covers the 10000 mockup figures), with a stay-issue case on its visit.
      const order = async () => {
        const s = await cash.add('test');
        const [{ customer_id }] =
          await sql`SELECT customer_id FROM booking_order WHERE id=${s.orderId}`;
        const key = randomUUID();
        const [c] =
          await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
        VALUES (${'SUP-' + key.slice(0, 12)},${customer_id},${s.orderId},'stay_issue','Dirty room',
        ${JSON.stringify({ stayIssue: { affected: [{ visitId: s.bookingId }] } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',now(),false) RETURNING id`;
        return { ...s, caseId: c.id };
      };
      const refund = (
        s,
        rent,
        fee,
        { state = 'succeeded', reason = 'Customer visit cancellation' } = {},
      ) =>
        sql.begin(async (tx) => {
          const key = randomUUID(),
            ok = state === 'succeeded';
          const [r] =
            await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,actual_minor,idempotency_key,request_hash,provider_refund_id,verified_at,evidence_hash)
          VALUES (${reason},${key},${s.transactionId},'fixture','test','real','INR',${state},${rent + fee},${ok ? rent + fee : 0},${key},${'d'.repeat(64)},${ok ? key : null},${ok ? new Date().toISOString() : null},${ok ? 'e'.repeat(64) : null}) RETURNING id`;
          for (const [component, minor, id] of [
            ['rent', rent, s.allocationId],
            ['fee', fee, s.feeAllocationId],
          ])
            if (minor)
              await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor,actual_minor) VALUES (${r.id},${id},${s.bookingId},${component},${minor},${ok ? minor : 0})`;
        });
      const preview = (s, extra = {}) =>
        previewIncidentRemedy(sql, admin, {
          supportRequestId: s.caseId,
          targetPct: 100,
          responsibility: 'proportional',
          ...extra,
        });
      const decide = (s, p, extra = {}) =>
        decideIncidentRemedy(sql, admin, {
          supportRequestId: s.caseId,
          kind: 'award',
          reason: 'Room unusable all stay',
          targetPct: p.targetPct,
          responsibility: p.responsibility,
          visitIds: p.visitIds,
          digest: p.digest,
          requestKey: randomUUID(),
          ...extra,
        });
      const money =
        () => sql`SELECT (SELECT count(*)::int FROM refund) refunds,(SELECT count(*)::int FROM refund_allocation) allocations,
      (SELECT count(*)::int FROM owner_recovery) obligations,(SELECT count(*)::int FROM payout) payouts,(SELECT count(*)::int FROM payout_transfer_fixture) fixtures`;

      await t.test(
        'proportional and owner-funded after a 50% refund; decision saves no money',
        async () => {
          const s = await order();
          await refund(s, 50000, 4000);
          const p = await preview(s);
          assert.deepEqual(p.paidByComponent, { rent: 100000, fee: 8000, tax: 0 });
          assert.equal(p.priorRefundedMinor, 54000);
          assert.equal(p.additionalDueMinor, 54000);
          assert.equal(p.owner.increaseMinor, 50000);
          assert.equal(p.providerCall, true);
          const o = await preview(s, { responsibility: 'owner_funded' });
          assert.equal(o.additionalDueMinor, 54000);
          assert.equal(o.owner.totalMinor, 108000);
          assert.equal(o.reassignedFromRentraMinor, 4000);
          assert.equal(o.owner.exceedsProceedsMinor, 8000);
          const before = await money();
          const d = await decide(s, o);
          assert.equal(d.preview.additionalDueMinor, 54000);
          assert.equal(d.preview.reassignedFromRentraMinor, 4000);
          assert.deepEqual(await money(), before, 'no refund, obligation or payout');
          const [audit] =
            await sql`SELECT "after" FROM audit_log WHERE entity='support_request' AND entity_id=${s.caseId} AND action='incident_remedy_decided'`;
          assert.equal(audit.after.additionalDueMinor, 54000);
          assert.equal(audit.after.responsibility, 'owner_funded');
          const read = await readSupportRequest(sql, admin, s.caseId);
          assert.equal(read.remedy.decision.id, d.id);
          assert.equal(read.remedy.canDecide, true);
        },
      );

      await t.test('lower target, in-flight and case refunds', async () => {
        const s = await order();
        await refund(s, 50000, 4000);
        const low = await preview(s, { targetPct: 30 });
        assert.equal(low.additionalDueMinor, 0);
        assert.equal(low.providerCall, false);
        await refund(s, 9000, 1000, { state: 'processing' });
        await refund(s, 9000, 1000, { reason: 'Rentra booking case ABC' });
        const p = await preview(s);
        assert.equal(p.inFlightMinor, 10000);
        assert.equal(p.caseReimbursedMinor, 10000);
        assert.equal(p.additionalDueMinor, 34000);
        await refund(s, 9000, 1000, { state: 'failed' });
        assert.equal((await preview(s)).additionalDueMinor, 34000, 'failed refunds not counted');
      });

      await t.test('projected recovery after a paid-out fixture and 2000 recovered', async () => {
        const s = await order();
        const provider = payoutTransferProvider();
        const fx = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          provider,
        );
        await dispatchPayoutTransfer(sql, admin, fx.id, {}, provider);
        await refund(s, 50000, 4000);
        await sql`INSERT INTO owner_recovery(owner_id,source_id,fixture_id,obligation_minor,recovered_minor,actor_id,reason)
        VALUES (${f.owner},${s.allocationId},${fx.id},50000,2000,${f.admin},'Fixture recovery row')`;
        const p = await preview(s);
        assert.equal(p.payoutStates[0].state, 'paid');
        assert.equal(p.projectedRecoveryMinor, 98000);
        assert.equal(
          (await preview(s, { responsibility: 'owner_funded' })).projectedRecoveryMinor,
          106000,
        );
      });

      await t.test('scope, permissions and stale previews', async () => {
        const s = await order(),
          other = await order();
        await assert.rejects(preview(s, { visitIds: [other.bookingId] }), {
          code: 'VISIT_NOT_IN_ORDER',
          statusCode: 422,
        });
        await assert.rejects(preview(s, { visitIds: [] }), {
          code: 'VISIT_REQUIRED',
          statusCode: 422,
        });
        const key = randomUUID();
        const [plain] =
          await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority)
        SELECT ${'SUP-' + key.slice(0, 12)},customer_id,id,'payment','Payment question','{}','v1',${key},${'a'.repeat(64)},'normal' FROM booking_order WHERE id=${other.orderId} RETURNING id`;
        await assert.rejects(preview({ caseId: plain.id }), {
          code: 'REMEDY_UNAVAILABLE',
          statusCode: 422,
        });
        const reader = await staff(['admin.support.read', 'admin.payments.read']);
        const p = await previewIncidentRemedy(sql, reader, {
          supportRequestId: s.caseId,
          targetPct: 100,
          responsibility: 'proportional',
        });
        await assert.rejects(
          decideIncidentRemedy(sql, reader, {
            supportRequestId: s.caseId,
            kind: 'deny',
            reason: 'Not supported by evidence',
            requestKey: randomUUID(),
          }),
          { statusCode: 403 },
        );
        const support = await staff(['admin.support.read']);
        await assert.rejects(
          previewIncidentRemedy(sql, support, {
            supportRequestId: s.caseId,
            targetPct: 100,
            responsibility: 'proportional',
          }),
          { statusCode: 403 },
        );
        const summary = await readSupportRequest(sql, support, s.caseId);
        assert.equal(summary.remedy.canPreview, false);
        await assert.rejects(
          decide(s, p, { targetPct: 90 }),
          (e) => e.code === 'PREVIEW_CHANGED' && e.preview.targetPct === 90,
        );
        await refund(s, 9000, 1000);
        await assert.rejects(
          decide(s, p),
          (e) => e.code === 'PREVIEW_CHANGED' && e.preview.priorRefundedMinor === 10000,
        );
        assert.equal(
          (
            await sql`SELECT count(*)::int n FROM incident_remedy_decision WHERE support_request_id=${s.caseId}`
          )[0].n,
          0,
        );
      });

      await t.test('deny, replay, conflict and supersede', async () => {
        const s = await order();
        const body = {
          supportRequestId: s.caseId,
          kind: 'deny',
          reason: 'Evidence shows the room was clean',
          requestKey: randomUUID(),
        };
        const first = await decideIncidentRemedy(sql, admin, body);
        assert.equal(first.targetPct, null);
        assert.equal(first.preview, null);
        const again = await decideIncidentRemedy(sql, admin, body);
        assert.equal(again.replayed, true);
        assert.equal(again.id, first.id);
        await assert.rejects(
          decideIncidentRemedy(sql, admin, { ...body, reason: 'A different reason entirely' }),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
        const second = await decide(s, await preview(s, { targetPct: 50 }));
        const rows =
          await sql`SELECT id,superseded_at FROM incident_remedy_decision WHERE support_request_id=${s.caseId} ORDER BY created_at`;
        assert.equal(rows.length, 2);
        assert.ok(rows.find((r) => r.id === first.id).superseded_at);
        assert.equal(rows.find((r) => r.id === second.id).superseded_at, null);
      });
    } finally {
      await db.drop();
    }
  },
);
