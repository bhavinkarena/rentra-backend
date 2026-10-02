import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
const sql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  PORT: '4143',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3143',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3143',
  SESSION_SECRET: 'owner-phase3-browser-fixture-secret-only',
  DEV_OTP_BYPASS: 'true',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
  LOG_FORMAT: 'off',
});
globalThis.__rentraSql = sql;
const f = await seedReviewFixture(sql);
await sql`UPDATE "user" SET account_status='pending_application',name='New Owner',client_type='owner',email_verified_at=now() WHERE id=${f.other}`;
const [app] =
  await sql`INSERT INTO client_application(user_id,status,legal_name,residential_address,pincode) VALUES (${f.other},'draft','New Owner','123 Main Street, Surat','395007') RETURNING id`;
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const { encryptSession } = await import('../../src/services/auth/session-crypto.js');
const tokens = {};
for (const [kind, id] of [
  ['pending', f.other],
  ['owner', f.owner],
])
  tokens[kind] = await encryptSession({
    role: 'client',
    userId: id,
    sessionId: await issuePortalSession(sql, 'client', id, 3600),
  });
await writeFile(
  process.env.OWNER_ONBOARDING_FIXTURE,
  JSON.stringify({ databaseUrl: fixture.url, ids: f, app: app.id, tokens }),
);
// Private storage is faked only in this disposable browser fixture.
const { Writable } = await import('node:stream');
const { v2: cloudinary } = await import('cloudinary');
cloudinary.uploader.upload_stream = (options, callback) => {
  let bytes = 0;
  return new Writable({
    write(chunk, _encoding, next) {
      bytes += chunk.length;
      next();
    },
    final(next) {
      callback(null, {
        public_id: options.public_id,
        bytes,
        width: 1600,
        height: 1000,
        format: 'jpg',
      });
      next();
    },
  });
};
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(4143, '127.0.0.1', () =>
  console.log('Disposable browser API ready on 4143'),
);
process.on('SIGINT', async () => {
  server.close();
  await fixture.drop();
  process.exit();
});
