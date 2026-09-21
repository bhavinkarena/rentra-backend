import { db, sql, schema } from '@/services/db/index.js';

/**
 * The database handle.
 *
 * The pool itself is built in the ported service layer, NOT here, so there is
 * exactly one postgres.js pool in the process. Constructing a second one in
 * this file would double the connection count against the pooler and make the
 * `max: 10` ceiling a lie.
 *
 * What this file adds is the boot-time refusal below.
 */

/**
 * Refuse to start on missing or implausible DB configuration, rather than fall
 * back to anything.
 *
 * A silent fallback is far worse than a crash. A backend pointed at the wrong
 * database does not misbehave visibly — it serves confident, well-formed,
 * WRONG data, and every booking, payout and report downstream inherits it.
 * That can run unnoticed for weeks. A boot failure is fixed in five minutes.
 *
 * `postgres()` is lazy: it does not connect until the first query, so without
 * this check a server with no DATABASE_URL would boot happily and only fail on
 * a real user's first request.
 */
const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    'Refusing to start: DATABASE_URL is not set. It has no fallback by design — ' +
      'a server pointed at the wrong database serves wrong data silently.',
  );
}

if (!/^postgres(ql)?:\/\//.test(url)) {
  throw new Error('Refusing to start: DATABASE_URL must be a postgres:// or postgresql:// URL.');
}

/**
 * Verify the connection once, at boot, before the listener opens. The caller
 * decides what to do with a failure — see src/index.js, which retries rather
 * than exiting, because a database that is thirty seconds behind the app in a
 * cold start is normal and should not crash-loop the deployment.
 */
export async function assertDatabaseReady() {
  await sql`select 1`;
}

export { db, sql, schema };
