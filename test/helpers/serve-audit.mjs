// Synthetic CP28 browser fixture. Never connects to the configured database.
import express from 'express';
import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
import { seedFinanceFixture } from './finance-fixture.js';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { hashPassword, generateTotpSecret } from '@/services/auth/admin-crypto.js';
import { runExportJobs } from '@/services/admin/audit-browser.js';
import { openBookingDates } from '@/services/booking/owner-settings.js';
import { SignJWT } from 'jose';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
globalThis.__rentraSql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3108',
  SESSION_SECRET: 'cp28-local-fixture-signing-secret',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
});
const f = await seedReviewFixture(fixture.sql);
await seedFinanceFixture(fixture.sql, f);
const ids = { admin: f.admin, other: f.second, limited: f.limited },
  tokens = {},
  sessions = {};
const [ro] =
  await fixture.sql`INSERT INTO admin_user(email,name,password_hash,totp_secret,permissions) VALUES ('audit-read@fixture.invalid','Read audit',${hashPassword('Fixture password 123!')},${generateTotpSecret()},'["admin.audit.read"]') RETURNING id`;
ids.readonly = ro.id;
for (const kind of ['admin', 'other', 'limited', 'readonly']) {
  sessions[kind] = await issuePortalSession(fixture.sql, 'admin', ids[kind], 3600);
  tokens[kind] = await new SignJWT({ adminId: ids[kind], sessionId: sessions[kind] })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
const [event] =
  await fixture.sql`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,before,after,reason) VALUES ('admin',${f.admin},'rentable',${f.listing},'fixture_change','{"state":"active","password":"SECRET-PASSWORD"}','{"state":"blocked","email":"PRIVATE@fixture.invalid","count":2}','SECRET raw identity reference') RETURNING id`;
ids.event = event.id;
await openBookingDates(fixture.sql, f.owner, {
  rentableId: f.listing,
  from: '2026-10-01',
  to: '2026-10-02',
});
const [receipt] = await fixture.sql`SELECT id FROM audit_log WHERE action='calendar_dates_added'`;
ids.operation = receipt.id;
await writeFile(process.env.CP28_GATE_FIXTURE, JSON.stringify({ ids, tokens }));
const { createApp } = await import('@/app.js');
const app = express();
app.get('/__fixture/expire/:id', async (req, res) => {
  await fixture.sql`UPDATE admin_export_job SET expires_at=now()-interval '1 second' WHERE id=${req.params.id}`;
  res.json({ ok: true });
});
app.get('/__fixture/revoke', async (_req, res) => {
  await fixture.sql`UPDATE portal_session SET revoked_at=now() WHERE id=${sessions.admin}`;
  res.json({ ok: true });
});
app.use(createApp());
const server = app.listen(4117, () => console.log('CP28 disposable API ready on 4117'));
let busy = false,
  failOnce = true;
const tick = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await runExportJobs(fixture.sql, {
      beforeBuild: (j) => {
        if (j.reason.includes('injected failure') && failOnce) {
          failOnce = false;
          throw Error('Synthetic failure');
        }
      },
    });
  } finally {
    busy = false;
  }
}, 1200);
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
