// Story 3.12: local disposable supply. Credentials never leave ignored tmp/.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDisposableDatabase } from './disposable-db.js';
import { seedHotel, seedCustomer } from './hotel-fixture.js';
import { seedReviewFixture, makePublishable } from './listing-review-fixture.js';
import { fileBackedRazorpay } from './fake-razorpay.mjs';

const control = new URL(process.env.PORTAL_TEST_DATABASE_URL);
assert.equal(control.hostname, '127.0.0.1');
assert.equal(control.port, '55432');
assert.equal(control.pathname, '/postgres');
const scratch = resolve('tmp/story312');
const output = resolve(scratch, 'fixture.json');
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
    SESSION_SECRET: 'story312-local-fixture-secret-only',
    NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3112',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:3112',
    RAZORPAY_KEY_ID: 'rzp_test_STORY312KEY',
    RAZORPAY_KEY_SECRET: 'story312-fake-provider-secret',
    RAZORPAY_WEBHOOK_SECRET: 'story312-fake-webhook-secret',
    LOG_FORMAT: 'off',
  });
  globalThis.__rentraSql = sql;
  globalThis.__rentraPaymentFetcher = fileBackedRazorpay(resolve(scratch, 'provider.json'));
  // Customer actions use the default fetch transport; fail closed inside this fixture process.
  globalThis.fetch = (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.razorpay.com');
    return globalThis.__rentraPaymentFetcher(url, init);
  };
  const farm = await seedReviewFixture(sql);
  const hotel = await seedHotel(sql);
  const photos = [
    { url: '/images/occasions/with-pool.webp', alt: 'Fixture room first view' },
    { url: '/images/occasions/day-picnic.webp', alt: 'Fixture room second view' },
  ];
  await sql`UPDATE room_type SET photos=${JSON.stringify(photos)}::text::jsonb,beds='[{"type":"double","count":1},{"type":"single","count":1}]',amenities='["wifi","air_conditioning","television","desk","wardrobe","balcony","safe","kettle","hair_dryer","private_bathroom"]' WHERE id=${hotel.deluxe}`;
  await sql`UPDATE hotel_profile SET child_policy='{"adultRateFromAge":12,"bands":[{"kind":"infant","fromAge":0,"toAge":1,"rule":{"type":"free","amount":0}},{"kind":"child","fromAge":2,"toAge":11,"rule":{"type":"percent","amount":25}}]}' WHERE rentable_id=${hotel.hotel}`;
  await sql`UPDATE rentable SET pet_policy='{"status":"allowed","maxPets":2,"types":["dog","cat"],"maxSize":"medium","fee":{"unit":"per_night","amount":150}}' WHERE id IN (${hotel.hotel},${farm.listing})`;
  await makePublishable(sql, farm.owner, farm.listing);
  await makePublishable(sql, hotel.owner, hotel.hotel, { openDates: false });
  await sql`UPDATE rentable SET status='live',published_at=now() WHERE id=${farm.listing}`;
  await sql`UPDATE category SET vertical_code='farmhouse' WHERE slug='review-farm'`;
  const [villaCategory] =
    await sql`INSERT INTO category(slug,name,vertical_code) VALUES ('suitable-villa','Villa','farmhouse') RETURNING id`;
  const [villa] =
    await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,capacity,status,booking_config,house_rules,photos)
    SELECT client_id,'suitable-villa','Suitable Villa',description,${villaCategory.id},city_id,area_id,'villa312',capacity,'live',booking_config,house_rules,photos
    FROM rentable WHERE id=${farm.listing} RETURNING id`;
  await sql`INSERT INTO rentable_price(rentable_id,slot,weekday_minor,weekend_minor) SELECT ${villa.id},slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${farm.listing}`;
  await makePublishable(sql, farm.owner, villa.id);
  await sql`UPDATE vertical SET status='public' WHERE code IN ('farmhouse','hotel')`;
  const { seedApartmentCategory } = await import('../../src/scripts/apartment-category.js');
  await seedApartmentCategory(sql);
  const [category] = await sql`SELECT id FROM category WHERE slug='whole-apartment'`;
  const [apartment] =
    await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,status,capacity,house_rules,cancellation_tier,deposit_minor)
    VALUES (${hotel.owner},'suitable-apartment','Suitable Apartment',${category.id},${hotel.city},${hotel.area},'apt31200','unit_night','live',4,'{}','flexible',0) RETURNING id`;
  await sql`INSERT INTO apartment_profile(rentable_id,bedrooms,bathrooms,beds,max_adults,max_children,max_occupants,min_nights,max_nights,arrival_rules,check_in_minute,check_out_minute,turnover_nights,cleaning_fee_minor,weekday_minor,weekend_minor,weekend_nights)
    VALUES (${apartment.id},2,1,'[{"type":"double","count":2}]',2,2,4,1,90,'{"weekdays":{},"ranges":[]}',840,660,1,100000,500000,700000,'{5,6}')`;
  await sql`UPDATE rentable SET pet_policy='{"status":"allowed","maxPets":2,"types":["dog","cat"],"maxSize":"medium","fee":{"unit":"per_night","amount":150}}' WHERE id=${apartment.id}`;
  const { setPaymentGatewayConfiguration } =
    await import('@/services/payments/gateway-settings.js');
  await setPaymentGatewayConfiguration(
    sql,
    {
      actorId: hotel.admin,
      expectedVersion: 0,
      provider: 'razorpay',
      environment: 'test',
      enabled: true,
      collectionPurpose: 'advance',
    },
    process.env,
  );
  const { encryptSession } = await import('@/services/auth/session-crypto.js');
  const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
  const tokens = {};
  const customer = await seedCustomer(sql);
  const otherCustomer = await seedCustomer(sql);
  await sql`UPDATE "user" SET profile_completed_at=now(),profile_version=1,consent_updated_at=now() WHERE id IN (${customer},${otherCustomer})`;
  for (const [name, id, role] of [
    ['owner', hotel.owner, 'client'],
    ['farmOwner', farm.owner, 'client'],
    ['customer', customer, 'customer'],
    ['otherCustomer', otherCustomer, 'customer'],
  ]) {
    const sessionId =
      role === 'client'
        ? await issuePortalSession(sql, role, id, 3600)
        : (
            await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${id},now()+interval '1 day') RETURNING id`
          )[0].id;
    tokens[name] = await encryptSession({ userId: id, role, sessionId });
  }
  const [{ udt_name: geometryType }] =
    await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
  if (geometryType !== 'geometry') {
    await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
    await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
  }
  const [hotelListing] = await sql`SELECT public_code FROM rentable WHERE id=${hotel.hotel}`;
  await writeFile(
    output,
    JSON.stringify({
      databaseUrl: fixture.url,
      ids: {
        farm,
        hotel,
        hotelCode: hotelListing.public_code,
        villa: villa.id,
        apartment: apartment.id,
        customer,
        otherCustomer,
      },
      tokens,
    }),
  );
  const { createApp } = await import('@/app.js');
  server = createApp().listen(4112, '127.0.0.1', () =>
    console.log('Story 3.12 disposable API ready at 127.0.0.1:4112'),
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
