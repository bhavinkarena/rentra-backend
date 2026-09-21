import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// max:1 — migrations must run serially on a single connection.
const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
const db = drizzle(client);

console.log('[migrate] enabling extensions');
await client`CREATE EXTENSION IF NOT EXISTS postgis`;
await client`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

console.log('[migrate] applying migrations from ./drizzle');
await migrate(db, { migrationsFolder: './drizzle' });

console.log('[migrate] done');
await client.end();
