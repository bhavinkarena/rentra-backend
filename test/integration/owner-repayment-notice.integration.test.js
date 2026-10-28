import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import { fileBackedRazorpay } from '../helpers/fake-razorpay.mjs';
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
} from '../../src/services/finance/owner-repayment.js';
import {
  recordOwnerNoticeEvent,
  confirmNoticeReceipt,
} from '../../src/services/finance/owner-repayment-notice.js';
import { listRecoveryCandidates } from '../../src/services/finance/owner-recovery.js';

const SECRET = 'owner-repayment-disposable-secret';
const env = {
  ...process.env,
  RAZORPAY_KEY_ID: 'rzp_test_REPAY218',
  RAZORPAY_KEY_SECRET: SECRET,
  RAZORPAY_WEBHOOK_SECRET: 'owner-repayment-disposable-webhook',
};

test(
  'Story 2.19 repayment notice receipt matrix',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    const file = join(mkdtempSync(join(tmpdir(), 'repay-')), 'rzp.json');
    const opts = { env, fetcher: fileBackedRazorpay(file) };
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

      const notice = async (r) =>
        (await sql`SELECT * FROM owner_repayment_notice WHERE recovery_id=${r.recoveryId}`)[0];
      const events = async (n) =>
        sql`SELECT * FROM owner_repayment_notice_event WHERE notice_id=${n.id} ORDER BY occurred_at`;
      const ownerNotice = async (r) =>
        (await listOwnerRepayments(sql, f.owner, { env })).items.find(
          (i) => i.recoveryId === r.recoveryId,
        ).notice;
      const ctx = { sessionId: randomUUID(), userAgent: 'node-test' };
      const viewIt = (r, key = randomUUID(), owner = f.owner) =>
        recordOwnerNoticeEvent(sql, owner, r.recoveryId, 'portal_view', { requestKey: key }, ctx);
      const ackIt = (r, key = randomUUID()) =>
        recordOwnerNoticeEvent(sql, f.owner, r.recoveryId, 'owner_ack', { requestKey: key }, ctx);
      const confirm = (r, extra, who = admin) =>
        confirmNoticeReceipt(sql, who, r.sourceId, {
          reason: 'Owner confirmed by phone call',
          requestKey: randomUUID(),
          ...extra,
        });
      const DAY = 86400000;
      const ms = (d) => new Date(d).getTime();

      const r = await recovery();
      const link = await create(r);

      await t.test(
        'link created, nothing seen: notice issued, no milestones; GET records nothing',
        async () => {
          const n = await notice(r);
          assert.ok(n.issued_at);
          assert.equal(n.received_at, null);
          assert.equal(n.due_at, null);
          assert.equal(n.reminder_at, null);
          const before = (await events(n)).length;
          const o = await ownerNotice(r);
          assert.equal(o.receivedAt, null);
          assert.equal(o.dueAt, null);
          assert.equal(o.reminderDue, false);
          assert.equal((await events(n)).length, before, 'GET list records no event');
          assert.equal(before, 0);
          const admins = await listRecoveryCandidates(sql, admin);
          assert.equal(admins.items.find((i) => i.sourceId === r.sourceId).notice.receivedAt, null);
        },
      );

      await t.test('another owner cannot view/ack: 404', async () => {
        await assert.rejects(viewIt(r, randomUUID(), f.other), { statusCode: 404 });
        await assert.rejects(
          recordOwnerNoticeEvent(sql, f.other, r.recoveryId, 'owner_ack', {
            requestKey: randomUUID(),
          }),
          { statusCode: 404 },
        );
        assert.equal((await events(await notice(r))).length, 0);
      });

      let viewed;
      await t.test(
        'owner view sets receipt, +5d reminder, +7d due; replay keeps one event',
        async () => {
          const key = randomUUID();
          viewed = await viewIt(r, key);
          assert.equal(viewed.receivedVia, 'portal_view');
          assert.equal(ms(viewed.reminderAt) - ms(viewed.receivedAt), 5 * DAY);
          assert.equal(ms(viewed.dueAt) - ms(viewed.receivedAt), 7 * DAY);
          assert.equal(viewed.version, 2);
          const again = await viewIt(r, key);
          assert.equal(again.replayed, true);
          assert.equal(again.receivedAt.getTime(), viewed.receivedAt.getTime());
          await assert.rejects(
            recordOwnerNoticeEvent(
              sql,
              f.owner,
              r.recoveryId,
              'owner_ack',
              { requestKey: key },
              ctx,
            ),
            { code: 'IDEMPOTENCY_CONFLICT' },
          );
          const ev = await events(await notice(r));
          assert.equal(ev.length, 1);
          assert.equal(ev[0].type, 'portal_view');
          assert.equal(ev[0].evidence.sessionId, ctx.sessionId);
          assert.equal(ev[0].evidence.userAgent, 'node-test');
        },
      );

      await t.test('ack after view: event appended, milestones unchanged', async () => {
        const key = randomUUID();
        const acked = await ackIt(r, key);
        assert.equal(acked.acknowledged, true);
        assert.equal(acked.version, viewed.version);
        assert.equal(acked.dueAt.getTime(), viewed.dueAt.getTime());
        await ackIt(r, key);
        assert.equal((await events(await notice(r))).length, 2);
      });

      await t.test('link replaced: notice and milestones unchanged', async () => {
        const before = await notice(r);
        const next = await create(r);
        assert.notEqual(next.id, link.id);
        const after = await notice(r);
        assert.equal(after.id, before.id);
        assert.equal(after.version, before.version);
        assert.equal(after.due_at.getTime(), before.due_at.getTime());
      });

      await t.test(
        'admin confirm: validation, permissions, stale, earlier, later, replay',
        async () => {
          const n = await notice(r);
          const at = (d) => new Date(d).toISOString();
          await assert.rejects(
            confirm(r, { receivedAt: at(Date.now() + DAY), expectedVersion: n.version }),
            {
              statusCode: 422,
            },
          );
          await assert.rejects(
            confirm(r, { receivedAt: at(ms(n.issued_at) - DAY), expectedVersion: n.version }),
            { statusCode: 422 },
          );
          await assert.rejects(
            confirm(
              r,
              { receivedAt: at(ms(n.issued_at) + 1), expectedVersion: n.version },
              { kind: 'admin', id: f.limited },
            ),
            { statusCode: 403 },
          );
          await assert.rejects(
            confirm(r, { receivedAt: at(ms(n.issued_at) + 1), expectedVersion: 99 }),
            {
              code: 'NOTICE_CHANGED',
            },
          );
          // Later than current: appended, nothing moves.
          const later = await confirm(r, {
            receivedAt: at(Date.now() - 1),
            expectedVersion: n.version,
          });
          assert.equal(later.version, n.version);
          assert.equal(later.receivedVia, 'portal_view');
          // Earlier than the view: milestones move earlier, version +1, audited.
          const earlierAt = at(ms(n.issued_at) + 1);
          const key = randomUUID();
          const body = { receivedAt: earlierAt, expectedVersion: n.version, requestKey: key };
          const moved = await confirm(r, body);
          assert.equal(moved.version, n.version + 1);
          assert.equal(moved.receivedVia, 'admin_confirmed');
          assert.equal(ms(moved.receivedAt), ms(earlierAt));
          assert.equal(ms(moved.dueAt), ms(earlierAt) + 7 * DAY);
          const replay = await confirm(r, body);
          assert.equal(replay.replayed, true);
          await assert.rejects(confirm(r, { ...body, reason: 'A different reason entirely' }), {
            code: 'IDEMPOTENCY_CONFLICT',
          });
          const audit =
            await sql`SELECT "before","after" FROM audit_log WHERE entity='owner_repayment_notice' AND entity_id=${n.id} ORDER BY at`;
          assert.equal(audit.length, 2, 'first receipt + move earlier');
          assert.equal(audit[1].after.receivedVia, 'admin_confirmed');
          const ev = await events(n);
          assert.equal(ev.length, 4);
          assert.equal(ev.filter((e) => e.type === 'admin_confirmed').length, 2);
          assert.ok(ev.every((e) => e.type && e.occurred_at && e.evidence));
          assert.equal(
            (
              await sql`SELECT recovered_minor::text r FROM owner_recovery WHERE id=${r.recoveryId}`
            )[0].r,
            '0',
            'debt untouched',
          );
        },
      );

      await t.test('events are append-only', async () => {
        const n = await notice(r);
        await assert.rejects(
          sql`UPDATE owner_repayment_notice_event SET type='owner_ack' WHERE notice_id=${n.id}`,
        );
        await assert.rejects(sql`DELETE FROM owner_repayment_notice_event WHERE notice_id=${n.id}`);
        await assert.rejects(sql`TRUNCATE owner_repayment_notice_event CASCADE`);
        assert.equal((await events(n)).length, 4);
      });
    } finally {
      await db.drop();
    }
  },
);
