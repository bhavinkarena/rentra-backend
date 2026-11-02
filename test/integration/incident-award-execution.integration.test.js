import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import {
  reservePayoutTransfer,
  dispatchPayoutTransfer,
} from '../../src/services/finance/payout-transfer-fixtures.js';
import {
  previewIncidentRemedy,
  decideIncidentRemedy,
  executeIncidentAward,
} from '../../src/services/support/remedy.js';
import { readSupportRequest } from '../../src/services/support/service.js';
import {
  createIncidentRepaymentLink,
  checkIncidentRepaymentLink,
  resolveIncidentRepaymentLink,
  listOwnerRepayments,
  verifyOwnerRepayment,
} from '../../src/services/finance/owner-repayment.js';

const SECRET = 'incident-award-disposable-secret';
const env = { ...process.env, RAZORPAY_KEY_ID: 'rzp_test_INCIDENT45', RAZORPAY_KEY_SECRET: SECRET };
const sign = (order, pay) => createHmac('sha256', SECRET).update(`${order}|${pay}`).digest('hex');

test(
  'Story 4.5 incident award execution matrix',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    const file = join(mkdtempSync(join(tmpdir(), 'incident-')), 'rzp.json');
    const opts = { env, fetcher: fileBackedRazorpay(file) };
    try {
      const f = await seedReviewFixture(sql),
        cash = await seedFinanceFixture(sql, f);
      const admin = { kind: 'admin', id: f.admin };
      const payoutProvider = payoutTransferProvider();
      payoutProvider.outcome = 'succeeded';
      // Paid 108000 = rent 100000 + fee 8000 through Razorpay Test sources, with a stay-issue case.
      const order = async (provider = 'razorpay') => {
        const s = await cash.add('test', { provider });
        const [{ customer_id }] =
          await sql`SELECT customer_id FROM booking_order WHERE id=${s.orderId}`;
        const key = randomUUID();
        const [c] =
          await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
          VALUES (${'SUP-' + key.slice(0, 12)},${customer_id},${s.orderId},'stay_issue','Dirty room',
          ${JSON.stringify({ stayIssue: { affected: [{ visitId: s.bookingId }] } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',now(),false) RETURNING id,reference`;
        return { ...s, caseId: c.id, caseRef: c.reference };
      };
      const priorRefund = (s, rent, fee) =>
        sql.begin(async (tx) => {
          const key = randomUUID();
          const [r] =
            await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,actual_minor,idempotency_key,request_hash,provider_refund_id,verified_at,evidence_hash)
            VALUES ('Customer visit cancellation',${key},${s.transactionId},'razorpay','test','real','INR','succeeded',${rent + fee},${rent + fee},${key},${'d'.repeat(64)},${key},now(),${'e'.repeat(64)}) RETURNING id`;
          for (const [component, minor, id] of [
            ['rent', rent, s.allocationId],
            ['fee', fee, s.feeAllocationId],
          ])
            await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor,actual_minor) VALUES (${r.id},${id},${s.bookingId},${component},${minor},${minor})`;
        });
      const payout = async (s) => {
        const fx = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          payoutProvider,
        );
        await dispatchPayoutTransfer(sql, admin, fx.id, {}, payoutProvider);
      };
      const award = async (s, targetPct, responsibility) => {
        const p = await previewIncidentRemedy(sql, admin, {
          supportRequestId: s.caseId,
          targetPct,
          responsibility,
        });
        return decideIncidentRemedy(sql, admin, {
          supportRequestId: s.caseId,
          kind: 'award',
          reason: '  Room unusable all stay  ',
          targetPct,
          responsibility,
          visitIds: p.visitIds,
          digest: p.digest,
          requestKey: randomUUID(),
        });
      };
      const execute = (
        d,
        requestKey = randomUUID(),
        digest = d.preview?.digest ?? 'a'.repeat(64),
      ) => executeIncidentAward(sql, admin, { decisionId: d.id, digest, requestKey });
      const counts = async (s) =>
        (
          await sql`SELECT (SELECT count(*)::int FROM refund WHERE transaction_id=${s.transactionId}) refunds,
          (SELECT count(*)::int FROM incident_owner_obligation WHERE order_id=${s.orderId}) obligations,
          (SELECT count(*)::int FROM incident_remedy_execution e JOIN incident_remedy_decision d ON d.id=e.decision_id WHERE d.support_request_id=${s.caseId}) executions`
        )[0];
      const states = async (s) =>
        (
          await sql`SELECT (SELECT array_agg(state::text ORDER BY id) FROM booking WHERE order_id=${s.orderId}) bookings,
          (SELECT state::text FROM support_request WHERE id=${s.caseId}) support,
          (SELECT count(*)::int FROM payout_transfer_fixture) fixtures,(SELECT count(*)::int FROM payout) payouts`
        )[0];

      await t.test(
        '100% proportional after 50%: one refund of the additional, no obligation',
        async () => {
          const s = await order();
          await priorRefund(s, 50000, 4000);
          const d = await award(s, 100, 'proportional');
          const before = await states(s);
          const e = await execute(d);
          assert.equal(e.refunds.length, 1);
          assert.equal(e.refunds[0].amountMinor, '54000');
          assert.equal(e.refunds[0].status, 'queued');
          assert.equal(e.obligation, null);
          const [r] =
            await sql`SELECT reason,provider,environment FROM refund WHERE id=${e.refunds[0].id}`;
          assert.equal(r.reason, `Rentra support case ${s.caseRef}: Room unusable all stay`);
          assert.equal(r.environment, 'test');
          const parts =
            await sql`SELECT component,expected_minor::int m FROM refund_allocation WHERE refund_id=${e.refunds[0].id} ORDER BY component`;
          assert.deepEqual(Object.fromEntries(parts.map((p) => [p.component, p.m])), {
            rent: 50000,
            fee: 4000,
          });
          assert.deepEqual(await states(s), before, 'booking, support and payout state unchanged');
          const p = await previewIncidentRemedy(sql, admin, {
            supportRequestId: s.caseId,
            targetPct: 100,
            responsibility: 'proportional',
          });
          assert.equal(p.caseReimbursedMinor, 54000);
          assert.equal(p.additionalDueMinor, 0);
          const [audit] =
            await sql`SELECT "after" FROM audit_log WHERE action='incident_award_executed' AND entity_id=${s.caseId}`;
          assert.equal(audit.after.additionalDueMinor, 54000);
          assert.deepEqual(audit.after.refundIds, [e.refunds[0].id]);
          const read = await readSupportRequest(sql, admin, s.caseId);
          assert.equal(read.remedy.executions[0].id, e.id);
        },
      );

      await t.test(
        'owner-funded after payout: obligation due 8000; replay and re-execute; repayment link',
        async () => {
          const s = await order();
          await payout(s);
          await priorRefund(s, 50000, 4000);
          const d = await award(s, 100, 'owner_funded');
          const key = randomUUID();
          const e = await execute(d, key);
          assert.equal(e.refunds[0].amountMinor, '54000');
          assert.equal(e.obligation.state, 'due');
          assert.equal(e.obligation.amountMinor, '8000', 'reassigned 4000 + new fee share 4000');
          assert.equal(e.obligation.reassignedFeeMinor, '4000');
          assert.equal(e.obligation.ownerFeeShareMinor, '4000');
          const again = await execute(d, key);
          assert.equal(again.replayed, true);
          assert.equal(again.id, e.id);
          await assert.rejects(execute(d), { code: 'ALREADY_EXECUTED', statusCode: 409 });
          assert.deepEqual(await counts(s), { refunds: 2, obligations: 1, executions: 1 });
          const linkKey = randomUUID();
          const link = await createIncidentRepaymentLink(
            sql,
            admin,
            s.caseId,
            e.obligation.id,
            { requestKey: linkKey },
            opts,
          );
          assert.equal(link.amountMinor, '8000');
          assert.equal(link.state, 'open');
          assert.equal(
            (
              await createIncidentRepaymentLink(
                sql,
                admin,
                s.caseId,
                e.obligation.id,
                { requestKey: linkKey },
                opts,
              )
            ).id,
            link.id,
          );
          await assert.rejects(
            createIncidentRepaymentLink(
              sql,
              admin,
              s.caseId,
              e.obligation.id,
              { requestKey: randomUUID() },
              opts,
            ),
            { code: 'REPAYMENT_LINK_OPEN' },
          );
          providerCaptures(file, link.providerOrderId, 'pay_INC45', 8000);
          const paid = await verifyOwnerRepayment(
            sql,
            f.owner,
            link.id,
            { paymentId: 'pay_INC45', signature: sign(link.providerOrderId, 'pay_INC45') },
            opts,
          );
          assert.equal(paid.state, 'paid');
          const [ob] =
            await sql`SELECT state FROM incident_owner_obligation WHERE id=${e.obligation.id}`;
          assert.equal(ob.state, 'repaid');
          await assert.rejects(
            sql`DELETE FROM incident_owner_obligation WHERE id=${e.obligation.id}`,
          );
          await assert.rejects(
            sql`UPDATE incident_owner_obligation SET amount_minor=1 WHERE id=${e.obligation.id}`,
          );
        },
      );

      await t.test(
        'owner-funded before payout: awaiting_payout, due after payout succeeds',
        async () => {
          const s = await order();
          const d = await award(s, 50, 'owner_funded');
          const e = await execute(d);
          assert.equal(e.obligation.state, 'awaiting_payout');
          assert.equal(e.obligation.amountMinor, '4000');
          await assert.rejects(
            createIncidentRepaymentLink(
              sql,
              admin,
              s.caseId,
              e.obligation.id,
              { requestKey: randomUUID() },
              opts,
            ),
            {
              code: 'NOTHING_TO_COLLECT',
            },
          );
          await payout(s);
          const [ob] =
            await sql`SELECT state FROM incident_owner_obligation WHERE id=${e.obligation.id}`;
          assert.equal(ob.state, 'due');
          const [audit] =
            await sql`SELECT 1 FROM audit_log WHERE entity_id=${e.obligation.id} AND action='incident_obligation_due'`;
          assert.ok(audit);
        },
      );

      await t.test(
        'two owner-funded awards never exceed the cumulative owner extra; all executions listed',
        async () => {
          const s = await order();
          await payout(s);
          const first = await execute(await award(s, 50, 'owner_funded'));
          assert.equal(first.obligation.amountMinor, '4000');
          const second = await execute(await award(s, 100, 'owner_funded'));
          assert.equal(
            second.obligation.amountMinor,
            '4000',
            'only the new part; reassigned fee not counted twice',
          );
          const [{ total }] =
            await sql`SELECT sum(amount_minor)::int total FROM incident_owner_obligation WHERE order_id=${s.orderId}`;
          assert.equal(total, 8000, 'cumulative owner extra = whole fee paid');
          const read = await readSupportRequest(sql, admin, s.caseId);
          assert.deepEqual(
            read.remedy.executions.map((x) => x.id),
            [second.id, first.id],
          );
        },
      );

      await t.test(
        'incident link: scope, permissions, idempotency, owner list, wrong amount, check and resolve',
        async () => {
          const s = await order();
          await payout(s);
          const key = randomUUID();
          const d = await award(s, 100, 'owner_funded');
          const e = await execute(d, key);
          await assert.rejects(
            executeIncidentAward(sql, admin, {
              decisionId: d.id,
              digest: 'c'.repeat(64),
              requestKey: key,
            }),
            { code: 'IDEMPOTENCY_CONFLICT' },
          );
          await assert.rejects(
            executeIncidentAward(sql, admin, { decisionId: 'x', digest: 'y', requestKey: 'z' }),
            { statusCode: 422 },
          );
          const other = await order();
          await assert.rejects(
            createIncidentRepaymentLink(
              sql,
              admin,
              other.caseId,
              e.obligation.id,
              { requestKey: randomUUID() },
              opts,
            ),
            { statusCode: 404 },
          );
          const [reader] = await sql`INSERT INTO admin_user(email,name,password_hash,permissions)
          VALUES (${randomUUID() + '@fixture.invalid'},'Staff','x','["admin.support.read","admin.payments.read"]'::jsonb) RETURNING id`;
          await assert.rejects(
            createIncidentRepaymentLink(
              sql,
              { kind: 'admin', id: reader.id },
              s.caseId,
              e.obligation.id,
              { requestKey: randomUUID() },
              opts,
            ),
            { statusCode: 403 },
          );
          const linkKey = randomUUID();
          const link = await createIncidentRepaymentLink(
            sql,
            admin,
            s.caseId,
            e.obligation.id,
            { requestKey: linkKey },
            opts,
          );
          const deny = await decideIncidentRemedy(sql, admin, {
            supportRequestId: s.caseId,
            kind: 'deny',
            reason: 'Fixture decision for a second row',
            requestKey: randomUUID(),
          });
          const [spare] =
            await sql`INSERT INTO incident_owner_obligation(decision_id,owner_id,order_id,amount_minor,components,state)
          VALUES (${deny.id},${f.owner},${s.orderId},1,'{"reassigned_fee_minor":1,"owner_fee_share_minor":0}','due') RETURNING id`;
          await assert.rejects(
            createIncidentRepaymentLink(
              sql,
              admin,
              s.caseId,
              spare.id,
              { requestKey: linkKey },
              opts,
            ),
            { code: 'IDEMPOTENCY_CONFLICT' },
          );
          const listed = (await listOwnerRepayments(sql, f.owner, { env })).items.find(
            (i) => i.id === link.id,
          );
          assert.equal(listed.incidentObligationId, e.obligation.id);
          assert.ok(listed.bookingRef);
          providerCaptures(file, link.providerOrderId, 'pay_WRONG45', 7999);
          const parked = await verifyOwnerRepayment(
            sql,
            f.owner,
            link.id,
            { paymentId: 'pay_WRONG45', signature: sign(link.providerOrderId, 'pay_WRONG45') },
            opts,
          );
          assert.equal(parked.state, 'needs_review');
          assert.equal(
            (await sql`SELECT state FROM incident_owner_obligation WHERE id=${e.obligation.id}`)[0]
              .state,
            'due',
          );
          await assert.rejects(
            createIncidentRepaymentLink(
              sql,
              admin,
              s.caseId,
              e.obligation.id,
              { requestKey: randomUUID() },
              opts,
            ),
            { code: 'REPAYMENT_IN_FLIGHT' },
          );
          const closed = await resolveIncidentRepaymentLink(
            sql,
            admin,
            s.caseId,
            e.obligation.id,
            { linkId: link.id, reason: 'Wrong amount captured, return it' },
            opts,
          );
          assert.equal(closed.state, 'replaced');
          assert.equal(closed.excessMinor, '7999');
          const fresh = await createIncidentRepaymentLink(
            sql,
            admin,
            s.caseId,
            e.obligation.id,
            { requestKey: randomUUID() },
            opts,
          );
          providerCaptures(file, fresh.providerOrderId, 'pay_RIGHT45', 8000);
          const checked = await checkIncidentRepaymentLink(
            sql,
            admin,
            s.caseId,
            e.obligation.id,
            opts,
          );
          assert.deepEqual(
            checked.settled.map((l) => l.id),
            [fresh.id],
          );
          assert.equal(
            (await sql`SELECT state FROM incident_owner_obligation WHERE id=${e.obligation.id}`)[0]
              .state,
            'repaid',
          );
        },
      );

      await t.test('additional 0: no refund or provider call', async () => {
        const s = await order();
        await priorRefund(s, 50000, 4000);
        const d = await award(s, 30, 'owner_funded');
        const e = await execute(d);
        assert.deepEqual(e.refunds, []);
        assert.equal(e.obligation, null, 'maths gives 0 owed when nothing more is paid');
        assert.deepEqual(await counts(s), { refunds: 1, obligations: 0, executions: 1 });
      });

      await t.test('stale, deny, superseded, non-test and permissions', async () => {
        const s = await order();
        const d = await award(s, 100, 'proportional');
        await priorRefund(s, 1000, 0);
        await assert.rejects(
          execute(d),
          (e) => e.code === 'PREVIEW_CHANGED' && e.preview.priorRefundedMinor === 1000,
        );
        await assert.rejects(execute(d, randomUUID(), 'b'.repeat(64)), { code: 'PREVIEW_CHANGED' });
        assert.deepEqual(await counts(s), { refunds: 1, obligations: 0, executions: 0 });
        const newer = await award(s, 100, 'proportional');
        await assert.rejects(execute(d), { code: 'DECISION_NOT_ACTIVE' });
        const deny = await decideIncidentRemedy(sql, admin, {
          supportRequestId: s.caseId,
          kind: 'deny',
          reason: 'Evidence shows the room was clean',
          requestKey: randomUUID(),
        });
        await assert.rejects(execute(deny), { code: 'DECISION_NOT_ACTIVE' });
        await assert.rejects(execute(newer), { code: 'DECISION_NOT_ACTIVE' });
        const live = await order('fixture');
        await assert.rejects(execute(await award(live, 100, 'proportional')), {
          code: 'REFUND_BLOCKED',
          statusCode: 409,
        });
        assert.deepEqual(await counts(live), { refunds: 0, obligations: 0, executions: 0 });
        const [reader] = await sql`INSERT INTO admin_user(email,name,password_hash,permissions)
          VALUES (${randomUUID() + '@fixture.invalid'},'Staff','x','["admin.support.read","admin.payments.read"]'::jsonb) RETURNING id`;
        const s2 = await order();
        const d2 = await award(s2, 100, 'proportional');
        await assert.rejects(
          executeIncidentAward(
            sql,
            { kind: 'admin', id: reader.id },
            { decisionId: d2.id, digest: d2.preview.digest, requestKey: randomUUID() },
          ),
          { statusCode: 403 },
        );
      });
    } finally {
      await db.drop();
    }
  },
);
