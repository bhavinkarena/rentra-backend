import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  issuePortalSession,
  validPortalSession,
  revokePortalSession,
} from '@/services/auth/portal-sessions.js';

// Explicit disposable database only. Never fall back to the configured application URL.
test(
  'portal sessions revoke durably on logout, suspension, permissions and credential changes',
  { skip: !process.env.CP01_TEST_DATABASE_URL },
  async () => {
    const url = new URL(process.env.CP01_TEST_DATABASE_URL);
    assert.ok(
      ['localhost', '127.0.0.1'].includes(url.hostname),
      'Use a disposable local PostgreSQL server',
    );
    const control = postgres(url.toString());
    const name = `cp01_${randomUUID().replaceAll('-', '')}`;
    await control.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const database = postgres(url.toString(), { max: 4 });
    try {
      await database.unsafe(`CREATE TABLE "user" (id uuid PRIMARY KEY, role text, account_status text, email text,
      name text, phone text, email_verified_at timestamptz, phone_verified_at timestamptz,
      preferred_locale text, client_type text, kyc_status text, payout_upi_id text, person_id uuid);
      CREATE TABLE admin_user (id uuid PRIMARY KEY, is_active boolean, email text, password_hash text, totp_secret text, name text,last_login_at timestamptz);
      CREATE TABLE customer_session (id uuid PRIMARY KEY,user_id uuid,expires_at timestamptz,revoked_at timestamptz);
      CREATE TABLE audit_log (actor_type text,actor_id uuid,entity text,entity_id text,action text,after jsonb);`);
      const migration = await readFile(
        new URL('../../drizzle/0022_portal_access.sql', import.meta.url),
        'utf8',
      );
      await database.begin(async (tx) => {
        for (const statement of migration.split('--> statement-breakpoint'))
          await tx.unsafe(statement);
      });
      const owner = randomUUID(),
        other = randomUUID(),
        adminId = randomUUID();
      await database`INSERT INTO "user"(id,role,account_status,email) VALUES (${owner},'client','active','owner@test.invalid'),(${other},'client','active','other@test.invalid')`;
      await database`INSERT INTO admin_user(id,is_active,email,password_hash) VALUES (${adminId},true,'admin@test.invalid','original')`;
      const clientClaims = async () => ({
        role: 'client',
        userId: owner,
        sessionId: await issuePortalSession(database, 'client', owner, 3600),
      });
      const adminClaims = async () => ({
        adminId,
        sessionId: await issuePortalSession(database, 'admin', adminId, 3600),
      });
      const first = await clientClaims(),
        second = await clientClaims();
      assert.equal(await validPortalSession(database, first, 'client'), true);
      assert.equal(
        await validPortalSession(database, { ...first, userId: other }, 'client'),
        false,
      );
      assert.equal(
        await validPortalSession(database, { adminId, sessionId: first.sessionId }, 'admin'),
        false,
      );
      await revokePortalSession(database, first, 'client');
      await revokePortalSession(database, first, 'client');
      assert.equal(await validPortalSession(database, first, 'client'), false);
      assert.equal(await validPortalSession(database, second, 'client'), true);
      assert.equal(
        (await database`SELECT * FROM audit_log WHERE action='session_revoked'`).length,
        1,
      );
      await database`UPDATE "user" SET account_status='suspended' WHERE id=${owner}`;
      assert.equal(await validPortalSession(database, second, 'client'), false);
      assert.equal(await issuePortalSession(database, 'client', owner, 3600), null);
      await database`UPDATE "user" SET account_status='active' WHERE id=${owner}`;
      assert.equal(await validPortalSession(database, second, 'client'), false);
      for (const change of [
        "permissions='[]'::jsonb",
        "password_hash='changed'",
        "totp_secret='changed'",
        'is_active=false',
      ]) {
        const claims = await adminClaims();
        assert.equal(await validPortalSession(database, claims, 'admin'), true);
        await database.unsafe(`UPDATE admin_user SET ${change}`);
        assert.equal(await validPortalSession(database, claims, 'admin'), false);
      }
      await database`UPDATE admin_user SET is_active=true`;
      const admin = await adminClaims();
      await revokePortalSession(database, admin, 'admin');
      assert.equal(await validPortalSession(database, admin, 'admin'), false);
      const expired = await clientClaims();
      await database`UPDATE portal_session SET expires_at=now()-interval '1 second' WHERE id=${expired.sessionId}`;
      assert.equal(await validPortalSession(database, expired, 'client'), false);
      // Issuance/suspension serialize on the principal: either no token or a revoked token.
      const [raced] = await Promise.all([
        clientClaims(),
        database`UPDATE "user" SET account_status='suspended' WHERE id=${owner}`,
      ]);
      assert.equal(await validPortalSession(database, raced, 'client'), false);

      // Actual request-local DAL and Express middleware, not just a permission helper.
      globalThis.__rentraSql = database;
      process.env.DATABASE_URL = url.toString();
      process.env.SESSION_SECRET = 'cp01-disposable-fixture-signing-secret-only';
      process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
      process.env.NODE_ENV = 'test';
      process.env.CLOUDINARY_CLOUD_NAME = 'cp01-fixture';
      process.env.CLOUDINARY_API_KEY = 'cp01-fixture';
      process.env.CLOUDINARY_API_SECRET = 'cp01-fixture';
      const { runWithContext } = await import('@/runtime/context.js');
      const { encryptSession } = await import('@/services/auth/session-crypto.js');
      const { createAdminSession, destroyAdminSession } = await import('@/services/auth/admin.js');
      const { destroySession } = await import('@/services/auth/session.js');
      const { requirePortalCapability, requireAdmin } =
        await import('@/middlewares/auth.middleware.js');
      const { SignJWT } = await import('jose');
      const invoke = async (middleware, cookies, method, path) => {
        const req = { cookies, method, path };
        let result;
        await runWithContext({ req }, () =>
          middleware(req, {}, (error) => {
            result = error ?? 'allowed';
          }),
        );
        return result;
      };
      await database`UPDATE "user" SET account_status='active' WHERE id=${owner}`;
      const active = await clientClaims();
      const clientToken = await encryptSession(active);
      let adminToken;
      await runWithContext(
        {
          req: { cookies: {} },
          res: {
            cookie: (_name, token) => {
              adminToken = token;
            },
          },
        },
        () => createAdminSession(adminId),
      );
      const clientGate = requirePortalCapability('client');
      const adminGate = requirePortalCapability('admin');
      assert.equal(
        await invoke(clientGate, { rentra_session: clientToken }, 'GET', '/records/123/summary'),
        'allowed',
      );
      assert.equal(
        (await invoke(requireAdmin, { rentra_admin: clientToken }, 'GET', '/documents/123/file'))
          .statusCode,
        401,
      );
      assert.equal(
        (await invoke(clientGate, { rentra_session: adminToken }, 'GET', '/records')).statusCode,
        401,
      );
      assert.equal(
        (await invoke(adminGate, { rentra_admin: adminToken }, 'GET', '/documents/123/file'))
          .statusCode,
        403,
      );
      await database`UPDATE admin_user SET permissions=NULL`;
      assert.equal(
        (await invoke(adminGate, { rentra_admin: adminToken }, 'GET', '/documents/123/file'))
          .statusCode,
        401,
      );
      await runWithContext(
        {
          req: { cookies: {} },
          res: {
            cookie: (_name, token) => {
              adminToken = token;
            },
          },
        },
        () => createAdminSession(adminId),
      );
      assert.equal(
        await invoke(adminGate, { rentra_admin: adminToken }, 'GET', '/documents/123/file'),
        'allowed',
      );
      await runWithContext(
        { req: { cookies: { rentra_admin: adminToken } }, res: { clearCookie() {} } },
        destroyAdminSession,
      );
      assert.equal(
        (await invoke(adminGate, { rentra_admin: adminToken }, 'GET', '/documents/123/file'))
          .statusCode,
        401,
      );
      await runWithContext(
        { req: { cookies: { rentra_session: clientToken } }, res: { clearCookie() {} } },
        destroySession,
      );
      assert.equal(
        (await invoke(clientGate, { rentra_session: clientToken }, 'GET', '/records/123/summary'))
          .statusCode,
        401,
      );
      const legacy = await new SignJWT({ userId: owner, role: 'client' })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
      assert.equal(
        (await invoke(clientGate, { rentra_session: legacy }, 'GET', '/records')).statusCode,
        401,
      );
      const customer = randomUUID(),
        customerSession = randomUUID();
      await database`INSERT INTO "user"(id,role,account_status) VALUES (${customer},'customer','active')`;
      await database`INSERT INTO customer_session VALUES (${customerSession},${customer},now()+interval '1 hour',NULL)`;
      const guestToken = await encryptSession({
        userId: customer,
        role: 'customer',
        sessionId: customerSession,
      });
      assert.equal(
        (await invoke(clientGate, { rentra_session: guestToken }, 'GET', '/records')).statusCode,
        403,
      );
      const { getCurrentUser } = await import('@/services/auth/dal.js');
      const guest = await runWithContext(
        { req: { cookies: { rentra_session: guestToken } } },
        getCurrentUser,
      );
      assert.equal(guest.id, customer);
    } finally {
      await database.end();
      await control.unsafe(`DROP DATABASE "${name}"`);
      await control.end();
    }
  },
);
