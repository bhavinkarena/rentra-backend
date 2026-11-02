import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import { reservePayoutTransfer, dispatchPayoutTransfer } from '../../src/services/finance/payout-transfer-fixtures.js';
import { previewIncidentRemedy, decideIncidentRemedy, executeIncidentAward } from '../../src/services/support/remedy.js';
import { readSupportRequest } from '../../src/services/support/service.js';
import { listOwnerRepayments, createIncidentRepaymentLink } from '../../src/services/finance/owner-repayment.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileBackedRazorpay } from '../helpers/fake-razorpay.mjs';

const env = { ...process.env, RAZORPAY_KEY_ID: 'rzp_test_INCIDENT46', RAZORPAY_KEY_SECRET: 'x' };
const PRIVATE = ['Internal only: owner is difficult', 'Bathroom photo evidence text'];

test('Story 4.6 case and money resolution views', { skip: !process.env.PORTAL_TEST_DATABASE_URL }, async (t) => {
  const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const sql = db.sql;
  try {
    const f = await seedReviewFixture(sql),
      cash = await seedFinanceFixture(sql, f);
    const admin = { kind: 'admin', id: f.admin };
    const order = async () => {
      const s = await cash.add('test', { provider: 'razorpay' });
      const [{ customer_id }] = await sql`SELECT customer_id FROM booking_order WHERE id=${s.orderId}`;
      const key = randomUUID();
      const [c] = await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
        VALUES (${'SUP-' + key.slice(0, 12)},${customer_id},${s.orderId},'stay_issue','Dirty room',
        ${JSON.stringify({ stayIssue: { affected: [{ visitId: s.bookingId }], details: PRIVATE[1] } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',now(),false) RETURNING id,reference`;
      await sql`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash,internal) VALUES (${c.id},'admin',${f.admin},${PRIVATE[0]},'open',${randomUUID()},${'b'.repeat(64)},true)`;
      const [session] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${customer_id},now()+interval '1 day') RETURNING id`;
      const guest = { kind: 'customer', session: { role: 'customer', userId: customer_id, sessionId: session.id } };
      return { ...s, caseId: c.id, caseRef: c.reference, guest, customerId: customer_id };
    };
    const award = async (s, targetPct, responsibility) => {
      const p = await previewIncidentRemedy(sql, admin, { supportRequestId: s.caseId, targetPct, responsibility });
      return decideIncidentRemedy(sql, admin, { supportRequestId: s.caseId, kind: 'award', reason: 'Owner funded: host ignored repeat reports',
        targetPct, responsibility, visitIds: p.visitIds, digest: p.digest, requestKey: randomUUID() });
    };
    const execute = (d) => executeIncidentAward(sql, admin, { decisionId: d.id, digest: d.preview.digest, requestKey: randomUUID() });
    const guestView = async (s) => {
      const read = await readSupportRequest(sql, s.guest, s.caseId);
      const json = JSON.stringify(read);
      for (const p of [PRIVATE[0], 'owner_funded', 'obligation', 'responsibility', 'host ignored']) assert.ok(!json.includes(p), `guest payload leaks ${p}`);
      return read.resolution;
    };
    const payout = async (s) => {
      const provider = payoutTransferProvider();
      provider.outcome = 'succeeded';
      const fx = await reservePayoutTransfer(sql, admin, { sourceId: s.allocationId, requestKey: randomUUID() }, provider);
      await dispatchPayoutTransfer(sql, admin, fx.id, {}, provider);
    };

    await t.test('open case: under review, owner sees nothing', async () => {
      const s = await order();
      assert.deepEqual(await guestView(s), { reference: s.caseRef, outcome: { status: 'under_review' }, refunds: [] });
      assert.equal((await listOwnerRepayments(sql, f.owner, { env })).incidents.length, 0);
    });

    await t.test('deny: declined with reason, no refund', async () => {
      const s = await order();
      await decideIncidentRemedy(sql, admin, { supportRequestId: s.caseId, kind: 'deny', reason: 'Photos show a clean room', requestKey: randomUUID() });
      const r = (await readSupportRequest(sql, s.guest, s.caseId)).resolution;
      assert.deepEqual(r.outcome, { status: 'declined', reason: 'Photos show a clean room' });
      assert.deepEqual(r.refunds, []);
    });

    await t.test('award saved not executed; executed refund queued -> refunded; unknown -> needs attention', async () => {
      const s = await order();
      const d = await award(s, 50, 'proportional');
      assert.deepEqual((await guestView(s)).outcome, { status: 'approved', targetPct: 50, executed: false });
      assert.deepEqual((await guestView(s)).refunds, []);
      assert.equal((await guestView(s)).outcome.earlierRefund, undefined);
      const e = await execute(d);
      let g = await guestView(s);
      assert.deepEqual(g.outcome, { status: 'approved', targetPct: 50, executed: true });
      assert.deepEqual(g.refunds, [{ reference: e.refunds[0].reference, amountMinor: e.refunds[0].amountMinor, status: 'queued' }]);
      const id = e.refunds[0].id;
      await sql`UPDATE refund SET state='unknown' WHERE id=${id}`;
      g = await guestView(s);
      assert.equal(g.refunds[0].status, 'needs_attention');
      assert.equal(g.refunds[0].reference, e.refunds[0].reference);
      const a = (await readSupportRequest(sql, admin, s.caseId)).remedy.executions[0].refunds[0];
      assert.equal(a.status, 'unknown');
      assert.equal(a.needsInvestigation, true);
      await sql.begin(async (tx) => {
        await tx`UPDATE refund_allocation SET actual_minor=expected_minor WHERE refund_id=${id}`;
        await tx`UPDATE refund SET state='succeeded',actual_minor=expected_minor,verified_at=now(),provider_refund_id='rfnd_t46',evidence_hash=${'e'.repeat(64)} WHERE id=${id}`;
      });
      assert.equal((await guestView(s)).refunds[0].status, 'refunded');
      assert.equal((await readSupportRequest(sql, admin, s.caseId)).remedy.executions[0].refunds[0].needsInvestigation, false);
      // Proportional executed: owner sees nothing.
      assert.equal((await listOwnerRepayments(sql, f.owner, { env })).incidents.length, 0);
      // Superseded executed award: the queued refund stays visible to the guest.
      await decideIncidentRemedy(sql, admin, { supportRequestId: s.caseId, kind: 'deny', reason: 'Reconsidered after inspection', requestKey: randomUUID() });
      g = await guestView(s);
      assert.equal(g.outcome.status, 'declined');
      assert.equal(g.outcome.earlierRefund, true);
      assert.equal(g.refunds.length, 1);
    });

    await t.test('failure_code on the latest attempt: admin needs_review, guest needs_attention', async () => {
      const s = await order();
      const e = await execute(await award(s, 50, 'proportional'));
      const id = e.refunds[0].id;
      await sql`INSERT INTO refund_execution(refund_id,dispatched_at,failure_code) VALUES (${id},now(),'PROVIDER_REFUND_FAILED')
        ON CONFLICT (refund_id) DO UPDATE SET dispatched_at=now(),failure_code='PROVIDER_REFUND_FAILED'`;
      await sql`UPDATE refund SET state='processing' WHERE id=${id}`;
      const a = (await readSupportRequest(sql, admin, s.caseId)).remedy.executions[0].refunds[0];
      assert.equal(a.status, 'needs_review');
      assert.equal(a.needsInvestigation, true);
      assert.equal((await guestView(s)).refunds[0].status, 'needs_attention');
    });

    await t.test('owner_funded executed: owner sees ref, outcome, reason, obligation; never guest data', async () => {
      const s = await order();
      await payout(s);
      const e = await execute(await award(s, 100, 'owner_funded'));
      assert.ok(e.obligation);
      const list = await listOwnerRepayments(sql, f.owner, { env });
      const i = list.incidents.find((x) => x.obligation.id === e.obligation.id);
      assert.equal(i.reference, s.caseRef);
      assert.deepEqual(i.outcome, { kind: 'award', targetPct: 100, responsibility: 'owner_funded' });
      assert.equal(i.reason, 'Owner funded: host ignored repeat reports');
      assert.equal(i.obligation.amountMinor, e.obligation.amountMinor);
      assert.equal(i.obligation.state, 'due');
      assert.equal(i.obligation.link, null);
      const json = JSON.stringify(list);
      for (const p of [...PRIVATE, s.customerId]) assert.ok(!json.includes(p), `owner payload leaks ${p}`);
      // Open repayment link: the item carries the incident; unrelated items carry null.
      const opts = { env, fetcher: fileBackedRazorpay(join(mkdtempSync(join(tmpdir(), 'inc46-')), 'rzp.json')) };
      await createIncidentRepaymentLink(sql, admin, s.caseId, e.obligation.id, { requestKey: randomUUID() }, opts);
      const after = await listOwnerRepayments(sql, f.owner, { env });
      const item = after.items.find((x) => x.incidentObligationId === e.obligation.id);
      assert.deepEqual(item.incident, { reference: s.caseRef, outcome: { kind: 'award', targetPct: 100, responsibility: 'owner_funded' }, reason: 'Owner funded: host ignored repeat reports' });
      assert.ok(after.items.filter((x) => !x.incidentObligationId).every((x) => x.incident === null));
      assert.ok(!after.incidents.some((x) => x.obligation.id === e.obligation.id), 'linked obligation not repeated');
      // Superseded executed award: flagged for the owner, obligation still listed.
      await decideIncidentRemedy(sql, admin, { supportRequestId: s.caseId, kind: 'deny', reason: 'Reconsidered after inspection', requestKey: randomUUID() });
      const sup = (await listOwnerRepayments(sql, f.owner, { env })).items.find((x) => x.incidentObligationId === e.obligation.id);
      assert.equal(sup.incident.outcome.superseded, true);
      assert.equal(sup.incident.outcome.currentKind, 'deny');
      // Another owner sees nothing; another customer gets 404.
      assert.equal((await listOwnerRepayments(sql, randomUUID(), { env })).incidents.length, 0);
      const [u] = await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${randomUUID() + '@fixture.invalid'},'customer','active','Other Guest') RETURNING id`;
      const [session] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${u.id},now()+interval '1 day') RETURNING id`;
      await assert.rejects(readSupportRequest(sql, { kind: 'customer', session: { role: 'customer', userId: u.id, sessionId: session.id } }, s.caseId), { statusCode: 404 });
    });
  } finally {
    await db.drop();
  }
});
