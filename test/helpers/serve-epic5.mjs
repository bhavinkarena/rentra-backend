// Epic 5 browser QA: local disposable reviews supply. Credentials never leave ignored tmp/.
// Needs a superuser local PG (notification time travel uses session_replication_role=replica).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture, makePublishable } from './listing-review-fixture.js';

const control = new URL(process.env.PORTAL_TEST_DATABASE_URL);
assert.equal(control.hostname, '127.0.0.1');
assert.equal(control.port, '55432');
assert.equal(control.pathname, '/postgres');
const scratch = resolve('tmp/epic5qa');
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
const twilio = 'AC' + 'e'.repeat(32);
const smsEnv = {
  CUSTOMER_NOTIFICATION_DELIVERY: 'twilio',
  TWILIO_ACCOUNT_SID: twilio,
  TWILIO_AUTH_TOKEN: 'epic5-fake',
  TWILIO_FROM_NUMBER: '+15005550006',
  NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3115',
  NODE_ENV: 'test',
};
// Fake Twilio: echoes the message back as delivered. Service step, not a browser action.
const sms = [];
const twilioFetcher = async (_url, init) => {
  const f = Object.fromEntries(new URLSearchParams(init.body.toString()));
  sms.push(f.Body);
  return new Response(
    JSON.stringify({
      sid: 'SM' + randomUUID().replaceAll('-', ''),
      account_sid: twilio,
      to: f.To,
      from: f.From,
      body: f.Body,
      status: 'delivered',
    }),
  );
};
try {
  const { sql } = fixture;
  Object.assign(process.env, {
    DATABASE_URL: fixture.url,
    NODE_ENV: 'test',
    SESSION_SECRET: 'epic5-local-disposable-fixture-secret-only',
    NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3115',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:3115',
    LOG_FORMAT: 'off',
  });
  globalThis.__rentraSql = sql;
  const { memoryEvidenceStore } = await import('@/services/uploads/evidence-store.js');
  globalThis.__rentraEvidenceStore = memoryEvidenceStore();
  globalThis.fetch = (url) => {
    throw new Error(`Epic 5 fixture blocks external request ${new URL(url).origin}`);
  };
  const { submitReview } = await import('@/services/reviews/service.js');
  const { processNotification } = await import('@/services/notifications/jobs.js');
  const { encryptSession } = await import('@/services/auth/session-crypto.js');
  const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
  const { SignJWT } = await import('jose');

  const f = await seedReviewFixture(sql);
  await makePublishable(sql, f.owner, f.listing);
  await sql`UPDATE rentable SET status='live',published_at=now() WHERE id=${f.listing}`;
  await sql`UPDATE category SET vertical_code='farmhouse' WHERE slug='review-farm'`;
  await sql`UPDATE vertical SET status='public' WHERE code='farmhouse'`;

  let n = 0;
  const tokens = {};
  const sessions = {};
  const guest = async (name) => {
    n++;
    const [u] =
      await sql`INSERT INTO "user"(email,phone,phone_verified_at,role,account_status,name,profile_completed_at,profile_version,consent_updated_at)
      VALUES (${`epic5-${name}@fixture.invalid`},${`90000055${String(n).padStart(2, '0')}`},now(),'customer','active',${`Guest ${name}`},now(),1,now()) RETURNING id`;
    const [s] =
      await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${u.id},now()+interval '1 day') RETURNING id`;
    sessions[name] = { role: 'customer', userId: u.id, sessionId: s.id };
    tokens[name] = await encryptSession({ userId: u.id, role: 'customer', sessionId: s.id });
    return u.id;
  };
  // A real-provenance day visit that ended `ago` before now.
  const visit = async (customer, state, ago = '1 day') => {
    const [order] =
      await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,visit_provenance,confirmed_at)
      VALUES (${`E5-${randomUUID().slice(0, 8)}`},${customer},${f.listing},'confirmed','INR','Asia/Kolkata','v1','v1','{}','{"title":"Review River Farm"}',100000,0,0,${randomUUID()},${'c'.repeat(64)},'real',now()-interval '10 days') RETURNING id`;
    const [b] =
      await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,state,visit_provenance)
      VALUES (${`V${randomUUID().slice(0, 10)}`},${f.listing},${customer},${order.id},1,((now()-${ago}::interval) AT TIME ZONE 'Asia/Kolkata')::date,'day',2,now()-${ago}::interval-interval '8 hours',now()-${ago}::interval,now()-${ago}::interval-interval '8 hours',now()-${ago}::interval,true,'INR','Asia/Kolkata',100000,0,0,${state},'real') RETURNING id`;
    return { id: b.id, order: order.id };
  };
  // Owner-recorded actual handover/return/complete (same path as the 5.3 integration test).
  const complete = async (v) => {
    let id;
    for (const [kind, next] of [
      ['handover', 'handed_over'],
      ['return', 'returned'],
      ['complete', 'completed'],
    ]) {
      id = randomUUID();
      await sql`INSERT INTO visit_evidence(id,booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,recorded_at,request_key,request_hash,visit_version)
        VALUES(${id},${v.id},${kind},'actual','owner',${f.owner},'',(SELECT starts_at FROM booking WHERE id=${v.id})+interval '1 minute',now(),${id},${'d'.repeat(64)},1)`;
      await sql`UPDATE booking SET state=${next} WHERE id=${v.id}`;
    }
    await sql`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${v.order},${'visit_' + id.replaceAll('-', '')},${JSON.stringify({ visitId: v.id, evidenceId: id, phase: 'complete', nature: 'actual' })}::text::jsonb)`;
    return v;
  };
  const deliver = async (bookingId, template) => {
    const [row] =
      await sql`SELECT id FROM notification_outbox WHERE booking_id=${bookingId} AND template=${template}`;
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role=replica`;
      await tx`UPDATE notification_outbox SET scheduled_at=now()-interval '1 minute',next_attempt_at=now() WHERE id=${row.id}`;
    });
    await processNotification(sql, row.id, { env: smsEnv, fetcher: twilioFetcher });
    return (await sql`SELECT id,state,read_at FROM notification_outbox WHERE id=${row.id}`)[0];
  };

  // 5.1: three completed visits written in the browser (clean, flagged, low-but-clean).
  const visits = {};
  for (const name of ['clean', 'flagged', 'low'])
    visits[name] = await complete(await visit(await guest(name), 'confirmed'));
  // 5.3: deliver the clean guest's invitation through the fake adapter (service step).
  const invitation = await deliver(visits.clean.id, 'review_invitation');
  // 5.2: a cancelled visit on a stay-issue case; the admin decides in the browser.
  const arrivalGuest = await guest('arrival');
  // Filed through the real 4.1 service while the visit stood, then the visit is cancelled.
  const arrivalVisit = await visit(arrivalGuest, 'confirmed');
  const { createSupportRequest } = await import('@/services/support/service.js');
  const stayCase = await createSupportRequest(
    sql,
    { kind: 'customer', session: sessions.arrival },
    {
      category: 'stay_issue',
      body: 'The gate stayed locked and nobody answered the phone, so we had to leave.',
      orderId: arrivalVisit.order,
      privacyRequestId: null,
      requestKey: randomUUID(),
      stayIssue: {
        issueType: 'access',
        discoveredAt: new Date(Date.now() - 26 * 3600000).toISOString(),
        affected: [{ visitId: arrivalVisit.id, roomTypeId: null }],
        remedy: 'full_refund_or_move',
      },
    },
  );
  await sql`UPDATE booking SET state='cancelled',cancelled_at=now() WHERE id=${arrivalVisit.id}`;
  // 5.4: a published review (written by service) that a customer and the owner report in the browser.
  const authorId = await guest('author');
  const authored = await complete(await visit(authorId, 'confirmed', '2 days'));
  const published = await submitReview(sql, sessions.author, {
    visitId: authored.id,
    rating: 2,
    body: 'The pool was cloudy and the caretaker arrived two hours late for the handover.',
  });
  // A second review so the hide/not-violation outcomes are told apart on one listing.
  const second = await guest('second');
  const secondVisit = await complete(await visit(second, 'confirmed', '3 days'));
  const secondReview = await submitReview(sql, sessions.second, {
    visitId: secondVisit.id,
    rating: 5,
    body: 'Spotless rooms, a warm caretaker and a great lawn for the children to play on.',
  });
  await guest('reporter');

  const ownerSession = await issuePortalSession(sql, 'client', f.owner, 3600);
  tokens.owner = await encryptSession({ userId: f.owner, role: 'client', sessionId: ownerSession });
  const adminSession = await issuePortalSession(sql, 'admin', f.admin, 3600);
  tokens.admin = await new SignJWT({ adminId: f.admin, sessionId: adminSession })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));

  const [{ udt_name: geometryType }] =
    await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
  if (geometryType !== 'geometry') {
    await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
    await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  }
  const [listing] = await sql`SELECT public_code,slug FROM rentable WHERE id=${f.listing}`;
  await writeFile(
    resolve(scratch, 'fixture.json'),
    JSON.stringify({
      databaseUrl: fixture.url,
      listingPath: `/listing/${listing.slug}-${listing.public_code}`,
      ids: {
        ...f,
        visits,
        invitation,
        arrival: { visit: arrivalVisit, caseId: stayCase.id },
        published: published.id,
        secondReview: secondReview.id,
        publishedState: published.state,
      },
      service: { smsBodies: sms },
      tokens,
    }),
  );
  const { createApp } = await import('@/app.js');
  server = createApp().listen(4115, '127.0.0.1', () =>
    console.log('Epic 5 disposable API ready at 127.0.0.1:4115'),
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
