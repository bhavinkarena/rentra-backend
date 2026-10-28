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
import {
  listRecoveryCandidates,
  previewOwnerRecovery,
  assignOwnerRecovery,
} from '../../src/services/finance/owner-recovery.js';

test(
  'Story 2.17 owner recovery assignment matrix',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        cash = await seedFinanceFixture(sql, f);
      const admin = { kind: 'admin', id: f.admin };
      const provider = payoutTransferProvider();
      const refund = (s, minor, { component = 'rent', allocationId = s.allocationId } = {}) =>
        sql.begin(async (tx) => {
          const key = randomUUID();
          const [r] =
            await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,idempotency_key,request_hash)
          VALUES ('Fixture refund',${key},${s.transactionId},'fixture','test','real','INR','requested',${minor},${key},${'d'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
          VALUES (${r.id},${allocationId},${s.bookingId},${component},${minor})`;
          return r.id;
        });
      const setState = (id, state) =>
        sql.begin(async (tx) => {
          if (state === 'succeeded') {
            await tx`UPDATE refund_allocation SET actual_minor=expected_minor WHERE refund_id=${id}`;
            await tx`UPDATE refund SET state='succeeded',actual_minor=expected_minor,verified_at=now(),provider_refund_id=${randomUUID()},evidence_hash=${'e'.repeat(64)} WHERE id=${id}`;
          } else await tx`UPDATE refund SET state=${state} WHERE id=${id}`;
        });
      const paidRefund = async (s, minor, opts) => {
        const id = await refund(s, minor, opts);
        await setState(id, 'succeeded');
        return id;
      };
      const fixture = async (s, outcome = 'succeeded') => {
        provider.outcome = outcome;
        const row = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          provider,
        );
        if (outcome !== 'reserved') await dispatchPayoutTransfer(sql, admin, row.id, {}, provider);
        return row;
      };
      const assign = (s, p, extra = {}) =>
        assignOwnerRecovery(sql, admin, s.allocationId, {
          hash: p.hash,
          expectedVersion: p.version,
          requestKey: randomUUID(),
          reason: 'Guest refund after Test payout',
          ...extra,
        });
      const snapshots =
        () => sql`SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM refund r) refunds,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM refund_allocation a) allocations,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM payout_transfer_fixture x) fixtures,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payout p) payouts`;

      await t.test('full refund after succeeded fixture (fixture 9000) and re-assign', async () => {
        const s = await cash.add('test');
        await paidRefund(s, 91000); // before the fixture: not the owner's
        const fx = await fixture(s);
        assert.equal(String(fx.expected_minor), '9000');
        await paidRefund(s, 4000);
        let p = await previewOwnerRecovery(sql, admin, s.allocationId);
        assert.equal(p.paidMinor, '9000');
        assert.equal(p.obligationMinor, '4000');
        assert.equal(p.version, 0);
        const before = await snapshots();
        const key = randomUUID();
        const body = {
          hash: p.hash,
          expectedVersion: 0,
          requestKey: key,
          reason: 'Guest refund after Test payout',
        };
        const first = await assignOwnerRecovery(sql, admin, s.allocationId, body);
        assert.equal(first.obligationMinor, '4000');
        assert.equal(first.version, 1);
        assert.deepEqual(await snapshots(), before, 'refunds, fixtures and payouts untouched');
        const replay = await assignOwnerRecovery(sql, admin, s.allocationId, body);
        assert.equal(replay.replayed, true);
        assert.equal(replay.recoveryId, first.recoveryId);
        await assert.rejects(
          assignOwnerRecovery(sql, admin, s.allocationId, {
            ...body,
            reason: 'A different reason here',
          }),
          {
            code: 'IDEMPOTENCY_CONFLICT',
          },
        );
        // Stale preview: more refund succeeds after preview.
        p = await previewOwnerRecovery(sql, admin, s.allocationId);
        await paidRefund(s, 5000);
        const count = async () =>
          (await sql`SELECT count(*)::int n FROM owner_recovery_adjustment`)[0].n;
        const n = await count();
        await assert.rejects(assign(s, p), { code: 'RECOVERY_CHANGED' });
        await assert.rejects(
          assign(s, { ...(await previewOwnerRecovery(sql, admin, s.allocationId)), version: 0 }),
          {
            code: 'RECOVERY_CHANGED',
          },
        );
        assert.equal(await count(), n, 'nothing written');
        p = await previewOwnerRecovery(sql, admin, s.allocationId);
        assert.equal(p.obligationMinor, '9000');
        const beforeSecond = await snapshots();
        const second = await assign(s, p);
        assert.deepEqual(await snapshots(), beforeSecond, 'rows untouched after re-assign');
        assert.equal(second.version, 2);
        assert.equal(second.obligationMinor, '9000');
        const [adj] =
          await sql`SELECT "before","after" FROM owner_recovery_adjustment WHERE recovery_id=${first.recoveryId} AND version=2`;
        assert.equal(adj.before.obligationMinor, '4000');
        assert.equal(adj.after.obligationMinor, '9000');
        const audits =
          await sql`SELECT 1 FROM audit_log WHERE entity='owner_recovery' AND entity_id=${first.recoveryId}`;
        assert.equal(audits.length, 2);
        await assert.rejects(
          sql`UPDATE owner_recovery_adjustment SET reason='tampered reason'`,
          /append-only/,
        );
        await assert.rejects(sql`DELETE FROM owner_recovery_adjustment`, /append-only/);
        await assert.rejects(sql`TRUNCATE owner_recovery_adjustment CASCADE`, /append-only/);
        await assert.rejects(assign(s, await previewOwnerRecovery(sql, admin, s.allocationId)), {
          code: 'NOTHING_TO_ASSIGN',
        });
      });

      await t.test('partial, fee excluded', async () => {
        const s = await cash.add('test');
        await fixture(s);
        await paidRefund(s, 4000);
        await paidRefund(s, 500, { component: 'fee', allocationId: s.feeAllocationId });
        const p = await previewOwnerRecovery(sql, admin, s.allocationId);
        assert.equal(p.obligationMinor, '4000');
        assert.equal((await assign(s, p)).obligationMinor, '4000');
      });

      await t.test('concurrent same-key assign records one version', async () => {
        const s = await cash.add('test');
        await fixture(s);
        await paidRefund(s, 7000);
        const p = await previewOwnerRecovery(sql, admin, s.allocationId);
        const body = {
          hash: p.hash,
          expectedVersion: 0,
          requestKey: randomUUID(),
          reason: 'Concurrent same key assign',
        };
        const [a, b] = await Promise.all([
          assignOwnerRecovery(sql, admin, s.allocationId, body),
          assignOwnerRecovery(sql, admin, s.allocationId, body),
        ]);
        assert.equal(a.recoveryId, b.recoveryId);
        assert.equal(a.version, 1);
        assert.equal(b.version, 1);
        assert.equal(a.obligationMinor, '7000');
        assert.equal(b.obligationMinor, '7000');
        const [row] =
          await sql`SELECT version FROM owner_recovery WHERE source_id=${s.allocationId}`;
        assert.equal(row.version, 1);
      });

      await t.test(
        'refund requested before fixture and succeeded after it is not counted',
        async () => {
          const s = await cash.add('test');
          const id = await refund(s, 5000);
          const fx = await fixture(s);
          assert.equal(String(fx.expected_minor), '95000');
          await setState(id, 'succeeded');
          await assert.rejects(previewOwnerRecovery(sql, admin, s.allocationId), {
            statusCode: 404,
          });
        },
      );

      await t.test('rent refund after reserve but before verification', async () => {
        const s = await cash.add('test');
        provider.outcome = 'succeeded';
        const fx = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          provider,
        );
        await paidRefund(s, 6000);
        // 0078 pins expected_minor at reserve; dispatch refuses changed terms, so the fixture never succeeds.
        await assert.rejects(dispatchPayoutTransfer(sql, admin, fx.id, {}, provider), {
          code: 'STALE_PREVIEW',
        });
        const [row] = await sql`SELECT state FROM payout_transfer_fixture WHERE id=${fx.id}`;
        assert.equal(row.state, 'reserved');
        await assert.rejects(previewOwnerRecovery(sql, admin, s.allocationId), { statusCode: 404 });
      });

      await t.test('fee-only refund after fixture is not a candidate', async () => {
        const s = await cash.add('test');
        await fixture(s);
        await paidRefund(s, 500, { component: 'fee', allocationId: s.feeAllocationId });
        await assert.rejects(previewOwnerRecovery(sql, admin, s.allocationId), { statusCode: 404 });
      });

      await t.test('refund before fixture only is not a candidate', async () => {
        const s = await cash.add('test');
        await paidRefund(s, 3000);
        await fixture(s);
        await assert.rejects(previewOwnerRecovery(sql, admin, s.allocationId), { statusCode: 404 });
        const list = await listRecoveryCandidates(sql, admin);
        assert.ok(!list.items.some((i) => i.sourceId === s.allocationId));
      });

      await t.test('uncertain refund is reserved only and cannot be assigned', async () => {
        const s = await cash.add('test');
        await fixture(s);
        const id = await refund(s, 2500);
        await setState(id, 'processing');
        const p = await previewOwnerRecovery(sql, admin, s.allocationId);
        assert.equal(p.obligationMinor, '0');
        assert.equal(p.reservedMinor, '2500');
        await assert.rejects(assign(s, p), { code: 'NOTHING_TO_ASSIGN' });
        const list = await listRecoveryCandidates(sql, admin);
        assert.ok(list.items.find((i) => i.sourceId === s.allocationId).environment === 'test');
      });

      await t.test('fixture not succeeded is not a candidate', async () => {
        for (const state of ['reserved', 'unknown', 'processing']) {
          const s = await cash.add('test');
          // A failed provider lookup leaves the fixture unknown.
          const fx = await fixture(s, state === 'reserved' ? 'reserved' : 'failed');
          if (state === 'processing')
            // The guard forbids unknown -> processing; replica mode models a claim whose dispatch never finished.
            await sql.begin(async (tx) => {
              await tx`SET LOCAL session_replication_role = replica`;
              await tx`UPDATE payout_transfer_fixture SET state='processing' WHERE id=${fx.id}`;
            });
          const [real] = await sql`SELECT state FROM payout_transfer_fixture WHERE id=${fx.id}`;
          assert.equal(real.state, state);
          await paidRefund(s, 1000);
          await assert.rejects(previewOwnerRecovery(sql, admin, s.allocationId), {
            statusCode: 404,
          });
        }
      });

      await t.test('non-finance admin and owner are refused', async () => {
        const s = (await listRecoveryCandidates(sql, admin)).items[0];
        for (const actor of [
          { kind: 'admin', id: f.limited },
          { kind: 'owner', id: f.owner },
        ]) {
          await assert.rejects(listRecoveryCandidates(sql, actor), { statusCode: 403 });
          await assert.rejects(previewOwnerRecovery(sql, actor, s.sourceId), { statusCode: 403 });
          await assert.rejects(
            assignOwnerRecovery(sql, actor, s.sourceId, {
              hash: s.hash,
              expectedVersion: s.version,
              requestKey: randomUUID(),
              reason: 'Not allowed to do this',
            }),
            { statusCode: 403 },
          );
        }
      });
      await t.test('all three routes send private, no-store through the controller', async () => {
        globalThis.__rentraSql = sql;
        const c = await import('../../src/controllers/hotel-finance.controller.js');
        for (const handler of [c.ownerRecoveries, c.ownerRecovery, c.ownerRecoveryAssign]) {
          const headers = {};
          const res = {
            set: (k, v) => {
              headers[k] = v;
              return res;
            },
            success: () => res,
          };
          let failure;
          // No admin session: the handler fails after the header is set; the error goes to next.
          await handler({ params: { sourceId: randomUUID() }, body: {} }, res, (e) => {
            failure = e;
          });
          assert.ok(failure);
          assert.equal(headers['Cache-Control'], 'private, no-store');
        }
      });
    } finally {
      await db.drop();
    }
  },
);
