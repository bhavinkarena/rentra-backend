// CP26 disposable API/browser fixture. Never connects to the configured database.
import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { hashPassword, generateTotpSecret } from '@/services/auth/admin-crypto.js';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { SignJWT } from 'jose';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
globalThis.__rentraSql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
  SESSION_SECRET: 'cp26-local-fixture-signing-secret',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
});
const ids = {},
  tokens = {},
  password = 'Fixture password 123!';
for (const kind of ['admin', 'second', 'readonly', 'limited']) {
  const [row] =
    await fixture.sql`INSERT INTO admin_user(email,name,password_hash,totp_secret,permissions)
    VALUES (${kind + '@fixture.invalid'},${kind + ' operator'},${hashPassword(password)},${generateTotpSecret()},
      ${['admin', 'second'].includes(kind) ? null : fixture.sql.json(kind === 'readonly' ? ['admin.security.read'] : ['admin.records.read'])}) RETURNING id`;
  ids[kind] = row.id;
  const sessionId = await issuePortalSession(fixture.sql, 'admin', row.id, 3600);
  tokens[kind] = await new SignJWT({ adminId: row.id, sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
const [owner] =
  await fixture.sql`INSERT INTO "user"(email,role,account_status) VALUES ('owner@fixture.invalid','client','active') RETURNING id`;
const { encryptSession } = await import('@/services/auth/session-crypto.js');
tokens.owner = await encryptSession({
  userId: owner.id,
  role: 'client',
  sessionId: await issuePortalSession(fixture.sql, 'client', owner.id, 3600),
});
await writeFile(process.env.CP26_GATE_FIXTURE, JSON.stringify({ ids, tokens, password }));
const { createApp } = await import('@/app.js');
const server = createApp().listen(4106, () => console.log('CP26 disposable API ready on 4106'));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((r) => server.close(r));
  await fixture.drop();
  process.exit(0);
}
process.stdin.on('data', (d) => {
  if (String(d).includes('stop')) void stop();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
