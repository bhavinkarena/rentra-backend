import express from 'express';
// CP27 fixture only: migrations and fake storage in a disposable localhost database.
import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from './listing-review-fixture.js';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { hashPassword, generateTotpSecret } from '@/services/auth/admin-crypto.js';
import { runPrivacyJobs } from '@/services/customer/privacy-fulfillment.js';
import { SignJWT } from 'jose';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
globalThis.__rentraSql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3107',
  SESSION_SECRET: 'cp27-local-fixture-signing-secret',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
});
const f = await seedReviewFixture(fixture.sql),
  b = await seedConfirmedBooking(fixture.sql, f.listing),
  ids = { admin: f.admin, limited: f.limited, customer: b.customer },
  tokens = {};
await fixture.sql`UPDATE booking SET state='cancelled' WHERE order_id=${b.order}`;
const [ro] =
  await fixture.sql`INSERT INTO admin_user(email,name,password_hash,totp_secret,permissions) VALUES ('readonly@fixture.invalid','Readonly',${hashPassword('Fixture password 123!')},${generateTotpSecret()},'["admin.privacy.read"]') RETURNING id`;
ids.readonly = ro.id;
for (const kind of ['admin', 'readonly', 'limited']) {
  const sessionId = await issuePortalSession(fixture.sql, 'admin', ids[kind], 3600);
  if (kind === 'readonly') ids.readonlySession = sessionId;
  tokens[kind] = await new SignJWT({ adminId: ids[kind], sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
const { encryptSession } = await import('@/services/auth/session-crypto.js');
for (const kind of ['customer', 'foreign']) {
  if (kind === 'foreign') {
    const [c] =
      await fixture.sql`INSERT INTO "user"(role,account_status,name,phone) VALUES ('customer','active','Foreign Guest','9000000022') RETURNING id`;
    ids.foreign = c.id;
    await fixture.sql`INSERT INTO customer_profile(user_id) VALUES (${c.id})`;
  }
  const [s] =
    await fixture.sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${ids[kind]},now()+interval '1 day') RETURNING id`;
  tokens[kind] = await encryptSession({ role: 'customer', userId: ids[kind], sessionId: s.id });
}
for (const kind of ['access', 'deletion']) {
  const [r] =
    await fixture.sql`INSERT INTO customer_privacy_request(customer_id,kind) VALUES (${b.customer},${kind}) RETURNING id`;
  ids[kind] = r.id;
}
await fixture.sql`INSERT INTO customer_favourite(customer_id,rentable_id) VALUES (${b.customer},${f.listing})`;
await writeFile(process.env.CP27_GATE_FIXTURE, JSON.stringify({ ids, tokens }));
const { createApp } = await import('@/app.js');
const app = express();
// Fixture-only control; the production app exposes no such endpoint.
app.get('/__fixture/expire', async (_req, res) => {
  await fixture.sql`UPDATE privacy_job SET expires_at=now()-interval '1 second' WHERE request_id=${ids.access}`;
  res.json({ ok: true });
});
app.get('/__fixture/revoke-readonly', async (_req, res) => {
  await fixture.sql`UPDATE portal_session SET revoked_at=now() WHERE id=${ids.readonlySession}`;
  res.json({ ok: true });
});
app.use(createApp());
const server = app.listen(4107, () => console.log('CP27 disposable API ready on 4107'));
let busy = false,
  failOnce = true;
const tick = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await runPrivacyJobs(fixture.sql, {
      destroyPhoto: async () => true,
      beforeStage: (stage) => {
        if (stage === 2 && failOnce) {
          failOnce = false;
          throw Error('Fixture stage failure');
        }
      },
    });
  } catch {
    console.error('Fixture worker failed');
  } finally {
    busy = false;
  }
}, 1500);
async function stop() {
  clearInterval(tick);
  while (busy) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => server.close(r));
  await fixture.drop();
  process.exit(0);
}
process.stdin.on('data', (d) => {
  if (String(d).includes('stop')) void stop();
});
