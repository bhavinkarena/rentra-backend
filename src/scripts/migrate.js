import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { seedApartmentCategory } from './apartment-category.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// max:1 — migrations must run serially on a single connection.
const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
const db = drizzle(client);

try {
  console.log('[migrate] enabling extensions');
  await client`CREATE EXTENSION IF NOT EXISTS postgis`;
  await client`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  console.log('[migrate] applying migrations');
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
  // Story 3.10 (0088): the new enum value is usable only after the migration transaction commits.
  await seedApartmentCategory(client);
  console.log('[migrate] done');
} finally {
  await client.end();
}
