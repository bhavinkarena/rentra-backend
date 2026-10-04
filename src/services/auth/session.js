import 'server-only';

import { sql } from '@/services/db';
import { revokeCustomerSession } from './customer-identity';
import { issuePortalSession, revokePortalSession } from './portal-sessions.js';
import { forbidden } from '@/utils/apiError.js';
import { deviceLabel } from './owner-security.js';
import { headers, cookies } from 'next/headers';
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
export async function createSession({
  userId,
  role,
  accountStatus,
  sessionId,
  development = false,
  verifiedEmail,
  verifiedPhone,
}) {
  if (role === 'client') {
    sessionId = await issuePortalSession(sql, 'client', userId, SESSION_TTL_SECONDS, {
      email: verifiedEmail,
      phone: verifiedPhone,
      deviceLabel: deviceLabel((await headers()).get('user-agent') || ''),
    });
    if (!sessionId)
      throw forbidden(
        'ACCOUNT_RESTRICTED',
        'This account is restricted. Contact Rentra for help with existing bookings.',
      );
  }
  const token = await encryptSession({
    userId,
    role,
    accountStatus,
    ...(sessionId ? { sessionId, development } : {}),
  });
  await activateSession(token);
}

export const roleSessionCookie = (role) => `rentra_${role}_session`;

/** Activate an already issued token without extending its authenticated lifetime. */
export async function activateSession(token) {
  const claims = await decryptSession(token);
  if (!claims) throw forbidden('SESSION_INVALID', 'Sign in again to continue.');
  const jar = await cookies();
  const options = {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, claims.exp - Math.floor(Date.now() / 1000)),
  };
  const previous = jar.get(SESSION_COOKIE)?.value;
  const previousClaims = await decryptSession(previous);
  if (previousClaims)
    jar.set(roleSessionCookie(previousClaims.role), previous, {
      ...options,
      maxAge: Math.max(0, previousClaims.exp - Math.floor(Date.now() / 1000)),
    });
  jar.set(roleSessionCookie(claims.role), token, options);
  jar.set(SESSION_COOKIE, token, options);
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
  const jar = await cookies();
  const tokens = [
    jar.get(SESSION_COOKIE)?.value,
    ...['client', 'customer'].map((role) => jar.get(roleSessionCookie(role))?.value),
  ];
  for (const token of new Set(tokens.filter(Boolean))) {
    const session = await decryptSession(token);
    await revokeCustomerSession(sql, session);
    await revokePortalSession(sql, session, 'client');
  }
  jar.delete(SESSION_COOKIE);
  for (const role of ['client', 'customer']) jar.delete(roleSessionCookie(role));
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
