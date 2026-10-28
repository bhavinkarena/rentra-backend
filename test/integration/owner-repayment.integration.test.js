import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  previewOwnerRecovery,
  assignOwnerRecovery,
} from '../../src/services/finance/owner-recovery.js';
import {
  createRepaymentLink,
  listOwnerRepayments,
  verifyOwnerRepayment,
  checkRepaymentLink,
  resolveRepaymentLink,
} from '../../src/services/finance/owner-repayment.js';

const SECRET = 'owner-repayment-disposable-secret';
const env = {
  ...process.env,
  RAZORPAY_KEY_ID: 'rzp_test_REPAY218',
  RAZORPAY_KEY_SECRET: SECRET,
  RAZORPAY_WEBHOOK_SECRET: 'owner-repayment-disposable-webhook',
};
const sign = (order, pay) => createHmac('sha256', SECRET).update(`${order}|${pay}`).digest('hex');

test(
  'Story 2.18 owner repayment link matrix',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    const file = join(mkdtempSync(join(tmpdir(), 'repay-')), 'rzp.json');
    const opts = { env, fetcher: fileBackedRazorpay(file) };
    const setPayment = (id, patch) => {
      const s = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(s.payments[id], patch);
      writeFileSync(file, JSON.stringify(s));
    };
    const orderCount = () =>
      existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8')).orders).length : 0;
    try {
      const f = await seedReviewFixture(sql),
        cash = await seedFinanceFixture(sql, f);
      const admin = { kind: 'admin', id: f.admin };
      const payout = payoutTransferProvider();
      payout.outcome = 'succeeded';
      const recovery = async (minor = 9000) => {
        const s = await cash.add('test');
        const fx = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          payout,
        );
        await dispatchPayoutTransfer(sql, admin, fx.id, {}, payout);
        await sql.begin(async (tx) => {
          const key = randomUUID();
          const [r] =
            await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,idempotency_key,request_hash)
            VALUES ('Fixture refund',${key},${s.transactionId},'fixture','test','real','INR','requested',${minor},${key},${'d'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor,actual_minor)
            VALUES (${r.id},${s.allocationId},${s.bookingId},'rent',${minor},${minor})`;
          await tx`UPDATE refund SET state='succeeded',actual_minor=expected_minor,verified_at=now(),provider_refund_id=${randomUUID()},evidence_hash=${'e'.repeat(64)} WHERE id=${r.id}`;
        });
        const p = await previewOwnerRecovery(sql, admin, s.allocationId);
        const a = await assignOwnerRecovery(sql, admin, s.allocationId, {
          hash: p.hash,
          expectedVersion: 0,
          requestKey: randomUUID(),
          reason: 'Guest refund after Test payout',
        });
        return { s, sourceId: s.allocationId, recoveryId: a.recoveryId, version: a.version };
      };
      const recovered = async (id) =>
        (await sql`SELECT recovered_minor::text r FROM owner_recovery WHERE id=${id}`)[0].r;
      const create = async (r, extra = {}) => {
        const p = await previewOwnerRecovery(sql, admin, r.sourceId);
        return createRepaymentLink(
          sql,
          admin,
          r.sourceId,
          { hash: p.hash, expectedVersion: p.version, requestKey: randomUUID(), ...extra },
          opts,
        );
      };
      const verify = (link, payId) =>
        verifyOwnerRepayment(
          sql,
          f.owner,
          link.id,
          { paymentId: payId, signature: sign(link.providerOrderId, payId) },
          opts,
        );
      const pay = (link, payId, amount) => {
        providerCaptures(file, link.providerOrderId, payId, amount);
        return verifyOwnerRepayment(
          sql,
          f.owner,
          link.id,
          { paymentId: payId, signature: sign(link.providerOrderId, payId) },
          opts,
        );
      };

      await t.test('create, replay, conflict, stale, pay once', async () => {
        const r = await recovery();
        const before = orderCount();
        await assert.rejects(create(r, { expectedVersion: 99 }), {
          code: 'RECOVERY_CHANGED',
        });
        assert.equal(orderCount(), before, 'no order on stale version');
        const key = randomUUID();
        const link = await create(r, { requestKey: key });
        assert.equal(link.state, 'open');
        assert.equal(link.amountMinor, '9000');
        assert.equal(link.environment, 'test');
        assert.match(link.providerOrderId, /^order_FAKE/);
        assert.equal((await create(r, { requestKey: key })).id, link.id);
        await assert.rejects(create(r, { requestKey: key, expectedVersion: 99 }), {
          code: 'IDEMPOTENCY_CONFLICT',
        });
        assert.equal(await recovered(r.recoveryId), '0', 'creating a link collects nothing');
        const list = await listOwnerRepayments(sql, f.owner, { env });
        assert.ok(list.items.some((i) => i.id === link.id));
        assert.equal(list.keyId, 'rzp_test_REPAY218');
        assert.equal((await listOwnerRepayments(sql, f.other, { env })).items.length, 0);
        await assert.rejects(
          verifyOwnerRepayment(
            sql,
            f.other,
            link.id,
            { paymentId: 'pay_X', signature: 'a'.repeat(64) },
            opts,
          ),
          { statusCode: 404 },
        );
        await assert.rejects(
          verifyOwnerRepayment(
            sql,
            f.owner,
            link.id,
            { paymentId: 'pay_BAD1', signature: 'a'.repeat(64) },
            opts,
          ),
          { code: 'INVALID_SIGNATURE' },
        );
        await assert.rejects(
          verifyOwnerRepayment(
            sql,
            f.owner,
            link.id,
            { paymentId: 'pay_BAD2', signature: sign('order_OTHER', 'pay_BAD2') },
            opts,
          ),
          { code: 'INVALID_SIGNATURE' },
        );
        assert.equal(await recovered(r.recoveryId), '0');
        const paid = await pay(link, 'pay_OK1');
        assert.equal(paid.state, 'paid');
        assert.equal(await recovered(r.recoveryId), '9000');
        const again = await verifyOwnerRepayment(
          sql,
          f.owner,
          link.id,
          { paymentId: 'pay_OK1', signature: sign(link.providerOrderId, 'pay_OK1') },
          opts,
        );
        assert.equal(again.state, 'paid');
        assert.equal(await recovered(r.recoveryId), '9000', 'counted once');
        const p = await previewOwnerRecovery(sql, admin, r.sourceId);
        assert.equal(p.outstandingMinor, '0');
        assert.equal(p.link.state, 'paid');
        const n = orderCount();
        await assert.rejects(create(r), { code: 'NOTHING_TO_COLLECT' });
        assert.equal(orderCount(), n);
        const audits =
          await sql`SELECT action FROM audit_log WHERE entity='owner_repayment' AND entity_id=${link.id} ORDER BY action='owner_repayment_paid'`;
        assert.deepEqual(
          audits.map((a) => a.action),
          ['owner_repayment_created', 'owner_repayment_paid'],
        );
      });

      await t.test('replace with and without provider payment', async () => {
        const r = await recovery(5000);
        const first = await create(r);
        const second = await create(r);
        assert.equal(second.amountMinor, '5000');
        const [old] = await sql`SELECT state FROM owner_repayment WHERE id=${first.id}`;
        assert.equal(old.state, 'replaced');
        providerCaptures(file, second.providerOrderId, 'pay_INFLIGHT');
        setPayment('pay_INFLIGHT', { status: 'authorized', captured: false });
        const snap = async () =>
          sql`SELECT id,state FROM owner_repayment WHERE recovery_id=${r.recoveryId} ORDER BY id`;
        const s0 = await snap();
        await assert.rejects(create(r), { code: 'REPAYMENT_IN_FLIGHT' });
        setPayment('pay_INFLIGHT', { status: 'captured', captured: true });
        await assert.rejects(create(r), { code: 'REPAYMENT_IN_FLIGHT' });
        assert.deepEqual(await snap(), s0, 'nothing changes');
        const unknown = await verify(first, 'pay_OLD');
        assert.equal(unknown.paymentStatus, 'pending');
        assert.deepEqual(await snap(), s0, 'unverified payment on a replaced link changes nothing');
      });

      await t.test('capture racing a replacement still settles the replaced link', async () => {
        const r = await recovery(5000);
        const first = await create(r);
        const second = await create(r);
        // The owner paid the old order after the provider check passed.
        providerCaptures(file, first.providerOrderId, 'pay_RACE');
        const out = await verify(first, 'pay_RACE');
        assert.equal(out.state, 'paid');
        assert.equal(await recovered(r.recoveryId), '5000');
        assert.equal((await previewOwnerRecovery(sql, admin, r.sourceId)).outstandingMinor, '0');
        // The unpaid replacement is closed and leaves the owner panel.
        const [closed] = await sql`SELECT state FROM owner_repayment WHERE id=${second.id}`;
        assert.equal(closed.state, 'replaced');
        const panel = await listOwnerRepayments(sql, f.owner, { env });
        assert.ok(!panel.items.some((i) => i.id === second.id));
        // A capture that still lands on it yields excess, never double counting.
        const out2 = await pay(second, 'pay_RACE2');
        assert.equal(out2.state, 'paid');
        assert.equal(out2.excessMinor, '5000');
        assert.equal(await recovered(r.recoveryId), '5000');
      });

      await t.test('parallel double verify counts once and bumps version once', async () => {
        const r = await recovery(3000);
        const link = await create(r);
        providerCaptures(file, link.providerOrderId, 'pay_PAR');
        const v0 = (await previewOwnerRecovery(sql, admin, r.sourceId)).version;
        const [a, b] = await Promise.all([verify(link, 'pay_PAR'), verify(link, 'pay_PAR')]);
        assert.equal(a.state, 'paid');
        assert.equal(b.state, 'paid');
        assert.equal(await recovered(r.recoveryId), '3000');
        assert.equal((await previewOwnerRecovery(sql, admin, r.sourceId)).version, v0 + 1);
      });

      await t.test('amount mismatch reviews; authorized stays open; admin check', async () => {
        const r = await recovery(4000);
        const link = await create(r);
        const out = await pay(link, 'pay_SHORT', 3000);
        assert.equal(out.state, 'needs_review');
        assert.equal(out.reviewCode, 'PROVIDER_PAYMENT_MISMATCH');
        assert.equal(await recovered(r.recoveryId), '0');
        const replay = await verifyOwnerRepayment(
          sql,
          f.owner,
          link.id,
          { paymentId: 'pay_SHORT', signature: sign(link.providerOrderId, 'pay_SHORT') },
          opts,
        );
        assert.equal(replay.state, 'needs_review');

        const r2 = await recovery(4100);
        const l2 = await create(r2);
        providerCaptures(file, l2.providerOrderId, 'pay_AUTH');
        setPayment('pay_AUTH', { status: 'authorized', captured: false });
        const out2 = await verifyOwnerRepayment(
          sql,
          f.owner,
          l2.id,
          { paymentId: 'pay_AUTH', signature: sign(l2.providerOrderId, 'pay_AUTH') },
          opts,
        );
        assert.equal(out2.state, 'open', 'authorized stays open');
        assert.equal(out2.paymentStatus, 'pending');
        assert.equal(await recovered(r2.recoveryId), '0');
        const out3 = await verifyOwnerRepayment(
          sql,
          f.owner,
          l2.id,
          { paymentId: 'pay_MISSING', signature: 'x' },
          opts,
        ).catch((e) => e);
        assert.equal(out3.statusCode, 400);
        // Provider captures later; the owner's retry settles it.
        setPayment('pay_AUTH', { status: 'captured', captured: true });
        assert.equal((await verify(l2, 'pay_AUTH')).state, 'paid');
        assert.equal(await recovered(r2.recoveryId), '4100');

        // needs_review blocks a new link; admin check keeps a mismatch, settles an exact capture.
        await assert.rejects(create(r), { code: 'REPAYMENT_IN_FLIGHT' });
        let checked = await checkRepaymentLink(sql, admin, r.sourceId, opts);
        assert.equal(checked.settled.length, 0);
        assert.equal(checked.links[0].state, 'needs_review');
        setPayment('pay_SHORT', { amount: 4000 });
        checked = await checkRepaymentLink(sql, admin, r.sourceId, opts);
        assert.equal(checked.settled.length, 1);
        assert.equal(checked.links[0].state, 'paid');
        assert.equal(await recovered(r.recoveryId), '4000');
        await assert.rejects(
          checkRepaymentLink(sql, { kind: 'admin', id: f.limited }, r.sourceId, opts),
          {
            statusCode: 403,
          },
        );
      });

      await t.test('admin closes a needs_review link without a capture', async () => {
        const r = await recovery(2500);
        const link = await create(r);
        const ghost = await verify(link, 'pay_GHOST'); // provider has no such payment: unknown
        assert.equal(ghost.state, 'needs_review');
        const body = { linkId: link.id, reason: 'Provider shows no payment' };
        await assert.rejects(
          resolveRepaymentLink(sql, { kind: 'admin', id: f.limited }, r.sourceId, body, opts),
          { statusCode: 403 },
        );
        await assert.rejects(
          resolveRepaymentLink(sql, admin, r.sourceId, { ...body, reason: 'short' }, opts),
          { statusCode: 422 },
        );
        // Authorized (not captured) refuses the close.
        providerCaptures(file, link.providerOrderId, 'pay_HOLD');
        setPayment('pay_HOLD', { status: 'authorized', captured: false });
        await assert.rejects(resolveRepaymentLink(sql, admin, r.sourceId, body, opts), {
          code: 'REPAYMENT_IN_FLIGHT',
        });
        setPayment('pay_HOLD', { status: 'failed', captured: false });
        // A wrong-amount capture closes the link and holds the whole amount as excess.
        providerCaptures(file, link.providerOrderId, 'pay_ODD', 3100);
        const closed = await resolveRepaymentLink(sql, admin, r.sourceId, body, opts);
        assert.equal(closed.state, 'replaced');
        assert.equal(closed.providerPaymentId, 'pay_ODD');
        assert.equal(closed.excessMinor, '3100');
        assert.equal(closed.reviewCode, 'PROVIDER_OUTCOME_UNKNOWN', 'review code kept');
        assert.equal(await recovered(r.recoveryId), '0', 'closing never changes what is due');
        const [audit] =
          await sql`SELECT reason FROM audit_log WHERE entity_id=${link.id} AND action='owner_repayment_closed'`;
        assert.equal(audit.reason, 'Provider shows no payment');
        await assert.rejects(resolveRepaymentLink(sql, admin, r.sourceId, body, opts), {
          code: 'LINK_NOT_IN_REVIEW',
        });
        const next = await create(r);
        assert.equal(next.amountMinor, '2500');

        // Exact capture found at close time settles instead.
        const r2 = await recovery(2600);
        const l2 = await create(r2);
        await verify(l2, 'pay_GHOST2');
        providerCaptures(file, l2.providerOrderId, 'pay_LATE');
        const out = await resolveRepaymentLink(
          sql,
          admin,
          r2.sourceId,
          { ...body, linkId: l2.id },
          opts,
        );
        assert.equal(out.state, 'paid');
        assert.equal(await recovered(r2.recoveryId), '2600');
      });

      await t.test('obligation dropped below paid amount stores excess', async () => {
        const r = await recovery(9000);
        const link = await create(r);
        await sql`UPDATE owner_recovery SET obligation_minor=6000 WHERE id=${r.recoveryId}`;
        const out = await pay(link, 'pay_EXCESS');
        assert.equal(out.state, 'paid');
        assert.equal(out.excessMinor, '3000');
        assert.equal(await recovered(r.recoveryId), '6000');
      });

      await t.test('non-finance admin is refused', async () => {
        const [r] = await sql`SELECT o.source_id,o.version FROM owner_recovery o LIMIT 1`;
        await assert.rejects(
          createRepaymentLink(
            sql,
            { kind: 'admin', id: f.limited },
            r.source_id,
            { hash: 'a'.repeat(64), expectedVersion: r.version, requestKey: randomUUID() },
            opts,
          ),
          { statusCode: 403 },
        );
      });

      await t.test('new routes send private, no-store', async () => {
        globalThis.__rentraSql = sql;
        const a = await import('../../src/controllers/hotel-finance.controller.js');
        const o = await import('../../src/controllers/finance.controller.js');
        for (const handler of [
          a.ownerRecoveryRepaymentLink,
          a.ownerRecoveryRepaymentCheck,
          a.ownerRecoveryRepaymentResolve,
          o.repayments,
          o.repaymentVerify,
        ]) {
          const headers = {};
          const res = { set: (k, v) => ((headers[k] = v), res), success: () => res };
          let failure;
          await handler(
            { params: { sourceId: randomUUID(), id: randomUUID() }, body: {}, baseUrl: '/partner' },
            res,
            (e) => {
              failure = e;
            },
          );
          assert.ok(failure);
          assert.equal(headers['Cache-Control'], 'private, no-store');
        }
      });
    } finally {
      await db.drop();
    }
  },
);
