import test from 'node:test';
import assert from 'node:assert/strict';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { seedVenue } from '../helpers/venue-fixture.js';
import { inspectEntertainmentRelease } from '../../src/services/operations/entertainment-release.js';

test(
  'Phase 14 release inspection checks migrations, switch, fully priced venues and rollback without writes',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)),
    });
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: '0039_governed_exports',
    });
    const { sql } = db;
    try {
      assert.equal((await inspectEntertainmentRelease(sql, migrations)).ready, false);
      await migrateWithDrizzle(db.url, migrations[39].folderMillis);
      const v = await seedVenue(sql, { vertical: 'hidden' });
      for (const slug of [
        'badminton',
        'bowling',
        'turf',
        'gaming-zone',
        'trampoline-park',
        'go-karting',
      ]) {
        await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit) VALUES (${slug},${slug},'entertainment','hour')`;
      }
      const expanded = await inspectEntertainmentRelease(sql, migrations);
      assert.equal(expanded.ready, true, JSON.stringify(expanded));
      assert.equal(expanded.rollback.previousBackendSafe, true);
      assert.equal(
        expanded.rollback.schemaRollbackSafe,
        false,
        'an hourly listing already prevents schema rollback',
      );
      await sql`UPDATE vertical SET status='partners' WHERE code='entertainment'`;
      assert.equal((await inspectEntertainmentRelease(sql, migrations, 'pilot')).ready, true);
      const before = await sql`SELECT code,status,version FROM vertical ORDER BY code`;
      assert.equal(
        (await inspectEntertainmentRelease(sql, migrations, 'public')).ready,
        false,
        'one venue cannot launch',
      );
      for (let n = 2; n <= 6; n++) {
        const [venue] =
          await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,rental_unit,capacity,cancellation_tier,booking_config)
          SELECT client_id,${`release-venue-${n}`},title,category_id,city_id,area_id,${`release${n}`},rental_unit,capacity,cancellation_tier,booking_config FROM rentable WHERE id=${v.venue} RETURNING id`;
        const [resource] =
          await sql`INSERT INTO rentable_resource(rentable_id,name,capacity) VALUES (${venue.id},'Court',12) RETURNING id`;
        await sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) SELECT ${resource.id},${venue.id},category_id FROM rentable WHERE id=${v.venue}`;
        await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor) SELECT ${venue.id},category_id,day_kind,start_minute,end_minute,hourly_rate_minor FROM rentable_rate WHERE rentable_id=${v.venue}`;
        await sql`UPDATE rentable SET status='live' WHERE id=${venue.id}`;
      }
      const launch = await inspectEntertainmentRelease(sql, migrations, 'public');
      assert.equal(launch.ready, true, JSON.stringify(launch));
      assert.equal(launch.bookableSurat, 6);
      assert.deepEqual(
        await sql`SELECT code,status,version FROM vertical ORDER BY code`,
        before,
        'inspection never switches the vertical',
      );
      await sql`DELETE FROM rentable_rate WHERE rentable_id=${v.venue} AND day_kind='weekend'`;
      assert.equal(
        (await inspectEntertainmentRelease(sql, migrations, 'public')).bookableSurat,
        5,
        'a price gap excludes an otherwise live venue',
      );
      await sql`UPDATE drizzle.__drizzle_migrations SET hash='tampered' WHERE created_at=${migrations[55].folderMillis}`;
      assert.equal(
        (await inspectEntertainmentRelease(sql, migrations, 'pilot')).ready,
        false,
        'migration checksum drift blocks release',
      );
      await assert.rejects(inspectEntertainmentRelease(sql, migrations, 'unknown'), /Choose/);
    } finally {
      await db.drop();
    }
  },
);
