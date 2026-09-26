// Disposable CP06–CP08 browser/API fixture. No configured database or provider is used.
// FIXTURE_STAGE=published publishes the property and books one confirmed visit (CP08 gate).
import { writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedConfirmedBooking, seedReviewFixture } from './listing-review-fixture.js';
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
let booking = null;
if (process.env.FIXTURE_STAGE === 'published') {
  const { decidePropertyReview } = await import('@/services/admin/listings.js');
  const v = await import('@/services/admin/verification.js');
  const input = { submissionId: submission.submissionId };
  await decidePropertyReview(fixture.sql, {
    id: ids.listing,
    adminId: ids.admin,
    input: { ...input, outcome: 'approved_for_visit', reason: 'Ready for verification' },
  });
  const at = new Date(Date.now() + 2 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  const { visitId } = await v.scheduleVerification(fixture.sql, {
    adminId: ids.admin,
    id: ids.listing,
    input: { ...input, mode: 'video_call', scheduledAt: `${at}T11:00` },
  });
  await v.recordVerificationOutcome(fixture.sql, {
    adminId: ids.admin,
    id: ids.listing,
    visitId,
    input: {
      expectedVersion: 1,
      outcome: 'passed',
      findings: 'Video walk-through matched the submitted photos and rules.',
      checklist: v.CHECKLIST.map(([key]) => key),
    },
  });
  await v.publishProperty(fixture.sql, { adminId: ids.admin, id: ids.listing, input });
  booking = await seedConfirmedBooking(fixture.sql, ids.listing);
  const [session] =
    await fixture.sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${booking.customer},now()+interval '1 day') RETURNING id`;
  tokens.customer = await encryptSession({
    userId: booking.customer,
    role: 'customer',
    sessionId: session.id,
  });
  const [{ udt_name: geometryType }] =
    await fixture.sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
  if (geometryType !== 'geometry') {
    // No PostGIS on local test clusters; the booking record only reads coordinates.
    await fixture.sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
    await fixture.sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  }
}
await writeFile(
  process.env.CP06_GATE_FIXTURE,
  JSON.stringify({ ids, tokens, submission, booking, databaseUrl: fixture.url }),
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
