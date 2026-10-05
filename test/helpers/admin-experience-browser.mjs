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
    body:
      process.env.ADMIN_SEARCH_FIXTURE === '1'
        ? 'WITHHELD-PRIVATE support message'
        : 'Please explain availability for the upcoming visit.',
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
// Opt-in communication workspace fixtures; no delivery worker or external storage.
const comms = {};
if (process.env.ADMIN_COMMS_FIXTURE === '1') {
  const { seedReviewModeration } = await import('./review-moderation-fixture.js');
  const review = await seedReviewModeration(sql, f, booking);
  comms.reviewId = review.reviewId;
  const [report] =
    await sql`INSERT INTO review_report(review_id,reporter_id,reason) VALUES(${review.reviewId},${f.owner},'Please investigate this feedback consistently with publication policy.') RETURNING id`;
  comms.reportId = report.id;
  comms.messages = {};
  for (const state of ['pending', 'accepted', 'delivered', 'failed', 'unknown', 'suppressed']) {
    const [message] =
      await sql`INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at,state,provider_id,recipient) VALUES(${booking.order},${booking.customer},${'phase9-' + state},'confirmation',now(),${state},${['accepted', 'delivered'].includes(state) ? 'SM' + 'a'.repeat(32) : null},'+919000000077') RETURNING id`;
    comms.messages[state] = message.id;
  }
  const [operator] =
    await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES('comms-reader@fixture.invalid','fixture-only','Communication reader','["admin.reviews.read","admin.support.read","admin.notifications.read"]'::jsonb) RETURNING id`;
  dashboardRoles.commsReader = operator.id;
}
// Phase 10 read-only role deliberately lacks linked-record grants.
const ops = {};
if (process.env.ADMIN_OPS_FIXTURE === '1') {
  const [operator] =
    await sql`INSERT INTO admin_user(email,password_hash,name,permissions) VALUES('ops-reader@fixture.invalid','fixture-only','Operations reader',${JSON.stringify(['operations', 'privacy', 'audit', 'security', 'content', 'catalogues', 'payments'].map((domain) => 'admin.' + domain + '.read'))}::text::jsonb) RETURNING id`;
  dashboardRoles.opsReader = operator.id;
}
const search = {};
if (process.env.ADMIN_SEARCH_FIXTURE === '1') {
  for (const [role, permissions] of Object.entries({
    searchOwner: ['admin.clients.read'],
    searchCustomer: ['admin.customers.read'],
    searchApplication: ['admin.applications.read'],
    searchProperty: ['admin.properties.read'],
    searchRecords: ['admin.records.read'],
    searchSupport: ['admin.support.read'],
    searchEmpty: [],
  })) {
    const [operator] = await sql`INSERT INTO admin_user(email,password_hash,name,permissions)
      VALUES(${role + '@fixture.invalid'},'fixture-only',${role},${JSON.stringify(permissions)}::text::jsonb) RETURNING id`;
    dashboardRoles[role] = operator.id;
  }
  await sql`INSERT INTO "user"(email,role,account_status,name)
    SELECT 'search-owner-'||n||'@fixture.invalid','client','active','Search fixture owner '||n FROM generate_series(1,23) n`;
  await sql`INSERT INTO client_application(user_id,status,legal_name)
    SELECT id,'approved',name FROM "user" WHERE email LIKE 'search-owner-%@fixture.invalid'`;
  await sql`INSERT INTO "user"(email,phone,role,account_status,name,profile_completed_at)
    SELECT 'search-customer-'||n||'@fixture.invalid',('9100000'||lpad(n::text,3,'0')),'customer','active','Search fixture customer '||n,now() FROM generate_series(1,23) n`;
  await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,capacity,farm_size,exact_address,check_in_from,check_out_by,photos)
    SELECT r.client_id,'search-property-'||n,'Search fixture property '||n,r.description,r.category_id,r.city_id,r.area_id,'srch'||lpad(n::text,3,'0'),r.capacity,r.farm_size,r.exact_address,r.check_in_from,r.check_out_by,'[]'::jsonb
    FROM rentable r CROSS JOIN generate_series(1,23) n WHERE r.id=${f.listing}`;
  const { seedBusyOwnerVisits } = await import('./listing-review-fixture.js');
  await seedBusyOwnerVisits(sql, booking.order, 1, 23, 'Search fixture booked property');
  await sql`INSERT INTO booking_case(reference,order_id,type,requester_kind,source,reason,created_by_kind,created_by_id,request_key,request_hash)
    SELECT 'CASE-'||right(reference,2)||'-'||left(id::text,8),id,'operational','admin','internal','WITHHELD-PRIVATE case body','admin',${f.admin},gen_random_uuid(),repeat('a',64) FROM booking_order WHERE reference LIKE 'TODAY-ORDER-%'`;
  const [order] =
    await sql`SELECT id,reference FROM booking_order WHERE reference='TODAY-ORDER-23'`;
  const [visit] = await sql`SELECT reference FROM booking WHERE order_id=${order.id}`;
  const [c] = await sql`SELECT id,reference FROM booking_case WHERE order_id=${order.id}`;
  const [property] = await sql`SELECT id,public_code FROM rentable WHERE public_code='srch001'`;
  search.order = order;
  search.visit = visit.reference;
  search.case = c;
  search.property = property;
  // Body text deliberately never belongs to any list's search predicate.
}
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const tokens = {};
const roleSessions = {};
for (const [role, id] of Object.entries({
  ...dashboardRoles,
  full: f.admin,
  readonly: reader.id,
  restricted: f.limited,
  customerReader: customerReader.id,
})) {
  roleSessions[role] = await issuePortalSession(sql, 'admin', id, 3600);
  tokens[role] = await new SignJWT({
    adminId: id,
    sessionId: roleSessions[role],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}
if (process.env.ADMIN_OPS_FIXTURE === '1') {
  const actor = { kind: 'admin', id: f.admin, sessionId: roleSessions.full };
  const { seedFinanceFixture } = await import('./finance-fixture.js');
  await seedFinanceFixture(sql, f);
  const audit = await import('../../src/services/admin/audit-browser.js');
  const [event] =
    await sql`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,before,after,reason) VALUES('admin',${f.admin},'rentable',${f.listing},'phase10_fixture','{"state":"draft"}','{"state":"active","email":"WITHHELD-PRIVATE"}','PRIVATE reason must be redacted') RETURNING id`;
  ops.event = event.id;
  ops.filters = audit.defaultFilters();
  const job = await audit.createExport(sql, actor, {
    dataset: 'audit_events',
    filters: { ...ops.filters, action: 'phase10_fixture' },
    limit: 100,
    requestKey: crypto.randomUUID(),
    reason: 'Review this synthetic scoped audit export.',
    confirmed: true,
  });
  await audit.processExport(sql, job.id, { env: process.env });
  ops.export = job.id;
  const expired = await audit.createExport(sql, actor, {
    dataset: 'audit_events',
    filters: { ...ops.filters, action: 'phase10_fixture' },
    limit: 100,
    requestKey: crypto.randomUUID(),
    reason: 'Verify expired synthetic audit export.',
    confirmed: true,
  });
  await audit.processExport(sql, expired.id, { env: process.env });
  await sql`UPDATE admin_export_job SET expires_at=now()-interval '1 hour' WHERE id=${expired.id}`;
  ops.expiredExport = expired.id;
  const [session] =
    await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`;
  const { requestCustomerPrivacy } = await import('../../src/services/customer/account.js');
  const privacy = await import('../../src/services/customer/privacy-fulfillment.js');
  const customer = { role: 'customer', userId: booking.customer, sessionId: session.id };
  const access = await requestCustomerPrivacy(sql, customer, 'access', process.env);
  const command = async (name, extra = {}) => {
    const [row] = await sql`SELECT version FROM customer_privacy_request WHERE id=${access.id}`;
    return privacy.privacyCommand(
      sql,
      actor,
      access.id,
      {
        command: name,
        version: row.version,
        reason: 'Verified this synthetic privacy scope.',
        confirmed: true,
        ...extra,
      },
      process.env,
    );
  };
  await command('review', {
    authority: 'self',
    identityReference: 'fixture-reviewed-identity',
    deliveryReference: 'fixture-reviewed-delivery',
    retentionAccepted: true,
  });
  const preview = await command('preview');
  await command('queue', { previewToken: preview.previewToken });
  await privacy.processPrivacyJob(sql, access.id, { env: process.env });
  ops.privacy = access.id;
  ops.privacyOpen = (await requestCustomerPrivacy(sql, customer, 'deletion', process.env)).id;
  const [category] = await sql`SELECT category_id FROM rentable WHERE id=${f.listing}`;
  ops.category = category.category_id;
  await sql`INSERT INTO service_health(service,healthy,checked_at) VALUES('payments',true,now()),('notifications',false,now()) ON CONFLICT(service) DO UPDATE SET healthy=excluded.healthy,checked_at=excluded.checked_at`;
  await sql`INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at,state) VALUES(${booking.order},${booking.customer},'phase10-failed','confirmation',now()-interval '2 hours','blocked')`;
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
    comms,
    ops,
    search,
    support: support.id,
    tokens,
    password,
    totp: { id: totp.id, email: 'totp@fixture.invalid', secret },
  }),
  { mode: 0o600 },
);
await writeFile(join(evidence, 'api-routes.json'), JSON.stringify(routes, null, 2) + '\n');
const { createApp } = await import('../../src/app.js');
const app = createApp();
// Failure injection exists only in this localhost, disposable search fixture.
let searchFailure = false;
const { createServer } = await import('node:http');
const server = createServer((req, res) => {
  if (process.env.ADMIN_SEARCH_FIXTURE === '1') {
    if (
      req.method === 'POST' &&
      ['/fixture/search-failure/on', '/fixture/search-failure/off'].includes(req.url)
    ) {
      searchFailure = req.url.endsWith('/on');
      res.writeHead(204);
      return res.end();
    }
    if (searchFailure && req.url.startsWith('/api/v1/admin/properties?')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          success: false,
          code: 'FIXTURE_UNAVAILABLE',
          message: 'Disposable directory unavailable',
        }),
      );
    }
  }
  app(req, res);
}).listen(port, '127.0.0.1', () => console.log('Disposable admin Phase 1 API ready on', port));

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
