import 'server-only';

import { sql } from '@/services/db';
import { revokeCustomerSession } from './customer-identity';
import { cookies } from 'next/headers';
import { getEnv } from '@/services/schemas/joi/env';
import {
  encryptSession,
  decryptSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from './session-crypto';

/** Customer sessions also have a revocable database record. Claims never replace DAL checks. */

/**
 * Call only from a Server Action or Route Handler.
 * `cookies()` is readable during render but writable only in those two places.
 */
export async function createSession({ userId, role, accountStatus, sessionId, development = false }) {
  const token = await encryptSession({ userId, role, accountStatus, ...(sessionId ? { sessionId, development } : {}) });
  const jar = await cookies();

  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Re-issue with fresh claims — e.g. the moment an admin approves the account. */
export async function refreshSession(claims) {
  await createSession(claims);
}

export async function readSession() {
  const jar = await cookies();
  return decryptSession(jar.get(SESSION_COOKIE)?.value);
}

export async function destroySession() {
  await revokeCustomerSession(sql, await readSession());
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
