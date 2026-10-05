// Phase 2 fixture: explicit disposable localhost database; never load .env.
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from './disposable-db.js';
import { SignJWT } from 'jose';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { ADMIN_CAPABILITIES } from '@/services/auth/capabilities.js';

assert.ok(process.env.ADMIN_NAV_FIXTURE, 'Set ADMIN_NAV_FIXTURE to a private temporary file');
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
globalThis.__rentraSql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3162',
  SESSION_SECRET: 'admin-navigation-disposable-local-secret-only',
  LOG_FORMAT: 'off',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
});
const tokens = {};
for (const [role, permissions] of Object.entries({
  full: null,
  readonly: ADMIN_CAPABILITIES.filter((c) => c.endsWith('.read')),
  records: ['admin.records.read'],
  customers: ['admin.customers.read'],
  finance: ['admin.payments.read'],
  applications: ['admin.applications.read'],
  empty: [],
})) {
  const [admin] = await fixture.sql`INSERT INTO admin_user(email,name,password_hash,permissions)
    VALUES (${role + '@fixture.invalid'},${role},'fixture-only',${permissions == null ? null : fixture.sql.json(permissions)}) RETURNING id`;
  tokens[role] = await new SignJWT({
    adminId: admin.id,
    sessionId: await issuePortalSession(fixture.sql, 'admin', admin.id, 3600),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
const [owner] =
  await fixture.sql`INSERT INTO "user"(email,role,account_status,name,phone,client_type,email_verified_at,phone_verified_at)
  VALUES ('owner@fixture.invalid','client','pending_application','Fixture Owner','9999999999','owner',now(),now()) RETURNING id`;
const [application] =
  await fixture.sql`INSERT INTO client_application(user_id,status,legal_name,residential_address,pincode,submitted_at,consent_at)
  VALUES (${owner.id},'submitted','Fixture Owner','12 Ring Road','395007',now() - interval '60 hours',now()) RETURNING id`;
const { encryptSession } = await import('@/services/auth/session-crypto.js');
tokens.owner = await encryptSession({
  userId: owner.id,
  role: 'client',
  sessionId: await issuePortalSession(fixture.sql, 'client', owner.id, 3600),
});
await writeFile(
  process.env.ADMIN_NAV_FIXTURE,
  JSON.stringify({ tokens, application: application.id, owner: owner.id }),
);
const { createApp } = await import('@/app.js');
const server = createApp().listen(4162, '127.0.0.1', () =>
  console.log('Admin navigation fixture ready on 4162'),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(resolve));
  await fixture.drop();
  process.exit(0);
}
process.stdin.on('data', (data) => {
  if (String(data).includes('stop')) void stop();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
