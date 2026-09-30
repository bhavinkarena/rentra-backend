// CP21 gate: run after serve-property-review.mjs (published). Disposable fixture only; never .env DATABASE_URL.
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { SignJWT } from 'jose';
const path = process.env.CP06_GATE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
// Same signing secret and environment as serve-property-review, so the API accepts these cookies.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: fixture.databaseUrl,
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
  SESSION_SECRET: 'cp06-local-fixture-signing-secret-not-for-deployment',
  CLOUDINARY_CLOUD_NAME: 'cp06-fixture',
  CLOUDINARY_API_KEY: 'cp06-fixture',
  CLOUDINARY_API_SECRET: 'cp06-fixture',
});
const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
const { encryptSession } = await import('@/services/auth/session-crypto.js');
const { recordOnboardingDestination } = await import('@/services/payouts/destinations.js');
const sql = postgres(fixture.databaseUrl, { onnotice: () => {} });
try {
  const owner = fixture.ids.owner;
  const v1 = await recordOnboardingDestination(sql, owner, {
    method: 'upi',
    upiId: 'property.owner@okaxis',
    holderName: 'Property Owner',
  });
  const [visit] = await sql`SELECT id FROM booking WHERE order_id=${fixture.booking.order} LIMIT 1`;
  await sql`INSERT INTO payout(booking_id,client_id,gross_minor,commission_minor,net_minor,status,destination_id) VALUES (${visit.id},${owner},100000,8000,92000,'pending',${v1.id})`;
  // Sessions issued an hour ago: valid, but not a recent sign-in.
  const ownerSession = await issuePortalSession(sql, 'client', owner, 3600);
  const adminSession = await issuePortalSession(sql, 'admin', fixture.ids.admin, 3600);
  await sql`UPDATE auth_session SET created_at=now()-interval '1 hour' WHERE id IN ${sql([ownerSession, adminSession])}`;
  const ownerStale = await encryptSession({
    userId: owner,
    role: 'client',
    sessionId: ownerSession,
  });
  const adminStale = await new SignJWT({ adminId: fixture.ids.admin, sessionId: adminSession })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  await writeFile(
    path,
    JSON.stringify({
      ...fixture,
      tokens: { ...fixture.tokens, ownerStale, adminStale },
      destinations: { v1: v1.id },
    }),
  );
  console.log('CP21 disposable fixture ready');
} finally {
  await sql.end();
}
