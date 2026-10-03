// Phase 5 browser gate: a disposable API on 4143 with Cloudinary stubbed in-process.
import { writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { createDisposableDatabase } from './disposable-db.js';
import { seedReviewFixture } from './listing-review-fixture.js';
const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
  sql = fixture.sql;
Object.assign(process.env, {
  DATABASE_URL: fixture.url,
  NODE_ENV: 'test',
  PORT: '4143',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3143',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3143',
  SESSION_SECRET: 'owner-phase5-fixture-secret-only-1234',
  DEV_OTP_BYPASS: 'true',
  CLOUDINARY_CLOUD_NAME: 'fixture',
  CLOUDINARY_API_KEY: 'fixture',
  CLOUDINARY_API_SECRET: 'fixture',
  LOG_FORMAT: 'off',
});
globalThis.__rentraSql = sql;
const f = await seedReviewFixture(sql);
if (process.env.OWNER_FIXTURE_HUB === '1') {
  // Phase 6 gate: the seed property is live, and a copy of it was sent back by Rentra.
  await sql`UPDATE rentable SET status='live',published_at=now(),bedrooms=3,highlight=NULL WHERE id=${f.listing}`;
  const [copy] =
    await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,
      capacity,bedrooms,farm_size,exact_address,check_in_from,check_out_by,photos,location,booking_config,house_rules,status,
      cancellation_tier,deposit_minor)
    SELECT client_id,'sent-back-farm','Sent Back Farm',description,category_id,city_id,area_id,'sentbk01',capacity,3,farm_size,
      exact_address,check_in_from,check_out_by,photos,location,booking_config,house_rules,'draft',cancellation_tier,deposit_minor
    FROM rentable WHERE id=${f.listing} RETURNING id,content_version`;
  await sql`INSERT INTO rentable_price(rentable_id,slot,weekday_minor,weekend_minor)
    SELECT ${copy.id},slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${f.listing}`;
  await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) SELECT ${copy.id},amenity_id FROM rentable_amenity WHERE rentable_id=${f.listing}`;
  await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status) VALUES ('rentable',${copy.id},'extract_7_12','fixture/copy','uploaded')`;
  const [current] = await sql`SELECT content_version FROM rentable WHERE id=${copy.id}`;
  const [submission] =
    await sql`INSERT INTO listing_submission(rentable_id,content_version,pass_number,snapshot,submitted_by)
    VALUES (${copy.id},${current.content_version},1,'{}',${f.owner}) RETURNING id`;
  await sql`UPDATE rentable SET review_pass=1 WHERE id=${copy.id}`;
  await sql`INSERT INTO listing_review(rentable_id,pass_number,submission_id,outcome,reason,flagged_fields,reviewed_by)
    VALUES (${copy.id},1,${submission.id},'changes_requested','Add a clear photo of the pool.','["photos","basics"]',${f.admin})`;
  f.sentBack = copy.id;
}
const { issuePortalSession } = await import('../../src/services/auth/portal-sessions.js');
const { encryptSession } = await import('../../src/services/auth/session-crypto.js');
const owner = await encryptSession({
  role: 'client',
  userId: f.owner,
  sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
});
await writeFile(
  process.env.OWNER_WIZARD_FIXTURE,
  JSON.stringify({ databaseUrl: fixture.url, ids: f, tokens: { owner } }),
);
const { v2: cloudinary } = await import('cloudinary');
cloudinary.uploader.upload_stream = (options, callback) =>
  new Writable({
    write(_chunk, _encoding, next) {
      next();
    },
    final(next) {
      callback(null, {
        public_id: options.public_id,
        bytes: 1000,
        width: 1600,
        height: 1000,
        format: 'jpg',
      });
      next();
    },
  });
cloudinary.api.resource = async (key) => ({
  public_id: key,
  format: 'jpg',
  bytes: 400000,
  width: 2000,
  height: 1500,
  type: 'upload',
});
cloudinary.uploader.destroy = async () => ({ result: 'ok' });
// Without PostGIS the column is text: write the EWKB the real reader decodes, as the seed does.
const [{ udt_name: geometryType }] =
  await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
if (geometryType !== 'geometry') {
  const { PgGeometryObject } = await import('drizzle-orm/pg-core');
  PgGeometryObject.prototype.mapToDriverValue = ({ x, y }) => {
    const point = Buffer.alloc(25);
    point.writeUInt8(1, 0);
    point.writeUInt32LE(0x20000001, 1);
    point.writeUInt32LE(4326, 5);
    point.writeDoubleLE(Number(x), 9);
    point.writeDoubleLE(Number(y), 17);
    return point.toString('hex');
  };
}
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(4143, '127.0.0.1', () =>
  console.log('Disposable owner wizard API ready on 4143'),
);
process.on('SIGINT', async () => {
  server.close();
  await fixture.drop();
  process.exit();
});
