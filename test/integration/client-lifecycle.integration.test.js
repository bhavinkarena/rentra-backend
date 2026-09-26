import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';

// Explicit disposable server only (e.g. postgresql://postgres@127.0.0.1:55432/postgres).
test(
  'CP03 client directory, impact preview and version-guarded suspend/reinstate',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.SESSION_SECRET ??= 'cp03-disposable-fixture-signing-secret-only';
      const { runWithContext, getContext } = await import('@/runtime/context.js');
      const clients = await import('@/services/admin/clients.js');
      const { issuePortalSession, validPortalSession } =
        await import('@/services/auth/portal-sessions.js');
      const { getListingByCode, getListingIdByCode } = await import('@/services/db/queries.js');

      const [admin] =
        await sql`INSERT INTO admin_user(email,password_hash,name) VALUES ('cp03@fixture.invalid','x','CP03') RETURNING id`;
      const insertClient = async (email, status, name) =>
        (
          await sql`INSERT INTO "user"(email,role,account_status,name,phone)
          VALUES (${email},'client',${status},${name},${String(Math.random()).slice(2, 12)}) RETURNING id`
        )[0].id;
      const owner = await insertClient('owner@fixture.invalid', 'active', 'Asha Owner');
      const pending = await insertClient(
        'pending@fixture.invalid',
        'pending_application',
        'Pat Pending',
      );
      const blocked = await insertClient('blocked@fixture.invalid', 'blocked', 'Bo Blocked');
      // Active without an approved application row (seeded or legacy account).
      const legacy = await insertClient('legacy@fixture.invalid', 'active', 'Lee Legacy');
      await sql`INSERT INTO client_application(user_id,status) VALUES (${owner},'approved'),(${pending},'draft'),(${blocked},'rejected')`;
      const [customer] =
        await sql`INSERT INTO "user"(phone,role,account_status) VALUES ('9000011111','customer','active') RETURNING id`;
      const [city] =
        await sql`INSERT INTO city(slug,name,state) VALUES ('surat','Surat','Gujarat') RETURNING id`;
      const [area] =
        await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},'dumas','Dumas') RETURNING id`;
      const [category] =
        await sql`INSERT INTO category(slug,name) VALUES ('farmhouse','Farmhouse') RETURNING id`;
      const listing = async (title, status, code) =>
        (
          await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,status)
          VALUES (${owner},${`${code}-slug`},${title},${category.id},${city.id},${area.id},${code},${status}) RETURNING id`
        )[0].id;
      const live = await listing('Riverside Farm', 'live', 'LIVE1');
      await listing('Quiet Paused Farm', 'paused', 'PAUS1');
      const visit = async (reference, state, days) =>
        sql`INSERT INTO booking(reference,rentable_id,customer_id,day,slot,amount_rent,amount_fee,state,starts_at,ends_at)
          VALUES (${reference},${live},${customer.id},(now() + ${days} * interval '1 day')::date,'day',1000,80,${state},
            now() + ${days} * interval '1 day', now() + ${days} * interval '1 day' + interval '8 hours')`;
      await visit('UPC1', 'confirmed', 5);
      await visit('PAST1', 'completed', -5);
      await visit('CANC1', 'cancelled', 7);
      const session = {
        role: 'client',
        userId: owner,
        sessionId: await issuePortalSession(sql, 'client', owner, 3600),
      };

      // Directory: authoritative counts, filters, bounded search.
      const all = await clients.listClients(sql, {});
      assert.equal(all.total, 4);
      assert.deepEqual(
        { ...all.counts },
        { all: 4, active: 2, pending_application: 1, suspended: 0, blocked: 1 },
      );
      const found = await clients.listClients(sql, { q: 'asha' });
      assert.deepEqual(
        found.items.map((i) => [i.email, i.liveCount, i.upcomingVisits]),
        [['owner@fixture.invalid', 1, 1]],
      );
      assert.equal((await clients.listClients(sql, { status: 'blocked' })).items[0].id, blocked);
      assert.equal((await clients.listClients(sql, { q: '%' })).total, 0, 'wildcards are literal');

      // Detail and impact preview.
      const detail = await clients.readClient(sql, owner);
      assert.equal(detail.client.lifecycleVersion, 1);
      assert.equal(detail.upcoming.total, 1);
      assert.equal(detail.upcoming.items[0].reference, 'UPC1');
      assert.equal(detail.lifecycle.action, 'suspend');
      assert.equal(detail.lifecycle.allowed, true);
      assert.deepEqual(detail.lifecycle.effects, {
        liveListings: 1,
        upcomingVisits: 1,
        openSessions: 1,
      });
      assert.equal('payoutUpiId' in detail.client, false, 'no payout fields in the detail');
      for (const id of [randomUUID(), 'not-a-uuid']) {
        await assert.rejects(clients.readClient(sql, id), { statusCode: 404 });
      }

      const run = (fn) => runWithContext({ req: {} }, fn);
      const command = (clientId, action, input) =>
        clients.changeLifecycle(sql, {
          adminId: admin.id,
          clientId,
          action,
          input,
          ip: '127.0.0.1',
        });

      // Validation and stale versions change nothing.
      await assert.rejects(
        run(() => command(owner, 'suspend', { expectedVersion: 1 })),
        {
          statusCode: 422,
        },
      );
      await assert.rejects(
        run(() => command(owner, 'suspend', { reason: 'fraud report', expectedVersion: 9 })),
        { statusCode: 409, code: 'LIFECYCLE_CONFLICT' },
      );
      assert.equal((await clients.readClient(sql, owner)).client.accountStatus, 'active');

      // Suspend: one committed effect, sessions revoked, listing leaves public reads,
      // the upcoming visit stays confirmed.
      let revalidated;
      const suspended = await run(async () => {
        const result = await command(owner, 'suspend', {
          reason: 'Guest safety report under review',
          expectedVersion: 1,
        });
        revalidated = [...getContext().revalidate];
        return result;
      });
      assert.deepEqual([suspended.accountStatus, suspended.lifecycleVersion], ['suspended', 2]);
      assert.ok(revalidated.includes('/listing/LIVE1-slug-LIVE1'), revalidated.join());
      assert.equal(await validPortalSession(sql, session, 'client'), false);
      assert.equal(await getListingByCode('LIVE1'), null);
      assert.equal(await getListingIdByCode('LIVE1'), null);
      const [{ state }] = await sql`SELECT state FROM booking WHERE reference='UPC1'`;
      assert.equal(state, 'confirmed');
      await assert.rejects(
        run(() => command(owner, 'suspend', { reason: 'double click', expectedVersion: 1 })),
        { statusCode: 409 },
      );
      const audits = await sql`SELECT action, reason, after FROM audit_log
        WHERE entity='user' AND entity_id=${owner} AND actor_type='admin'`;
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, 'client_suspended');
      assert.equal(audits[0].reason, 'Guest safety report under review');
      assert.equal(audits[0].after.impact.upcomingVisits, 1);

      const history = (await clients.readClient(sql, owner)).history.map((h) => h.action);
      assert.ok(
        history.includes('client_suspended') && history.includes('access_sessions_revoked'),
      );

      // Two admins reinstating from the same reviewed version: exactly one wins.
      const race = await Promise.allSettled([
        run(() => command(owner, 'reinstate', { reason: 'Report cleared', expectedVersion: 2 })),
        run(() => command(owner, 'reinstate', { reason: 'Report cleared', expectedVersion: 2 })),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(race.find((r) => r.status === 'rejected').reason.statusCode, 409);
      const after = await clients.readClient(sql, owner);
      assert.deepEqual([after.client.accountStatus, after.client.lifecycleVersion], ['active', 3]);
      assert.equal(
        await validPortalSession(sql, session, 'client'),
        false,
        'old session stays revoked',
      );
      assert.ok(await getListingByCode('LIVE1'));
      const [{ status: pausedStatus }] =
        await sql`SELECT status FROM rentable WHERE public_code='PAUS1'`;
      assert.equal(pausedStatus, 'paused');

      // Pending onboarding returns to onboarding; blocked is not a lifecycle transition here.
      await run(() =>
        command(pending, 'suspend', { reason: 'Duplicate account', expectedVersion: 1 }),
      );
      const back = await run(() =>
        command(pending, 'reinstate', { reason: 'Confirmed unique', expectedVersion: 2 }),
      );
      assert.equal(back.accountStatus, 'pending_application');
      for (const action of ['suspend', 'reinstate']) {
        await assert.rejects(
          run(() => command(blocked, action, { reason: 'try it', expectedVersion: 1 })),
          { statusCode: 409, code: 'LIFECYCLE_NOT_ALLOWED' },
        );
      }
      assert.equal((await clients.previewLifecycle(sql, blocked, 'reinstate')).allowed, false);

      // Reinstatement restores the pre-suspension status, not a guess from the application.
      await run(() =>
        command(legacy, 'suspend', { reason: 'Chargeback review', expectedVersion: 1 }),
      );
      const restored = await run(() =>
        command(legacy, 'reinstate', { reason: 'Chargeback resolved', expectedVersion: 2 }),
      );
      assert.equal(restored.accountStatus, 'active');
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
