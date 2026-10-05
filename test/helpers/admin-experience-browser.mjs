// Disposable local fixture only. Temporary JSON contains sessions; keep it outside the repository.
import { writeFile, mkdir } from 'node:fs/promises';
import { SignJWT } from 'jose';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from './listing-review-fixture.js';
const output = process.env.ADMIN_BASELINE_FIXTURE;
assert.ok(output, 'Set ADMIN_BASELINE_FIXTURE to a private temporary JSON path');
const evidence = process.env.ADMIN_BASELINE_EVIDENCE_DIR;
assert.ok(evidence, 'Set ADMIN_BASELINE_EVIDENCE_DIR');
const web = new URL(process.env.GATE_WEB_ORIGIN || 'http://127.0.0.1:3161');
assert.ok(['localhost', '127.0.0.1'].includes(web.hostname), 'Local web origin required');
const port = Number(process.env.ADMIN_BASELINE_API_PORT || 4161);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
const sql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  PORT: String(port),
  NEXT_PUBLIC_SITE_URL: web.origin,
  CORS_ALLOWED_ORIGINS: web.origin,
  SESSION_SECRET: 'admin-phase1-disposable-fixture-secret-only',
  DEV_OTP_BYPASS: 'false',
  OWNER_NOTIFICATION_DELIVERY: 'disabled',
  LOG_FORMAT: 'off',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
});
globalThis.__rentraSql = sql;
const f = await seedReviewFixture(sql);
await sql`UPDATE rentable SET photos='[]'::jsonb WHERE id=${f.listing}`;
const booking = await seedConfirmedBooking(sql, f.listing);
const [{ udt_name: geometryType }] =
  await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
if (geometryType !== 'geometry') {
  await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
}
const { hashPassword, generateTotpSecret } =
  await import('../../src/services/auth/admin-crypto.js');
const password = 'FixtureAdminOnly123!';
await sql`UPDATE admin_user SET password_hash=${hashPassword(password)} WHERE id=${f.admin}`;
const { ADMIN_CAPABILITIES, routeCapability } =
  await import('../../src/services/auth/capabilities.js');
const [reader] =
  await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES ('reader@fixture.invalid','fixture-only','Read-only operator',${JSON.stringify(ADMIN_CAPABILITIES.filter((x) => x.endsWith('.read')))}::text::jsonb) RETURNING id`;
const [customerReader] =
  await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES ('customer-reader@fixture.invalid','fixture-only','Customer reader','["admin.customers.read"]'::jsonb) RETURNING id`;
const secret = generateTotpSecret();
const [totp] =
  await sql`INSERT INTO admin_user(email,password_hash,name,totp_secret) VALUES ('totp@fixture.invalid',${hashPassword(password)},'2FA operator',${secret}) RETURNING id`;
const [application] =
  await sql`INSERT INTO client_application(user_id,status,legal_name,submitted_at,consent_at) VALUES (${f.other},'submitted','Other Owner',now()-interval '50 hours',now()) RETURNING id`;
await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${f.other}`;
await sql`INSERT INTO client_application(user_id,status,legal_name) VALUES (${f.owner},'approved','Property Owner')`;
// A complete submission is not fabricated: the current draft remains a valid baseline state.
const { createSupportRequest } = await import('../../src/services/support/service.js');
const support = await createSupportRequest(
  sql,
  { kind: 'owner', id: f.owner },
  {
    category: 'calendar',
    subject: 'Fixture calendar question',
    body: 'Please explain availability for the upcoming visit.',
    orderId: booking.order,
    privacyRequestId: null,
    propertyId: f.listing,
    requestKey: crypto.randomUUID(),
  },
);
// Opt-in Phase 4 dataset; the baseline fixture stays unchanged.
const dashboardRoles = {};
if (process.env.ADMIN_DASHBOARD_FIXTURE === '1') {
  const { seedFinanceFixture } = await import('./finance-fixture.js');
  const finance = await seedFinanceFixture(sql, f);
  const { propertyToday } = await import('../../src/services/domain/booking-dates.js');
  const today = propertyToday();
  await sql`UPDATE booking SET hours_known=true,blocked_start_at=${`${today}T09:00:00+05:30`}::timestamptz,blocked_end_at=${`${today}T18:00:00+05:30`}::timestamptz,local_day=${today}::date,starts_at=${`${today}T09:00:00+05:30`}::timestamptz,ends_at=${`${today}T18:00:00+05:30`}::timestamptz WHERE id=${finance.live.bookingId}`;
  await sql`INSERT INTO service_health(service,healthy,checked_at) VALUES ('payments',true,now()),('notifications',false,now()-interval '3 minutes')`;
  const [approved] = await sql`SELECT id FROM client_application WHERE user_id=${f.owner}`;
  await sql`UPDATE client_application SET reviewed_at=now() WHERE id=${approved.id}`;
  await sql`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES ('admin',${f.admin},'client_application',${approved.id},'application_approved')`;
  for (const [role, permissions] of Object.entries({
    finance: ['admin.payments.read'],
    applications: ['admin.applications.read'],
    empty: [],
  })) {
    const [operator] =
      await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES (${role + '@fixture.invalid'},'fixture-only',${role},${JSON.stringify(permissions)}::text::jsonb) RETURNING id`;
    dashboardRoles[role] = operator.id;
  }
}
const reviewFixture = {};
if (process.env.ADMIN_REVIEW_FIXTURE === '1') {
  await sql`UPDATE rentable SET photos=${JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ url: '/images/guest-login.jpg', alt: 'Fixture property ' + i })))}::text::jsonb WHERE id=${f.listing}`;
  const { submitProperty, decidePropertyReview } =
    await import('../../src/services/admin/listings.js');
  const first = await submitProperty(sql, { id: f.listing, clientId: f.owner });
  await decidePropertyReview(sql, {
    id: f.listing,
    adminId: f.admin,
    input: {
      submissionId: first.submissionId,
      outcome: 'changes_requested',
      reason: 'Clarify the property description.',
      flagged: ['basics'],
    },
  });
  await sql`UPDATE rentable SET description='An updated submitted property description with verified access details.' WHERE id=${f.listing}`;
  const second = await submitProperty(sql, { id: f.listing, clientId: f.owner });
  reviewFixture.property = f.listing;
  reviewFixture.historical = first.submissionId;
  reviewFixture.current = second.submissionId;
  const [doc] =
    await sql`INSERT INTO document(owner_type,owner_id,doc_type,side,storage_key,status,mime_type,bytes) VALUES ('client_application',${application.id},'pan_card','front','fixture/private-identity','uploaded','image/jpeg',1000) RETURNING id`;
  reviewFixture.document = doc.id;
  const [old] =
    await sql`INSERT INTO document(owner_type,owner_id,doc_type,side,storage_key,status,mime_type,bytes) VALUES ('client_application',${application.id},'passport','front','fixture/replaced-identity','superseded','image/jpeg',1000) RETURNING id`;
  reviewFixture.replacedDocument = old.id;
  reviewFixture.decisions = {};
  for (const choice of ['approve', 'more_info', 'reject']) {
    const [user] =
      await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${choice + '@fixture.invalid'},'client','pending_application',${'Fixture ' + choice}) RETURNING id`;
    const [app] =
      await sql`INSERT INTO client_application(user_id,status,legal_name,submitted_at,consent_at) VALUES (${user.id},'submitted',${'Fixture ' + choice},now()-interval '50 hours',now()) RETURNING id`;
    reviewFixture.decisions[choice] = app.id;
  }
  for (const [role, permissions] of Object.entries({
    appWriter: ['admin.applications.read', 'admin.applications.write'],
    documentReader: ['admin.applications.read', 'admin.documents.read'],
  })) {
    const [admin] =
      await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES (${role + '@fixture.invalid'},'fixture-only',${role},${JSON.stringify(permissions)}::text::jsonb) RETURNING id`;
    dashboardRoles[role] = admin.id;
  }
}
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const tokens = {};
for (const [role, id] of Object.entries({
  ...dashboardRoles,
  full: f.admin,
  readonly: reader.id,
  restricted: f.limited,
  customerReader: customerReader.id,
})) {
  tokens[role] = await new SignJWT({
    adminId: id,
    sessionId: await issuePortalSession(sql, 'admin', id, 3600),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
const router = (await import('../../src/routes/admin.route.js')).default;
const routes = router.stack
  .filter((x) => x.route)
  .flatMap((x) =>
    Object.keys(x.route.methods).map((method) => ({
      method: method.toUpperCase(),
      path: x.route.path,
      capability: routeCapability('admin', method.toUpperCase(), x.route.path),
    })),
  );
await mkdir(dirname(output), { recursive: true });
await mkdir(evidence, { recursive: true });
await writeFile(
  output,
  JSON.stringify({
    databaseUrl: fixture.url,
    ids: f,
    booking,
    application: application.id,
    review: reviewFixture,
    support: support.id,
    tokens,
    password,
    totp: { id: totp.id, email: 'totp@fixture.invalid', secret },
  }),
  { mode: 0o600 },
);
await writeFile(join(evidence, 'api-routes.json'), JSON.stringify(routes, null, 2) + '\n');
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(port, '127.0.0.1', () =>
  console.log('Disposable admin Phase 1 API ready on', port),
);
async function stop() {
  await new Promise((r) => server.close(r));
  await fixture.drop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('data', (x) => {
  if (x.toString().trim() === 'stop') void stop();
});
