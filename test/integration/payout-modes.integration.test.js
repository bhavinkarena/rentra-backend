import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import {
  listPayoutModes,
  payoutModeCommand,
  resolvePayoutMode,
  lockPayoutPolicy,
} from '../../src/services/finance/payout-modes.js';
import { financeAllocation } from '../../src/services/finance/statements.js';
import { executePayoutRun, settlePayoutRun } from '../../src/services/finance/hotel-payouts.js';

test(
  '0077 populated upgrade, mode authorization, inheritance, stale/raced confirmations and pinned history',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: '0076_early_departure',
    });
    const sql = db.sql;
    try {
      const f = await seedReviewFixture(sql);
      const cash = await seedFinanceFixture(sql, f);
      const [historicRun] =
        await sql`INSERT INTO payout_run(run_number,period_start,period_end,payout_date,snapshot) VALUES ('OLD-SNAPSHOT',current_date,current_date,current_date,'{"lines":[{"ownerId":"pinned-owner"}]}') RETURNING *`;
      const oldSource = await cash.add('live', { unattributed: true });
      const [oldFunded] =
        await sql`INSERT INTO payout(booking_id,client_id,funding_allocation_id,actual_net_minor,gross_minor,commission_minor,net_minor,status,destination_id)
        VALUES (${oldSource.bookingId},${f.owner},${oldSource.allocationId},10000,100000,0,100000,'pending',${cash.destinationId}) RETURNING *`;
      const before = await sql`SELECT to_jsonb(p) row FROM payout p ORDER BY id`;
      const journal = JSON.parse(
        await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
      );
      await migrateWithDrizzle(db.url, journal.entries[76].when);
      assert.deepEqual(await sql`SELECT to_jsonb(p) row FROM payout p ORDER BY id`, before);
      const admin = { kind: 'admin', id: f.admin };
      const [owner] = await sql`SELECT email FROM "user" WHERE id=${f.owner}`;
      const change = (mode, ownerEmail = '') => ({
        mode,
        ownerEmail,
        reason: 'Reviewed payout configuration',
      });
      const save = async (input) => {
        const preview = await payoutModeCommand(sql, admin, { ...input, preview: true });
        return payoutModeCommand(sql, admin, {
          ...input,
          previewHash: preview.previewHash,
          accepted: true,
        });
      };
      assert.equal((await resolvePayoutMode(sql, f.owner)).mode, 'auto');
      await assert.rejects(listPayoutModes(sql, { kind: 'owner', id: f.owner }), {
        statusCode: 403,
      });
      await assert.rejects(
        payoutModeCommand(sql, { kind: 'owner', id: f.owner }, change('manual')),
        { statusCode: 403 },
      );
      await sql`UPDATE admin_user SET permissions='["admin.payments.read"]' WHERE id=${f.limited}`;
      assert.equal((await listPayoutModes(sql, { kind: 'admin', id: f.limited })).canWrite, false);
      await assert.rejects(
        payoutModeCommand(sql, { kind: 'admin', id: f.limited }, change('manual')),
        { statusCode: 403 },
      );
      const consentInput = change('manual');
      const consentPreview = await payoutModeCommand(sql, admin, {
        ...consentInput,
        preview: true,
      });
      const counts = () => sql`SELECT (SELECT count(*)::int FROM payout_mode_setting) settings,
        (SELECT count(*)::int FROM audit_log WHERE entity='payout_mode') audits`;
      const beforeConsent = await counts();
      for (const consent of [{}, { accepted: false }]) {
        await assert.rejects(
          payoutModeCommand(sql, admin, {
            ...consentInput,
            previewHash: consentPreview.previewHash,
            ...consent,
          }),
          { statusCode: 422 },
        );
        assert.equal((await resolvePayoutMode(sql, f.owner)).mode, 'auto');
        assert.deepEqual(await counts(), beforeConsent);
      }
      await save(change('manual'));
      await save(change('auto', owner.email));
      assert.equal((await resolvePayoutMode(sql, f.owner)).source, 'owner');
      await save(change('inherit', owner.email));
      assert.equal((await resolvePayoutMode(sql, f.owner)).mode, 'manual');
      assert.equal((await resolvePayoutMode(sql, f.owner)).source, 'global');
      await save(change('auto'));
      assert.equal((await resolvePayoutMode(sql, f.owner)).mode, 'auto');
      const future = await cash.add('live', {
        orderState: 'confirmed',
        bookingState: 'confirmed',
        startsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        endsAt: new Date(Date.now() + 31 * 86400000).toISOString(),
      });
      const auto = await financeAllocation(
        sql,
        { kind: 'owner', id: f.owner },
        future.allocationId,
      );
      assert.equal(auto.eligibleMinor, '100000');
      assert.equal(auto.payoutMode.mode, 'auto');
      const unsupported = await cash.add('live', {
        orderState: 'expired',
        bookingState: 'cancelled',
      });
      const held = await financeAllocation(
        sql,
        { kind: 'owner', id: f.owner },
        unsupported.allocationId,
      );
      assert.equal(held.eligibleMinor, '0');
      assert.equal(held.heldMinor, '100000');
      const input = change('manual');
      const preview = await payoutModeCommand(sql, admin, { ...input, preview: true });
      const confirmed = { ...input, previewHash: preview.previewHash, accepted: true };
      let release;
      let locked;
      const acquired = new Promise((resolve) => {
        locked = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const blocker = sql.begin(async (tx) => {
        await lockPayoutPolicy(tx);
        locked();
        await gate;
      });
      await acquired;
      const first = payoutModeCommand(sql, admin, confirmed);
      const second = payoutModeCommand(sql, admin, confirmed);
      release();
      await blocker;
      const raced = await Promise.allSettled([first, second]);
      assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(raced.find((r) => r.status === 'rejected').reason.code, 'STALE_PREVIEW');
      await assert.rejects(payoutModeCommand(sql, admin, confirmed), { code: 'STALE_PREVIEW' });
      assert.deepEqual(await sql`SELECT to_jsonb(p) row FROM payout p ORDER BY id`, before);
      await sql`UPDATE payout SET status='processing' WHERE id=${oldFunded.id}`;
      const [oldUpdated] = await sql`SELECT * FROM payout WHERE id=${oldFunded.id}`;
      assert.equal(oldUpdated.status, 'processing');
      assert.deepEqual({ ...oldUpdated, status: oldFunded.status }, oldFunded);
      await assert.rejects(
        sql`UPDATE payout SET actual_net_minor=20000 WHERE id=${oldFunded.id}`,
        /immutable/,
      );
      await assert.rejects(
        sql`INSERT INTO payout(booking_id,client_id,funding_allocation_id,actual_net_minor,gross_minor,commission_minor,net_minor,status,destination_id)
        VALUES (${cash.unresolved.bookingId},${f.owner},${cash.unresolved.allocationId},10000,100000,0,100000,'pending',${cash.destinationId})`,
        /eligible verified rent capture/,
      );
      await assert.rejects(sql`UPDATE payout_mode_setting SET mode='auto'`, /append-only/);
      await assert.rejects(sql`DELETE FROM payout_mode_setting`, /append-only/);
      await assert.rejects(
        sql`UPDATE payout SET actual_net_minor=1 WHERE id=${cash.payoutId}`,
        /immutable/,
      );
      const allocation = await financeAllocation(
        sql,
        { kind: 'owner', id: f.owner },
        cash.live.allocationId,
      );
      assert.equal(allocation.eligibleMinor, '40000'); // Completed and reserved refunds plus pinned paid money.
      assert.equal(allocation.payoutMode.mode, 'manual');
      assert.equal(
        (await financeAllocation(sql, { kind: 'owner', id: f.owner }, future.allocationId))
          .eligibleMinor,
        auto.eligibleMinor,
      );
      assert.deepEqual(
        (await sql`SELECT * FROM payout_run WHERE id=${historicRun.id}`)[0],
        historicRun,
      );
      await assert.rejects(
        sql`UPDATE payout_run SET snapshot='{}' WHERE id=${historicRun.id}`,
        /immutable/,
      );
      await sql`UPDATE rentable SET client_id=${f.other} WHERE id=${f.listing}`;
      const [pinned] =
        await sql`INSERT INTO payout(booking_id,client_id,funding_allocation_id,actual_net_minor,gross_minor,commission_minor,net_minor,status,destination_id)
      VALUES (${future.bookingId},${f.owner},${future.allocationId},10000,100000,0,100000,'pending',${cash.destinationId}) RETURNING id`;
      assert.equal(
        (await financeAllocation(sql, { kind: 'owner', id: f.owner }, future.allocationId)).payout
          .id,
        pinned.id,
      );
      assert.equal(
        (await financeAllocation(sql, { kind: 'owner', id: f.owner }, future.allocationId))
          .bookingLinkAvailable,
        false,
      );
      assert.equal('reason' in allocation.payoutMode, false);
      assert.equal('settings' in allocation.payoutMode, false);
      await assert.rejects(
        executePayoutRun(sql, f.admin, { environment: 'live', previewHash: 'f'.repeat(64) }),
        { code: 'PAYOUT_EXECUTION_UNAVAILABLE' },
      );
      const [run] =
        await sql`INSERT INTO payout_run(run_number,period_start,period_end,payout_date,environment) VALUES ('HISTORIC',current_date,current_date,current_date,'live') RETURNING id`;
      await assert.rejects(settlePayoutRun(sql, f.admin, { runId: run.id, utr: 'BANK12345' }), {
        code: 'PAYOUT_EXECUTION_UNAVAILABLE',
      });
      assert.equal(
        (await sql`SELECT status FROM payout_run WHERE id=${run.id}`)[0].status,
        'scheduled',
      );
    } finally {
      await db.drop();
    }
  },
);
