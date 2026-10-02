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
