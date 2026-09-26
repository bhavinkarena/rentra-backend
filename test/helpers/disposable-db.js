import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/**
 * A throwaway database with every drizzle migration applied.
 *
 * Only an explicit localhost server URL is accepted, never the configured
 * application database. Local servers without PostGIS get the two geometry
 * columns as nullable text; nothing under test reads them.
 */
export async function createDisposableDatabase(serverUrl) {
  const url = new URL(serverUrl);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Use a disposable local PostgreSQL server');
  }
  const control = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const name = `rentra_test_${randomUUID().replaceAll('-', '')}`;
  await control.unsafe(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 6, onnotice: () => {} });
  const postgis = await sql`CREATE EXTENSION IF NOT EXISTS postgis`.then(
    () => true,
    () => false,
  );
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  const root = new URL('../../drizzle/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', root), 'utf8'));
  for (const { tag } of journal.entries) {
    let text = await readFile(new URL(`${tag}.sql`, root), 'utf8');
    if (!postgis) {
      text = text
        .replaceAll('geometry(point)', 'text')
        .replace(/CREATE INDEX "(area_centre_idx|rentable_location_idx)"[^;]*;/g, '');
    }
    await sql.begin(async (tx) => {
      for (const statement of text.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    });
  }
  return {
    sql,
    url: url.toString(),
    async drop() {
      await sql.end();
      await control.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await control.end();
    },
  };
}
