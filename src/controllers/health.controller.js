import { sql } from '@/config/database.js';
import { config } from '@/config/env.js';
import { ok, fail } from '@/utils/respond.js';
import { asyncHandler } from '@/utils/asyncHandler.js';

/**
 * Two probes, deliberately separate.
 *
 * `live` answers "is this process running" and must never touch the database:
 * an orchestrator that restarts the API because Postgres blipped turns a
 * recoverable outage into an outage plus a cold start.
 *
 * `ready` answers "should traffic be routed here", and for that the database
 * genuinely is a dependency.
 */
export const live = (_req, res) =>
  ok(res, { status: 'up', service: 'rentra-api', env: config().NODE_ENV });

export const ready = asyncHandler(async (_req, res) => {
  try {
    await sql`select 1`;
  } catch {
    return fail(res, {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'Database is not reachable.',
    });
  }
  return ok(res, { status: 'ready' });
});
