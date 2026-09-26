// Disposable CP06 browser/API fixture. No configured database or provider is used.
import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { submitProperty } from '@/services/admin/listings.js';
import { SignJWT } from 'jose';

const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
const ids = await seedReviewFixture(fixture.sql);
globalThis.__rentraSql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
  SESSION_SECRET: 'cp06-local-fixture-signing-secret-not-for-deployment',
  CLOUDINARY_CLOUD_NAME: 'cp06-fixture',
  CLOUDINARY_API_KEY: 'cp06-fixture',
  CLOUDINARY_API_SECRET: 'cp06-fixture',
});
const { encryptSession } = await import('@/services/auth/session-crypto.js');
const tokens = {};
for (const kind of ['admin', 'second', 'limited']) {
  const sessionId = await issuePortalSession(fixture.sql, 'admin', ids[kind], 3600);
  tokens[kind] = await new SignJWT({ adminId: ids[kind], sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
for (const kind of ['owner', 'other'])
  tokens[kind] = await encryptSession({
    userId: ids[kind],
    role: 'client',
    sessionId: await issuePortalSession(fixture.sql, 'client', ids[kind], 3600),
  });
const submission = await submitProperty(fixture.sql, { id: ids.listing, clientId: ids.owner });
await writeFile(
  process.env.CP06_GATE_FIXTURE,
  JSON.stringify({ ids, tokens, submission, databaseUrl: fixture.url }),
);
const { createApp } = await import('@/app.js');
const server = createApp().listen(4106, () =>
  console.log('CP06 disposable API ready on 4106. Send stop on stdin to clean up.'),
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
