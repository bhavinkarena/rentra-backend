import 'server-only';
import { z } from 'zod';

/** CP21: changes to where money goes need a sign-in within this window. */
export const RECENT_AUTH_MINUTES = 15;

/** When this live session was issued, and whether that is recent enough. */
export async function recentAuthentication(database, { kind, principalId, sessionId }, minutes = RECENT_AUTH_MINUTES) {
  if (!z.string().uuid().safeParse(sessionId).success || !z.string().uuid().safeParse(principalId).success) {
    return { fresh: false, authenticatedAt: null, freshUntil: null };
  }
  const owner = kind === 'admin' ? database`admin_id=${principalId}` : database`user_id=${principalId}`;
  const [row] = await database`SELECT created_at,created_at+make_interval(mins=>${minutes}) fresh_until,
      created_at+make_interval(mins=>${minutes})>clock_timestamp() fresh
    FROM auth_session WHERE id=${sessionId} AND ${owner} AND revoked_at IS NULL AND expires_at>clock_timestamp()`;
  return {
    fresh: Boolean(row?.fresh),
    authenticatedAt: row ? new Date(row.created_at).toISOString() : null,
    freshUntil: row ? new Date(row.fresh_until).toISOString() : null,
  };
}
