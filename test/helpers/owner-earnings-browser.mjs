import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
import { seedFinanceFixture } from './finance-fixture.js';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
  sql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  PORT: '4148',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3148',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3148',
  SESSION_SECRET: 'owner-phase8-browser-fixture-secret-only',
  DEV_OTP_BYPASS: 'true',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
  LOG_FORMAT: 'off',
});
globalThis.__rentraSql = sql;
const ids = await seedReviewFixture(sql),
  money = await seedFinanceFixture(sql, ids);
await sql`INSERT INTO payment_gateway_config(version,provider,environment,enabled,collection_purpose,changed_by) VALUES(1,'razorpay','test',true,'full',${ids.admin})`;
await sql`UPDATE "user" SET email_verified_at=now() WHERE id IN (${ids.owner},${ids.other})`;
for (let i = 0; i < 34; i += 1) await money.add('test');
const [{ udt_name: type }] =
  await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
if (type !== 'geometry') {
  await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
}
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const { encryptSession } = await import('../../src/services/auth/session-crypto.js');
const tokens = {},
  sessions = {};
for (const kind of ['owner', 'other']) {
  sessions[kind] = await issuePortalSession(sql, 'client', ids[kind], 3600);
  tokens[kind] = await encryptSession({
    role: 'client',
    userId: ids[kind],
    sessionId: sessions[kind],
  });
}
await sql`UPDATE auth_session SET created_at=now()-interval '1 hour' WHERE id=${sessions.owner}`;
await writeFile(
  process.env.OWNER_EARNINGS_FIXTURE,
  JSON.stringify({ databaseUrl: fixture.url, ids, money, tokens, sessions }),
  { mode: 0o600 },
);
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(4148, '127.0.0.1', () =>
  console.log('Disposable earnings API ready on 4148'),
);
async function stop() {
  server.close();
  await fixture.drop();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'stop') void stop();
});
