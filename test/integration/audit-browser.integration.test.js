import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';
import * as service from '../../src/services/admin/audit-browser.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
const env = { SESSION_SECRET: 'cp28-disposable-artifact-secret' };
test(
  'CP28 redacted audit, governed scopes, retries, receipts and live export authorization',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      db = fixture.sql;
    globalThis.__rentraSql = db;
    await import('../../src/services/db/index.js'); // Exercise Drizzle's production date/JSON type overrides.
    try {
      const f = await seedReviewFixture(db);
      await seedFinanceFixture(db, f);
      const actor = {
        kind: 'admin',
        id: f.admin,
        sessionId: await issuePortalSession(db, 'admin', f.admin, 3600),
      };
      const other = {
        kind: 'admin',
        id: f.second,
        sessionId: await issuePortalSession(db, 'admin', f.second, 3600),
      };
      const [ro] =
        await db`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES ('audit-read@fixture.invalid','Read','fixture','["admin.audit.read"]') RETURNING id`;
      const reader = {
        kind: 'admin',
        id: ro.id,
        sessionId: await issuePortalSession(db, 'admin', ro.id, 3600),
      };
      const corr = randomUUID();
      const [event] =
        await db`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,correlation_id,before,after,reason,ip) VALUES ('admin',${f.admin},'rentable',${f.listing},'fixture_change',${corr},' {"state":"active","password":"SECRET-password","name":"PRIVATE-NAME"}',${JSON.stringify({ state: 'blocked', token: 'SECRET-TOKEN', password_hash: 'SECRET-HASH', unknown: { state: 'SECRET-NESTED' }, phone: '9000000000', email: 'PRIVATE@fixture.invalid', count: 2 })}::text::jsonb,'SECRET free text 9000000000','127.0.0.1') RETURNING id`;
      const filters = { ...service.defaultFilters(), action: 'fixture_change' },
        base = {
          dataset: 'audit_events',
          filters,
          limit: 100,
          requestKey: randomUUID(),
          reason: 'Investigate the approved synthetic scope',
          confirmed: true,
        };
      const detail = await service.auditDetail(db, reader, event.id),
        text = JSON.stringify(detail);
      for (const secret of ['SECRET', 'PRIVATE', '9000000000', '127.0.0.1', 'password_hash'])
        assert.ok(!text.includes(secret));
      assert.equal(detail.event.correlation, corr);
      assert.deepEqual(
        detail.event.changes.find((c) => c.field === 'state'),
        { field: 'state', before: 'active', after: 'blocked' },
      );
      const directory = await service.auditList(db, actor, { ...filters, correlation: corr });
      assert.equal(directory.total, 1);
      assert.equal(directory.items[0].id, event.id);
      await assert.rejects(service.auditList(db, { kind: 'customer', id: f.owner }, filters), {
        statusCode: 403,
      });
      await assert.rejects(service.createExport(db, reader, base), { code: 'CAPABILITY_REQUIRED' });
      await assert.rejects(service.auditList(db, actor, { from: '2026-01-01', to: '2026-03-01' }), {
        statusCode: 422,
      });
      await assert.rejects(service.createExport(db, actor, { ...base, limit: 2001 }), {
        statusCode: 422,
      });
      await assert.rejects(
        service.createExport(db, actor, { ...base, dataset: 'payment_orders' }),
        { statusCode: 422 },
      );
      await db`UPDATE portal_session SET created_at=now()-interval '16 minutes' WHERE id=${actor.sessionId}`;
      await assert.rejects(service.createExport(db, actor, base), { code: 'RECENT_AUTH_REQUIRED' });
      await db`UPDATE portal_session SET created_at=now() WHERE id=${actor.sessionId}`;
      const jobs = await Promise.all([
        service.createExport(db, actor, base),
        service.createExport(db, actor, base),
      ]);
      assert.equal(jobs[0].id, jobs[1].id);
      const id = jobs[0].id;
      await assert.rejects(service.createExport(db, actor, { ...base, limit: 1 }), {
        code: 'REQUEST_KEY_REUSED',
      });
      await assert.rejects(service.exportDownload(db, actor, id, false, env), {
        code: 'ARTIFACT_NOT_READY',
      });
      await assert.rejects(service.exportDetail(db, other, id), { statusCode: 404 });
      await service.processExport(db, id, {
        env,
        beforeBuild: () => {
          throw Error('SECRET failure');
        },
      });
      let j = (await service.exportDetail(db, actor, id)).job;
      assert.equal(j.state, 'failed');
      assert.equal(j.errorCode, 'EXPORT_FAILED');
      assert.equal(j.receipt, null);
      const retry = {
        version: j.version,
        reason: 'Retry this same reviewed scoped copy',
        confirmed: true,
      };
      const raced = await Promise.allSettled([
        service.retryExport(db, actor, id, retry),
        service.retryExport(db, actor, id, retry),
      ]);
      assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
      const workers = await Promise.all([
        service.processExport(db, id, { env }),
        service.processExport(db, id, { env }),
      ]);
      assert.equal(workers.filter(Boolean).length, 1);
      j = (await service.exportDetail(db, actor, id)).job;
      assert.equal(j.receipt.rowCount, 1);
      assert.equal(j.attempts, 2);
      const bytes = await service.exportDownload(db, actor, id, false, env);
      assert.equal(JSON.parse(bytes).items[0].id, event.id);
      assert.ok(!bytes.toString().includes('SECRET'));
      const [stored] = await db`SELECT artifact_ciphertext FROM admin_export_job WHERE id=${id}`;
      assert.ok(!stored.artifact_ciphertext.includes('fixture_change'));
      await db`UPDATE admin_user SET permissions='["admin.records.read"]' WHERE id=${f.admin}`;
      const deniedActor = {
        ...actor,
        sessionId: await issuePortalSession(db, 'admin', f.admin, 3600),
      };
      await assert.rejects(service.exportDownload(db, deniedActor, id, false, env), {
        code: 'CAPABILITY_REQUIRED',
      });
      await db`UPDATE admin_user SET permissions=NULL WHERE id=${f.admin}`;
      actor.sessionId = await issuePortalSession(db, 'admin', f.admin, 3600);
      await db`UPDATE admin_export_job SET expires_at=now()-interval '1 second' WHERE id=${id}`;
      await assert.rejects(service.exportDownload(db, actor, id, false, env), {
        code: 'EXPORT_EXPIRED',
      });
      await service.runExportJobs(db, { env });
      assert.equal(
        (await db`SELECT artifact_ciphertext FROM admin_export_job WHERE id=${id}`)[0]
          .artifact_ciphertext,
        null,
      );
      assert.equal(JSON.parse(await service.exportDownload(db, actor, id, true, env)).rowCount, 1);
      // Payments: no joins to multiply rows, explicit environment, identical source projections.
      for (const environment of ['test', 'live', 'simulated']) {
        const p = await service.createExport(db, actor, {
          ...base,
          requestKey: randomUUID(),
          dataset: 'payment_orders',
          filters: service.defaultFilters(),
          environment,
        });
        await service.processExport(db, p.id, { env });
        const exported = JSON.parse(
          await service.exportDownload(db, actor, p.id, false, env),
        ).items;
        const expected =
          await db`SELECT id FROM payment_order WHERE environment=${environment} ORDER BY created_at,id`;
        assert.deepEqual(
          exported.map((r) => r.id),
          expected.map((r) => r.id),
        );
        assert.ok(exported.every((r) => r.environment === environment));
        assert.ok(!JSON.stringify(exported).includes('provider_payment_id'));
      }
      await db`UPDATE admin_user SET permissions='["admin.audit.read","admin.audit.write"]' WHERE id=${ro.id}`;
      reader.sessionId = await issuePortalSession(db, 'admin', ro.id, 3600);
      await assert.rejects(
        service.createExport(db, reader, {
          ...base,
          dataset: 'payment_orders',
          filters: service.defaultFilters(),
          environment: 'test',
        }),
        { code: 'CAPABILITY_REQUIRED' },
      );
      const dates = { rentableId: f.listing, from: '2026-10-01', to: '2026-10-02' };
      await openBookingDates(db, f.owner, dates);
      await openBookingDates(db, f.owner, dates);
      const receipts =
        await db`SELECT id FROM audit_log WHERE action='calendar_dates_added' ORDER BY at,id`;
      const initial = (await service.auditDetail(db, actor, receipts[0].id)).operationReceipt,
        next = (await service.auditDetail(db, actor, receipts[1].id)).operationReceipt;
      assert.equal(initial.scope.added, 4);
      assert.equal(next.scope.added, 0);
      assert.equal(next.scope.skipped, 4);
      assert.equal((await service.auditDetail(db, reader, receipts[0].id)).operationReceipt, null);
      const rp = await service.createExport(db, actor, {
        ...base,
        requestKey: randomUUID(),
        dataset: 'operation_receipts',
        filters: service.defaultFilters(),
      });
      await service.processExport(db, rp.id, { env });
      assert.equal(
        JSON.parse(await service.exportDownload(db, actor, rp.id, false, env)).items.length,
        2,
      );
      await db`INSERT INTO audit_log(actor_type,entity,action) VALUES ('system','fixture','fixture_change')`;
      const small = await service.createExport(db, actor, {
        ...base,
        requestKey: randomUUID(),
        limit: 1,
      });
      await service.processExport(db, small.id, { env });
      const failed = (await service.exportDetail(db, actor, small.id)).job;
      assert.equal(failed.errorCode, 'EXPORT_BOUNDS_EXCEEDED');
      assert.equal(failed.receipt, null);
      const revoked = await service.createExport(db, reader, { ...base, requestKey: randomUUID() });
      await db`UPDATE admin_user SET permissions='["admin.audit.read"]' WHERE id=${ro.id}`;
      await service.processExport(db, revoked.id, { env });
      assert.equal(
        (await db`SELECT error_code FROM admin_export_job WHERE id=${revoked.id}`)[0].error_code,
        'CAPABILITY_REQUIRED',
      );
      await db`UPDATE portal_session SET revoked_at=now() WHERE id=${actor.sessionId}`;
      await assert.rejects(service.exportDownload(db, actor, rp.id, true, env), {
        statusCode: 401,
      });
      const audits = await db`SELECT action,after FROM audit_log WHERE entity='admin_audit'`;
      for (const action of [
        'audit_search_read',
        'audit_event_read',
        'export_queued',
        'export_failed',
        'export_retried',
        'export_completed',
        'export_downloaded',
        'export_receipt_downloaded',
      ])
        assert.ok(audits.some((r) => r.action === action));
      assert.ok(!JSON.stringify(audits).includes('SECRET'));
      await assert.rejects(db`DELETE FROM audit_log WHERE id=${event.id}`); // Existing append-only enforcement remains.
      await assert.rejects(db`UPDATE audit_log SET reason='changed' WHERE id=${event.id}`);
      await assert.rejects(db`TRUNCATE audit_log`);
    } finally {
      await fixture.drop();
    }
  },
);
