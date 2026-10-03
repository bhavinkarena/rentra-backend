import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from './listing-review-fixture.js';
import { seedReviewModeration } from './review-moderation-fixture.js';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
  sql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  PORT: '4149',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3149',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3149',
  SESSION_SECRET: 'owner-phase9-browser-fixture-only-secret',
  DEV_OTP_BYPASS: 'true',
  OWNER_NOTIFICATION_DELIVERY: 'disabled',
  LOG_FORMAT: 'off',
});
globalThis.__rentraSql = sql;
const { memoryEvidenceStore } = await import('../../src/services/uploads/evidence-store.js');
globalThis.__rentraEvidenceStore = memoryEvidenceStore();
const f = await seedReviewFixture(sql),
  booking = await seedConfirmedBooking(sql, f.listing),
  review = await seedReviewModeration(sql, f, booking);
const { moderateReview } = await import('../../src/services/reviews/service.js');
const mod = {
  id: review.reviewId,
  version: (await sql`SELECT version FROM review WHERE id=${review.reviewId}`)[0].version,
  state: 'published',
  reason: 'Meets the publication rules regardless of score.',
  category: 'meets_policy',
  preview: true,
};
const preview = await moderateReview(sql, f.admin, mod);
await moderateReview(sql, f.admin, { ...mod, preview: false, previewToken: preview.preview.token });
await sql`UPDATE "user" SET phone='9876543210',phone_verified_at=now(),email_verified_at=now() WHERE id=${f.owner}`;
await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${f.other}`;
await sql`INSERT INTO client_application(user_id,legal_name,status) VALUES(${f.owner},'Property Owner','approved')`;
await sql`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${booking.order},'confirmed','{}'::jsonb)`;
const { createSupportRequest, replySupportRequest } =
  await import('../../src/services/support/service.js');
const support = await createSupportRequest(
  sql,
  { kind: 'owner', id: f.owner },
  {
    category: 'calendar',
    subject: 'Help opening calendar dates',
    body: 'Please help me understand how to open dates next week.',
    orderId: null,
    privacyRequestId: null,
    propertyId: f.listing,
    requestKey: randomUUID(),
  },
);
await replySupportRequest(
  sql,
  { kind: 'admin', id: f.admin },
  {
    id: support.id,
    version: 0,
    body: 'Open the calendar and select the dates you want to make available.',
    state: 'waiting_customer',
    requestKey: randomUUID(),
  },
);
const { createDispute, manageDispute } = await import('../../src/services/disputes/service.js');
const dispute = await createDispute(
  sql,
  { kind: 'owner', id: f.owner },
  {
    orderId: booking.order,
    visitId: review.visitId,
    kind: 'service',
    subject: 'Garden condition question',
    body: 'Please review the condition of the garden at this visit.',
    claimedMinor: 0,
    requestKey: randomUUID(),
  },
);
await manageDispute(
  sql,
  { kind: 'admin', id: f.admin },
  {
    id: dispute.id,
    version: 1,
    command: 'request_response',
    party: 'owner',
    due: new Date(Date.now() + 86400000).toISOString(),
    body: 'Please describe what was available at the visit.',
    claimSummary: 'The guest says the garden was poorly maintained.',
    requestKey: randomUUID(),
  },
);
const [{ udt_name: type }] =
  await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
if (type !== 'geometry') {
  await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
}
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const { encryptSession } = await import('../../src/services/auth/session-crypto.js');
const tokens = {};
for (const who of ['owner', 'other'])
  tokens[who] = await encryptSession({
    role: 'client',
    userId: f[who],
    sessionId: await issuePortalSession(sql, 'client', f[who], 3600),
  });
await writeFile(
  process.env.OWNER_COMMUNICATIONS_FIXTURE,
  JSON.stringify({ databaseUrl: fixture.url, ids: f, booking, review, support, dispute, tokens }),
  { mode: 0o600 },
);
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(4149, '127.0.0.1', () =>
  console.log('Disposable owner communications API ready on 4149'),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await fixture.drop();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'stop') void stop();
});
