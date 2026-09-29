// Fixture-only migrator for a disposable local DB without PostGIS.
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const url = process.env.DATABASE_URL;
if (!/127\.0\.0\.1:55432\/rentra_cp02$/.test(url))
  throw new Error('refusing non-disposable database');
// Run from rentra-backend so drizzle/ resolves there.
const root = new URL('drizzle/', pathToFileURL(`${process.cwd()}/`));
const journal = JSON.parse(await readFile(new URL('meta/_journal.json', root), 'utf8'));
const sql = postgres(url, { max: 1, onnotice: () => {} });
await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
for (const { tag } of journal.entries) {
  const text = (await readFile(new URL(`${tag}.sql`, root), 'utf8'))
    .replaceAll('geometry(point)', 'text')
    .replace(/CREATE INDEX "(area_centre_idx|rentable_location_idx)"[^;]*;/g, '');
  await sql.begin(async (tx) => {
    for (const s of text.split('--> statement-breakpoint')) if (s.trim()) await tx.unsafe(s);
  });
  console.log('applied', tag);
}
await sql.unsafe(`
CREATE FUNCTION fixture_null_geo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_TABLE_NAME='area' THEN NEW.centre := NULL; ELSE NEW.location := NULL; END IF; RETURN NEW; END $$;
CREATE TRIGGER fixture_area_geo BEFORE INSERT OR UPDATE ON area FOR EACH ROW EXECUTE FUNCTION fixture_null_geo();
CREATE TRIGGER fixture_rentable_geo BEFORE INSERT OR UPDATE ON rentable FOR EACH ROW EXECUTE FUNCTION fixture_null_geo();`);
await sql.end();
