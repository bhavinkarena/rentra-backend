import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * One client, reused across hot reloads in dev.
 *
 * `prepare: false` is MANDATORY against Neon's `-pooler` endpoint: it is
 * PgBouncer in transaction-pooling mode, which cannot hold server-side
 * prepared statements. Without this you get sporadic
 * "prepared statement already exists" errors under load.
 */
const globalForDb = globalThis;

const client =
  globalForDb.__rentraSql
  ?? postgres(process.env.DATABASE_URL, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 15,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__rentraSql = client;
}

export const db = drizzle(client, { schema });
export { schema, client as sql };
