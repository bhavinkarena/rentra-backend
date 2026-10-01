// Phase 8 QA data (disposable local Postgres only): one live farmhouse, one live venue.
import { mkdir, writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
import { seedVenue } from './venue-fixture.js';

const out = process.env.GATE_FIXTURE_DIR || '/tmp/rentra-phase13';
await mkdir(out, { recursive: true });
const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
Object.assign(process.env, {
  DATABASE_URL: db.url,
  NODE_ENV: 'test',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3106,http://127.0.0.1:3106',
  DEV_OTP_BYPASS: 'true',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
  SESSION_SECRET: 'phase13-local-fixture-signing-secret',
  CLOUDINARY_CLOUD_NAME: 'phase13-fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
  RAZORPAY_TEST_KEY_ID: 'rzp_test_PHASE13',
  RAZORPAY_TEST_KEY_SECRET: 'phase13-fixture-payment-secret',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'phase13-fixture-webhook-secret',
});
globalThis.__rentraSql = db.sql;
globalThis.__rentraPaymentFetcher = (await import('./fake-razorpay.mjs')).fileBackedRazorpay(
  out + '/razorpay.json',
);
// Keep all provider traffic inside this disposable fixture, including customer checkout actions.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  new URL(url).hostname === 'api.razorpay.com'
    ? globalThis.__rentraPaymentFetcher(url, init)
    : nativeFetch(url, init);
const { sql } = db;
// No PostGIS locally: arrival reads ST_X/ST_Y; stub them (fixture-only).
await sql.unsafe(
  "CREATE OR REPLACE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'; CREATE OR REPLACE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'",
);
const farm = await seedReviewFixture(sql);
await sql`UPDATE rentable SET status='live', highlight='Private pool', house_rules=${sql.json(['No loud music after 10 PM', 'No pets'])},
  booking_config=${sql.json({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: { enabled: true, startTime: '09:00', endTime: '18:00', endDayOffset: 0, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, capacity: 12, includedGuests: 12, extraGuestChargeMinor: 0 }, night: { enabled: false }, full_day: { enabled: false } } })}
  WHERE id=${farm.listing}`;
await sql`INSERT INTO availability(rentable_id,day,slot,units_available) SELECT ${farm.listing}, (current_date + g)::date, 'day', 1 FROM generate_series(1, 30) g ON CONFLICT DO NOTHING`;
const v = await seedVenue(sql, { status: 'live', vertical: 'public' });
await sql`UPDATE category SET icon_key='cricket' WHERE slug='box-cricket'`;
await sql`UPDATE category SET icon_key='pickleball' WHERE slug='pickleball'`;
const photos = Array.from({ length: 6 }, (_, i) => ({
  url: `https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=800&sig=${i}`,
  alt: `Smash Arena photo ${i + 1}`,
}));
await sql`UPDATE rentable SET description='Two floodlit box-cricket cages and one pickleball court off Vesu Main Road. Nets on all sides, bats and balls on rent, parking for 30 cars.',
  highlight='Floodlit until 1 AM', photos=${JSON.stringify(photos)}::text::jsonb,
  house_rules=${sql.json({ footwear: 'non_marking', minAge: 8, foodAllowed: 'seating_only', smokingAllowed: false, alcoholAllowed: false, notes: 'Arrive 10 minutes early. Bats and balls on rent at the counter.' })}
  WHERE id=${v.venue}`;
await sql`UPDATE rentable_resource SET details=${sql.json({ surface: 'Artificial turf', size: '40 × 80 ft' })}, is_indoor=false WHERE rentable_id=${v.venue} AND name LIKE 'Court%'`;
await sql`UPDATE rentable_resource SET details=${sql.json({ surface: 'Synthetic' })}, is_indoor=true WHERE rentable_id=${v.venue} AND name='Pickleball 1'`;
for (const [slug, label] of [
  ['floodlights', 'Floodlights'],
  ['changing-rooms', 'Changing rooms'],
  ['drinking-water', 'Drinking water'],
  ['first-aid', 'First aid'],
]) {
  const [a] =
    await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES (${slug},'play',${label}) RETURNING id`;
  await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${a.id},'entertainment')`;
  if (slug !== 'first-aid')
    await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${v.venue},${a.id})`;
}
const [parking] = await sql`SELECT id FROM amenity WHERE slug='parking'`;
await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${parking.id},'entertainment')`;
await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${v.venue},${parking.id})`;
await sql`UPDATE rentable SET photos=${sql.json(Array.from({ length: 6 }, (_, i) => ({ url: '/images/partner-login.jpg', alt: 'Fixture venue photo ' + (i + 1) })))}`;
const { setPaymentGatewayConfiguration } =
  await import('../../src/services/payments/gateway-settings.js');
const { encryptSession } = await import('@/services/auth/session-crypto.js');
const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
const { SignJWT } = await import('jose');
await setPaymentGatewayConfiguration(
  sql,
  {
    actorId: v.admin,
    expectedVersion: 0,
    provider: 'razorpay',
    environment: 'test',
    enabled: true,
    collectionPurpose: 'full',
  },
  process.env,
);
const [guest] =
  await sql`INSERT INTO "user"(email,phone,role,account_status,name,profile_completed_at) VALUES ('qa-player@fixture.invalid','9898981234','customer','active','QA Player',now()) RETURNING id`;
const [cs] =
  await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${guest.id},now()+interval '1 day') RETURNING id`;
const tokens = {
  customer: await encryptSession({ userId: guest.id, role: 'customer', sessionId: cs.id }),
  admin: await new SignJWT({
    adminId: v.admin,
    sessionId: await issuePortalSession(sql, 'admin', v.admin, 86400),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:admin')
    .setIssuedAt()
    .setExpirationTime('1d')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET)),
  farmOwner: await encryptSession({
    userId: farm.owner,
    role: 'client',
    accountStatus: 'active',
    sessionId: await issuePortalSession(sql, 'client', farm.owner, 86400),
  }),
  owner: await encryptSession({
    userId: v.owner,
    role: 'client',
    accountStatus: 'active',
    sessionId: await issuePortalSession(sql, 'client', v.owner, 86400),
  }),
};
await writeFile(out + '/tokens.json', JSON.stringify(tokens));
const codes = await sql`SELECT slug, public_code FROM rentable`;
await writeFile(
  out + '/qa-db.json',
  JSON.stringify(
    { url: db.url, codes, farm: farm.listing, venue: v.venue, venueOwner: v.owner },
    null,
    1,
  ),
);
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(4106, '127.0.0.1', () =>
  console.log('Phase 13 disposable API ready on :4106'),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(resolve));
  await db.drop();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.on('data', stop);
