import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createDisposableDatabase } from './disposable-db.js';
import {
  seedReviewFixture,
  seedConfirmedBooking,
  seedBusyOwnerVisits,
} from './listing-review-fixture.js';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
  sql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  PORT: '4143',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3143',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3143',
  SESSION_SECRET: 'owner-phase4-fixture-secret-only-1234',
  DEV_OTP_BYPASS: 'true',
  LOG_FORMAT: 'off',
});
globalThis.__rentraSql = sql;
const f = await seedReviewFixture(sql),
  booking = await seedConfirmedBooking(sql, f.listing);
const [date] =
  await sql`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date`;
await sql`UPDATE booking SET starts_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '9 hours',ends_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '18 hours',blocked_start_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '9 hours',blocked_end_at=(${date.date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '18 hours',hours_known=true,local_day=${date.date} WHERE order_id=${booking.order}`;
await sql`UPDATE booking_order SET listing_snapshot=jsonb_set(listing_snapshot,'{contact}','{"name":"Guest Test","phone":"9876543210"}') WHERE id=${booking.order}`;
await seedBusyOwnerVisits(sql, booking.order);
await sql`UPDATE "user" SET account_status='pending_application',name='New Owner' WHERE id=${f.other}`;
const [zero] =
  await sql`INSERT INTO "user"(email,role,account_status,name) VALUES('zero-owner@fixture.invalid','client','active','Zero Owner') RETURNING id`;
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const { encryptSession } = await import('../../src/services/auth/session-crypto.js');
const tokens = {};
for (const [name, id] of [
  ['owner', f.owner],
  ['pending', f.other],
  ['zero', zero.id],
])
  tokens[name] = await encryptSession({
    role: 'client',
    userId: id,
    sessionId: await issuePortalSession(sql, 'client', id, 3600),
  });
await writeFile(
  process.env.OWNER_TODAY_FIXTURE,
  JSON.stringify({ databaseUrl: fixture.url, ids: f, tokens }),
);
const { createApp } = await import('../../src/app.js');
const app = createApp();
let failing = '';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__fixture/failure' && req.method === 'POST') {
    failing = url.searchParams.get('section') || '';
    res.end('ok');
    return;
  }
  if (url.pathname === '/api/v1/partner/today' && url.searchParams.get('section') === failing) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Fixture section unavailable' }));
    return;
  }
  app(req, res);
}).listen(4143, '127.0.0.1', () => console.log('Disposable Today API ready on 4143'));
process.on('SIGINT', async () => {
  server.close();
  await fixture.drop();
  process.exit();
});
