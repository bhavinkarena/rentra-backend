import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import {
  previewPayoutTransfer,
  reservePayoutTransfer,
  dispatchPayoutTransfer,
  reconcilePayoutTransfer,
  readPayoutTransfers,
} from '../../src/services/finance/payout-transfer-fixtures.js';
import {
  financeAllocation,
  financeStatement,
  financeCsv,
} from '../../src/services/finance/statements.js';
import { lockPayoutPolicy } from '../../src/services/finance/payout-modes.js';
import { failDestination } from '../../src/services/payouts/destinations.js';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';

test(
  '0078 populated upgrade and local payout fixture lifecycle matrix',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: '0077_payout_mode',
    });
    const sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        cash = await seedFinanceFixture(sql, f);
      const admin = { kind: 'admin', id: f.admin },
        owner = { kind: 'owner', id: f.owner };
      const snapshots =
        () => sql`SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payout p) payouts,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM refund r) refunds,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM refund_allocation a) allocations`;
      const before = await snapshots();
      const journal = JSON.parse(
        await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
      );
      await migrateWithDrizzle(db.url, journal.entries[77].when);
      assert.deepEqual(await snapshots(), before);
      const provider = payoutTransferProvider();
      let destinationId = cash.destinationId,
        destinationVersion = 1;
      const newDestination = async () => {
        destinationVersion++;
        const [d] =
          await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
        VALUES (${f.owner},${destinationVersion},'bank','Property Owner','6789','SBIN0001234','same','verified','migration',now(),'fixture',${randomUUID()},${'a'.repeat(64)},now()) RETURNING id`;
        destinationId = d.id;
      };
      const mode = (value) =>
        sql`INSERT INTO payout_mode_setting(mode,reason,created_by) VALUES (${value},'Reviewed fixture policy',${f.admin})`;
      const reserve = async (source = null) => {
        const s = source ?? (await cash.add('test'));
        const row = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          provider,
        );
        return { s, row };
      };
      const refund = (s, minor) =>
        sql.begin(async (tx) => {
          const key = randomUUID();
          const [r] =
            await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,idempotency_key,request_hash)
        VALUES ('Fixture refund',${key},${s.transactionId},'fixture','test','real','INR','requested',${minor},${key},${'d'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
        VALUES (${r.id},${s.allocationId},${s.bookingId},'rent',${minor})`;
        });
      const blocked = async (takeLock, action, change) => {
        let unlock, acquired;
        const gate = new Promise((resolve) => {
          unlock = resolve;
        });
        const ready = new Promise((resolve) => {
          acquired = resolve;
        });
        const blocker = sql.begin(async (tx) => {
          await takeLock(tx);
          acquired();
          await gate;
          await change(tx);
        });
        await ready;
        const result = action().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          const deadline = Date.now() + 5000;
          let waiting = false;
          while (Date.now() < deadline) {
            const [row] =
              await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) waiting`;
            if (row.waiting) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          assert.equal(waiting, true, 'dispatch actually reached a blocked database lock');
        } finally {
          unlock();
        }
        await blocker;
        return result;
      };
      await t.test(
        'authorization, actual non-disposable connection, missing adapter, unsupported and Live refuse',
        async () => {
          const input = { sourceId: cash.test.allocationId, requestKey: randomUUID() };
          await assert.rejects(reservePayoutTransfer(sql, owner, input, provider), {
            statusCode: 403,
          });
          await sql`UPDATE admin_user SET permissions='["admin.payments.read"]' WHERE id=${f.limited}`;
          await assert.rejects(
            reservePayoutTransfer(sql, { kind: 'admin', id: f.limited }, input, provider),
            { statusCode: 403 },
          );
          await assert.rejects(reservePayoutTransfer(sql, admin, input), {
            code: 'PAYOUT_FIXTURE_BLOCKED',
          });
          await assert.rejects(
            reservePayoutTransfer(sql, admin, input, { ...provider, account: 'unsupported' }),
            { code: 'PAYOUT_FIXTURE_BLOCKED' },
          );
          for (const s of [
            cash.live,
            cash.simulated,
            await cash.add('test', { unattributed: true }),
            await cash.add('test', { orderState: 'expired', bookingState: 'cancelled' }),
          ])
            await assert.rejects(
              reservePayoutTransfer(sql, admin, { ...input, sourceId: s.allocationId }, provider),
              { code: 'PAYOUT_FIXTURE_BLOCKED' },
            );
          const control = postgres(process.env.PORTAL_TEST_DATABASE_URL, { max: 1 });
          try {
            // This is an actual localhost connection to postgres, not a forged client URL.
            await assert.rejects(
              previewPayoutTransfer(control, admin, { sourceId: input.sourceId }, provider),
              {
                code: 'PAYOUT_FIXTURE_BLOCKED',
              },
            );
            const guard = await readFile(
              new URL('../../drizzle/0078_payout_transfer_fixture.sql', import.meta.url),
              'utf8',
            );
            await assert.rejects(
              control.begin(async (tx) => {
                // Run the same migration guard against this connection before any fixture write.
                const body = guard.match(/IF current_database\(\)[\s\S]*?END IF;/)[0];
                await tx.unsafe(`DO $$ BEGIN ${body} END $$`);
              }),
              /actual disposable localhost/,
            );
          } finally {
            await control.end();
          }
          assert.equal(provider.calls.length, 0);
          // Existing ledger trust-boundary constraints refuse non-INR evidence before fixtures can see it.
          await assert.rejects(
            sql`UPDATE payment_transaction SET currency='USD' WHERE id=${cash.test.transactionId}`,
          );
        },
      );
      await t.test(
        'Auto reservation, actor/payload key replay, unique source and concurrent one-shot dispatch',
        async () => {
          const input = { sourceId: cash.test.allocationId, requestKey: randomUUID() };
          const row = await reservePayoutTransfer(sql, admin, input, provider);
          for (const state of ['reserved', 'processing', 'unknown', 'succeeded']) {
            const direct = {
              ...row,
              id: randomUUID(),
              state,
              dispatched_at: new Date().toISOString(),
              dispatch_actor_id: f.admin,
              dispatch_mode: 'auto',
              dispatch_policy: row.policy,
              manual_consent: false,
            };
            await assert.rejects(
              sql`INSERT INTO payout_transfer_fixture SELECT (jsonb_populate_record(NULL::payout_transfer_fixture,${JSON.stringify(direct)}::text::jsonb)).*`,
              /must start reserved and undispatched/,
            );
          }
          assert.equal((await reservePayoutTransfer(sql, admin, input, provider)).id, row.id);
          await assert.rejects(
            reservePayoutTransfer(sql, admin, { ...input, accepted: true }, provider),
            { code: 'IDEMPOTENCY_CONFLICT' },
          );
          await assert.rejects(
            reservePayoutTransfer(sql, admin, { ...input, requestKey: randomUUID() }, provider),
            { code: 'PAYOUT_FIXTURE_EXISTS' },
          );
          const results = await Promise.all([
            dispatchPayoutTransfer(sql, admin, row.id, {}, provider),
            dispatchPayoutTransfer(sql, admin, row.id, {}, provider),
          ]);
          assert.ok(results.every((r) => ['succeeded', 'unknown'].includes(r.state)));
          assert.equal(
            provider.calls.filter((c) => c.kind === 'create' && c.identity.operationId === row.id)
              .length,
            1,
          );
          assert.equal(
            (await reconcilePayoutTransfer(sql, admin, row.id, provider)).state,
            'succeeded',
          );
          await assert.rejects(
            sql`UPDATE payout_transfer_fixture SET expected_minor=1 WHERE id=${row.id}`,
            /immutable/,
          );
          await assert.rejects(
            sql`UPDATE payout_transfer_fixture SET dispatched_at=NULL WHERE id=${row.id}`,
            /immutable/,
          );
          await assert.rejects(
            sql`DELETE FROM payout_transfer_fixture WHERE id=${row.id}`,
            /immutable/,
          );
          const s = await cash.add('test');
          const key = { sourceId: s.allocationId, requestKey: randomUUID() };
          const raced = await Promise.all([
            reservePayoutTransfer(sql, admin, key, provider),
            reservePayoutTransfer(sql, admin, key, provider),
          ]);
          assert.equal(raced[0].id, raced[1].id);
        },
      );
      await t.test(
        'invalid preview and null Manual confirmation have no side effects',
        async () => {
          const count = provider.calls.length;
          const [beforeRows] = await sql`SELECT count(*)::int n FROM payout_transfer_fixture`;
          for (const input of [null, undefined])
            await assert.rejects(previewPayoutTransfer(sql, admin, input, provider), {
              statusCode: 422,
            });
          assert.deepEqual(
            (await sql`SELECT count(*)::int n FROM payout_transfer_fixture`)[0],
            beforeRows,
          );
          const { row } = await reserve();
          await mode('manual');
          await assert.rejects(dispatchPayoutTransfer(sql, admin, row.id, null, provider), {
            statusCode: 422,
          });
          const [held] =
            await sql`SELECT state,dispatched_at FROM payout_transfer_fixture WHERE id=${row.id}`;
          assert.deepEqual(held, { state: 'reserved', dispatched_at: null });
          assert.equal(provider.calls.length, count);
          await mode('auto');
        },
      );
      await t.test(
        'fixture callback timeout stays unknown and late recovery is lookup-only',
        { timeout: 5000 },
        async () => {
          for (const method of ['create', 'lookup']) {
            const { row } = await reserve();
            const fixture = payoutTransferProvider();
            const original = fixture[method];
            let finish;
            fixture[method] = async function (identity) {
              await original.call(this, identity);
              return new Promise((resolve) => {
                finish = resolve;
              });
            };
            const result = await dispatchPayoutTransfer(sql, admin, row.id, {}, fixture);
            assert.equal(result.state, 'unknown');
            assert.ok(result.dispatched_at);
            assert.equal(fixture.calls.filter((call) => call.kind === 'create').length, 1);
            // The original callback may still finish later; it must never cause a resend.
            finish();
            fixture[method] = original;
            assert.equal(
              (await reconcilePayoutTransfer(sql, admin, row.id, fixture)).state,
              'succeeded',
            );
            assert.equal(fixture.calls.filter((call) => call.kind === 'create').length, 1);
          }
        },
      );
      await t.test(
        'adapter callbacks observe committed claim and all shared locks released',
        async () => {
          const { s, row } = await reserve();
          const observer = postgres(db.url, { max: 1, onnotice: () => {} });
          const fixture = payoutTransferProvider();
          const observed = [];
          try {
            for (const method of ['create', 'lookup']) {
              const original = fixture[method];
              fixture[method] = async function (identity) {
                await observer.begin(async (tx) => {
                  const [claim] =
                    await tx`SELECT dispatched_at FROM payout_transfer_fixture WHERE id=${row.id}`;
                  assert.ok(claim.dispatched_at, 'claim is committed on another connection');
                  const [policy] = await tx`SELECT pg_try_advisory_xact_lock(73421,12) acquired`;
                  assert.equal(policy.acquired, true);
                  await tx`SELECT id FROM rentable WHERE id=${f.listing} FOR UPDATE NOWAIT`;
                  await tx`SELECT id FROM booking_order WHERE id=${s.orderId} FOR UPDATE NOWAIT`;
                  await tx`SELECT id FROM booking WHERE id=${s.bookingId} FOR UPDATE NOWAIT`;
                  await tx`SELECT id FROM "user" WHERE id=${f.owner} FOR UPDATE NOWAIT`;
                  await tx`SELECT id FROM payout_destination WHERE id=${row.destination_id} FOR UPDATE NOWAIT`;
                  await tx`SELECT id FROM payment_order WHERE id=${s.paymentId} FOR UPDATE NOWAIT`;
                  await tx`SELECT id FROM payout_transfer_fixture WHERE id=${row.id} FOR UPDATE NOWAIT`;
                });
                observed.push(method);
                return original.call(this, identity);
              };
            }
            assert.equal(
              (await dispatchPayoutTransfer(sql, admin, row.id, {}, fixture)).state,
              'succeeded',
            );
            assert.deepEqual(observed, ['create', 'lookup']);
          } finally {
            await observer.end();
          }
        },
      );
      await t.test('multiple verified captures hold without guessing an allocation', async () => {
        const s = await cash.add('test'),
          key = randomUUID();
        await sql.begin(async (tx) => {
          const [po] =
            await tx`INSERT INTO payment_order(booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,state)
              VALUES (${s.orderId},'fixture','test','real','INR','full',108000,${key},${'b'.repeat(64)},'succeeded') RETURNING id`;
          const [attempt] =
            await tx`INSERT INTO payment_attempt(payment_order_id,provider,environment,mode,currency,attempt_number,expected_minor,state,provider_payment_id)
              VALUES (${po.id},'fixture','test','real','INR',1,108000,'succeeded',${key}) RETURNING id`;
          const [capture] =
            await tx`INSERT INTO payment_transaction(attempt_id,reference,provider,environment,mode,currency,kind,outcome,expected_minor,captured_minor,provider_payment_id,external_ledger_id,verified_at,evidence_hash)
              VALUES (${attempt.id},${key},'fixture','test','real','INR','capture','succeeded',108000,108000,${key},${key},now(),${'c'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO payment_allocation(transaction_id,booking_id,component,actual_minor)
              VALUES (${capture.id},${s.bookingId},'rent',100000),(${capture.id},${s.bookingId},'fee',8000)`;
        });
        const count = provider.calls.length;
        await assert.rejects(reserve(s), { code: 'PAYOUT_FIXTURE_BLOCKED' });
        assert.equal(provider.calls.length, count);
      });
      await t.test(
        'queued mode rechecks after actual preclaim policy lock; fresh Manual consent uses same operation',
        async () => {
          const { s, row } = await reserve();
          const old = await previewPayoutTransfer(
            sql,
            admin,
            { sourceId: s.allocationId },
            provider,
          );
          const count = provider.calls.length;
          const result = await blocked(
            lockPayoutPolicy,
            () => dispatchPayoutTransfer(sql, admin, row.id, {}, provider),
            (tx) =>
              tx`INSERT INTO payout_mode_setting(mode,reason,created_by) VALUES ('manual','Queued mode changed',${f.admin})`,
          );
          assert.equal(result.error.code, 'STALE_PREVIEW');
          assert.equal(provider.calls.length, count);
          await assert.rejects(
            dispatchPayoutTransfer(
              sql,
              admin,
              row.id,
              { previewHash: old.previewHash, accepted: true },
              provider,
            ),
            { code: 'STALE_PREVIEW' },
          );
          const review = await previewPayoutTransfer(
            sql,
            admin,
            { sourceId: s.allocationId },
            provider,
          );
          await assert.rejects(
            dispatchPayoutTransfer(
              sql,
              admin,
              row.id,
              { previewHash: review.previewHash },
              provider,
            ),
            { statusCode: 422 },
          );
          await assert.rejects(
            dispatchPayoutTransfer(
              sql,
              { kind: 'admin', id: f.limited },
              row.id,
              { previewHash: review.previewHash, accepted: true },
              provider,
            ),
            { statusCode: 403 },
          );
          const done = await dispatchPayoutTransfer(
            sql,
            admin,
            row.id,
            { previewHash: review.previewHash, accepted: true },
            provider,
          );
          assert.equal(done.id, row.id);
          assert.equal(done.dispatch_mode, 'manual');
          assert.deepEqual(done.dispatch_policy, review.terms.policy);
          assert.equal(done.manual_consent, true);
          await mode('auto');
        },
      );
      await t.test('queued refund and destination changes block before fixture calls', async () => {
        const { s, row } = await reserve();
        const count = provider.calls.length;
        const result = await blocked(
          (tx) => tx`UPDATE rentable SET updated_at=updated_at WHERE id=${f.listing}`,
          () => dispatchPayoutTransfer(sql, admin, row.id, {}, provider),
          async (tx) => {
            const key = randomUUID();
            const [r] =
              await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,idempotency_key,request_hash)
            VALUES ('Queued refund',${key},${s.transactionId},'fixture','test','real','INR','requested',10000,${key},${'d'.repeat(64)}) RETURNING id`;
            await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
            VALUES (${r.id},${s.allocationId},${s.bookingId},'rent',10000)`;
          },
        );
        assert.equal(result.error.code, 'STALE_PREVIEW');
        assert.equal(provider.calls.length, count);
        const next = await reserve();
        const changed = await blocked(
          (tx) => tx`UPDATE rentable SET updated_at=updated_at WHERE id=${f.listing}`,
          () => dispatchPayoutTransfer(sql, admin, next.row.id, {}, provider),
          (tx) =>
            tx`UPDATE payout_destination SET state='superseded',updated_at=now() WHERE id=${destinationId}`,
        );
        assert.equal(changed.error.code, 'PAYOUT_FIXTURE_BLOCKED');
        assert.equal(provider.calls.length, count);
        await newDestination();
      });
      await t.test('actual authenticated destination revocation wins a preclaim race', async () => {
        const { row } = await reserve();
        const actor = {
          ...admin,
          sessionId: await issuePortalSession(sql, 'admin', f.admin, 3600),
        };
        const count = provider.calls.length;
        const changed = await blocked(
          (tx) =>
            failDestination({ begin: (run) => run(tx) }, actor, {
              destinationId,
              expectedState: 'verified',
              reason: 'Fixture bank evidence was revoked.',
              mode: 'apply',
              requestKey: randomUUID(),
            }),
          () => dispatchPayoutTransfer(sql, admin, row.id, {}, provider),
          async () => {},
        );
        assert.equal(changed.error.code, 'PAYOUT_FIXTURE_BLOCKED');
        assert.equal(provider.calls.length, count);
        const [held] =
          await sql`SELECT state,dispatched_at FROM payout_transfer_fixture WHERE id=${row.id}`;
        assert.deepEqual(held, { state: 'reserved', dispatched_at: null });
        const [revoked] = await sql`SELECT state FROM payout_destination WHERE id=${destinationId}`;
        assert.equal(revoked.state, 'failed');
        await newDestination();
      });
      await t.test(
        'revocation can insert its owner FK while fixture guard waits on destination',
        { timeout: 10000 },
        async () => {
          const { row } = await reserve();
          const actor = {
            ...admin,
            sessionId: await issuePortalSession(sql, 'admin', f.admin, 3600),
          };
          let release, acquired;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          const ready = new Promise((resolve) => {
            acquired = resolve;
          });
          // Pause the real writer immediately after its destination lock, before its owner-FK notification.
          const writerDatabase = {
            begin: (run) =>
              sql.begin((tx) =>
                run(
                  new Proxy(tx, {
                    apply(target, thisArg, args) {
                      const query = Reflect.apply(target, thisArg, args);
                      const text = args[0].join('');
                      return text.includes('SELECT * FROM payout_destination') &&
                        text.includes('FOR UPDATE')
                        ? query.then(async (rows) => {
                            acquired();
                            await gate;
                            return rows;
                          })
                        : query;
                    },
                  }),
                ),
              ),
          };
          const writer = failDestination(writerDatabase, actor, {
            destinationId,
            expectedState: 'verified',
            reason: 'Fixture bank evidence revoked during dispatch guard.',
            mode: 'apply',
            requestKey: randomUUID(),
          }).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await ready;
          const count = provider.calls.length;
          const dispatch = dispatchPayoutTransfer(sql, admin, row.id, {}, provider).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          try {
            let blocked = false;
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              const [waiting] =
                await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
              AND query LIKE '%SELECT id,version,state FROM payout_destination%' AND cardinality(pg_blocking_pids(pid))>0) blocked`;
              if (waiting.blocked) {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            assert.equal(
              blocked,
              true,
              'fixture acquired its owner guard before waiting on the writer destination lock',
            );
          } finally {
            release();
          }
          const [revocation, result] = await Promise.all([writer, dispatch]);
          assert.equal(
            revocation.error,
            undefined,
            'real revocation and owner-FK notification complete without deadlock',
          );
          assert.equal(revocation.value.state, 'failed');
          assert.equal(result.error.code, 'PAYOUT_FIXTURE_BLOCKED');
          assert.equal(provider.calls.length, count);
          const [notification] = await sql`SELECT id FROM client_update WHERE client_id=${f.owner}
          AND action='payout_destination_failed' AND detail->>'version'=${String(destinationVersion)}`;
          assert.ok(notification, 'actual owner notification is persisted');
          const [held] =
            await sql`SELECT state,dispatched_at FROM payout_transfer_fixture WHERE id=${row.id}`;
          assert.deepEqual(held, { state: 'reserved', dispatched_at: null });
          await newDestination();
        },
      );
      await t.test(
        'lost response/failure stays unknown, every evidence field checked, late success once after policy/owner/destination changes',
        async () => {
          const { row } = await reserve();
          provider.loseResponse = true;
          assert.equal(
            (await dispatchPayoutTransfer(sql, admin, row.id, {}, provider)).state,
            'unknown',
          );
          provider.loseResponse = false;
          const good = provider.rows.get(row.id);
          for (const key of Object.keys(good).filter((k) => k !== 'status')) {
            provider.rows.set(row.id, {
              ...good,
              [key]: key === 'destinationVersion' ? 99 : 'mismatched',
            });
            assert.equal(
              (await reconcilePayoutTransfer(sql, admin, row.id, provider)).state,
              'unknown',
              key,
            );
          }
          provider.rows.set(row.id, { ...good, status: 'failed' });
          assert.equal(
            (await reconcilePayoutTransfer(sql, admin, row.id, provider)).state,
            'unknown',
          );
          provider.rows.delete(row.id);
          assert.equal(
            (await reconcilePayoutTransfer(sql, admin, row.id, provider)).state,
            'unknown',
          );
          await mode('manual');
          await sql`UPDATE "user" SET account_status='suspended' WHERE id=${f.owner}`;
          await sql`UPDATE payout_destination SET state='superseded',updated_at=now() WHERE id=${destinationId}`;
          provider.rows.set(row.id, good);
          const done = await reconcilePayoutTransfer(sql, admin, row.id, provider);
          assert.equal(done.state, 'succeeded');
          assert.deepEqual(await reconcilePayoutTransfer(sql, admin, row.id, provider), done);
          assert.equal(
            provider.calls.filter((c) => c.kind === 'create' && c.identity.operationId === row.id)
              .length,
            1,
          );
          await sql`UPDATE "user" SET account_status='active' WHERE id=${f.owner}`;
          await newDestination();
          await mode('auto');
        },
      );
      await t.test(
        'before/after refunds, simulated overlap, scoped DTOs, real totals/CSV/cash cap unchanged',
        async () => {
          const s = await cash.add('test');
          await refund(s, 10000);
          const { row } = await reserve(s);
          assert.equal(String(row.expected_minor), '90000');
          const query = { period: cash.period, environment: 'test' };
          const csvFacts = (text) =>
            text
              .split('\r\n')
              .filter((line) => !line.startsWith('"As of"'))
              .join('\r\n');
          provider.outcome = 'failed';
          assert.equal(
            (await dispatchPayoutTransfer(sql, admin, row.id, {}, provider)).state,
            'unknown',
          );
          await refund(s, 90000);
          const previous = await financeStatement(sql, owner, query);
          const assertFixtureItem = (statement, state) => {
            const fixture = statement.items.find((item) => item.id === s.allocationId)?.fixture;
            assert.ok(fixture, 'matching statement allocation includes fixture facts');
            assert.equal(fixture.sourceId, s.allocationId);
            assert.equal(fixture.state, state);
            assert.equal(fixture.simulatedExposureMinor, '90000');
            assert.equal(fixture.actualBankMinor, '0');
          };
          assertFixtureItem(previous, 'unknown');
          assertFixtureItem(await financeStatement(sql, admin, query), 'unknown');
          const previousCsv = csvFacts(await financeCsv(sql, owner, query));
          let line = await financeAllocation(sql, owner, s.allocationId);
          assert.equal(line.fixture.simulatedExposureMinor, '90000');
          provider.rows.set(row.id, { ...provider.rows.get(row.id), status: 'succeeded' });
          await reconcilePayoutTransfer(sql, admin, row.id, provider);
          line = await financeAllocation(sql, owner, s.allocationId);
          assert.equal(line.fixture.state, 'succeeded');
          assert.equal(line.fixture.actualBankMinor, '0');
          assert.equal(line.fixture.fundingAuthority, 'unset');
          assert.equal(line.fixture.simulatedExposureMinor, '90000');
          const current = await financeStatement(sql, owner, query);
          assertFixtureItem(current, 'succeeded');
          assertFixtureItem(await financeStatement(sql, admin, query), 'succeeded');
          assert.deepEqual(current.totals, previous.totals);
          assert.equal(csvFacts(await financeCsv(sql, owner, query)), previousCsv);
          assert.equal((await readPayoutTransfers(sql, { kind: 'owner', id: f.other })).length, 0);
          assert.ok((await readPayoutTransfers(sql, owner)).length > 0);
          assert.ok((await readPayoutTransfers(sql, admin)).length > 0);
          await assert.rejects(
            financeAllocation(sql, { kind: 'owner', id: f.other }, s.allocationId),
            { statusCode: 404 },
          );
          assert.deepEqual(
            (await sql`SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payout p) payouts`)[0]
              .payouts,
            before[0].payouts,
          );
          await assert.rejects(
            sql.begin(async (tx) => {
              const key = randomUUID();
              const [r] =
                await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,idempotency_key,request_hash)
          VALUES ('Cap rejection',${key},${cash.live.transactionId},'fixture','live','real','INR','requested',50000,${key},${'d'.repeat(64)}) RETURNING id`;
              await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
          VALUES (${r.id},${cash.live.allocationId},${cash.live.bookingId},'rent',50000)`;
            }),
            /exceed available funds/,
          );
        },
      );
    } finally {
      await db.drop();
    }
  },
);
