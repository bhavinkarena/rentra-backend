// Epic 4 browser QA: local disposable supply only. Credentials never leave ignored tmp/.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
import { seedFinanceFixture } from './finance-fixture.js';
import { payoutTransferProvider } from './payout-transfer-provider.js';
import { fileBackedRazorpay } from './fake-razorpay.mjs';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';

const control = new URL(process.env.PORTAL_TEST_DATABASE_URL);
assert.equal(control.hostname, '127.0.0.1');
assert.equal(control.port, '55432');
assert.equal(control.pathname, '/postgres');
const scratch = resolve('tmp/epic4qa');
await mkdir(scratch, { recursive: true });
const fixture = await createDisposableDatabase(control.href);
let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (server) await new Promise((done) => server.close(done));
  await fixture.drop();
}
try {
  const { sql } = fixture;
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    NODE_ENV: 'test',
    SESSION_SECRET: 'epic4-local-fixture-secret-only-0000',
    NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3114',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:3114',
    RAZORPAY_KEY_ID: 'rzp_test_EPIC4KEY',
    RAZORPAY_KEY_SECRET: 'epic4-fake-provider-secret',
    RAZORPAY_WEBHOOK_SECRET: 'epic4-fake-webhook-secret',
    LOG_FORMAT: 'off',
  });
  globalThis.__rentraSql = sql;
  globalThis.__rentraEvidenceStore = memoryEvidenceStore();
  globalThis.__rentraPaymentFetcher = fileBackedRazorpay(resolve(scratch, 'provider.json'));
  // Fail closed: the only outbound host is the file-backed fake provider.
  globalThis.fetch = (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.razorpay.com');
    return globalThis.__rentraPaymentFetcher(url, init);
  };
  const f = await seedReviewFixture(sql);
  const cash = await seedFinanceFixture(sql, f);
  await sql`UPDATE rentable SET status='live',published_at=now() WHERE id=${f.listing}`;
  const { reservePayoutTransfer, dispatchPayoutTransfer } =
    await import('../../src/services/finance/payout-transfer-fixtures.js');
  const payoutProvider = payoutTransferProvider();
  const admin = { kind: 'admin', id: f.admin };
  // Completed Test Razorpay order (rent 1000 + fee 80), owner payout succeeded: owner-funded
  // obligations become due at execution.
  const paidOrder = async () => {
    const s = await cash.add('test', { provider: 'razorpay' });
    const fx = await reservePayoutTransfer(
      sql,
      admin,
      { sourceId: s.allocationId, requestKey: randomUUID() },
      payoutProvider,
    );
    await dispatchPayoutTransfer(sql, admin, fx.id, {}, payoutProvider);
    return s;
  };
  const orders = { 1440: await paidOrder(), 390: await paidOrder() };
  const [{ customer_id: customer }] =
    await sql`SELECT customer_id FROM booking_order WHERE id=${orders[1440].orderId}`;
  await sql`UPDATE "user" SET phone='9000000044',profile_completed_at=now(),profile_version=1,consent_updated_at=now() WHERE id=${customer}`;
  // An unanswered case filed 13 hours ago: the aged view.
  const aged = await cash.add('test', { provider: 'razorpay' });
  const key = randomUUID();
  const [agedCase] =
    await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late,created_at,updated_at)
    VALUES (${'SUP-AGED-' + key.slice(0, 8)},${customer},${aged.orderId},'stay_issue','Aged fixture case',
    ${JSON.stringify({ stayIssue: { issueType: 'cleanliness', remedy: 'fix_during_stay', affected: [{ visitId: aged.bookingId }] } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',now()-interval '14 hours',false,now()-interval '13 hours',now()-interval '13 hours') RETURNING id`;
  const [reader] =
    await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES ('support-reader@fixture.invalid','fixture-only','Support reader','["admin.support.read"]'::jsonb) RETURNING id`;

  const { encryptSession } = await import('@/services/auth/session-crypto.js');
  const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
  const tokens = {};
  const [customerSession] =
    await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${customer},now()+interval '1 day') RETURNING id`;
  tokens.customer = await encryptSession({
    userId: customer,
    role: 'customer',
    sessionId: customerSession.id,
  });
  tokens.owner = await encryptSession({
    userId: f.owner,
    role: 'client',
    sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
  });
  for (const [name, id] of [
    ['admin', f.admin],
    ['supportReader', reader.id],
  ])
    tokens[name] = await new SignJWT({
      adminId: id,
      sessionId: await issuePortalSession(sql, 'admin', id, 3600),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('rentra:admin')
      .setIssuedAt()
      .setExpirationTime('2h')
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const [{ udt_name: geometryType }] =
    await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
  if (geometryType !== 'geometry') {
    await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
    await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  }
  await writeFile(
    resolve(scratch, 'fixture.json'),
    JSON.stringify({
      databaseUrl: fixture.url,
      ids: { ...f, customer, orders, agedCase: agedCase.id, reader: reader.id },
      tokens,
    }),
    { mode: 0o600 },
  );
  const { createApp } = await import('@/app.js');
  server = createApp().listen(4114, '127.0.0.1', () =>
    console.log('Epic 4 disposable API ready at 127.0.0.1:4114'),
  );
  server.on('error', async (error) => {
    console.error(error.message);
    await stop();
    process.exitCode = 1;
  });
  process.stdin.on('data', (data) => {
    if (String(data).includes('stop')) void stop().then(() => process.exit(0));
  });
  process.on('SIGINT', () => void stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
} catch (error) {
  await stop();
  throw error;
}
