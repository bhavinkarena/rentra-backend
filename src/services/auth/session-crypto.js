import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '@/services/schemas/joi/env';

/**
 * Session signing and verification. No Next.js dependency on purpose.
 *
 * Split out from session.js so the crypto is testable in plain node and
 * reusable anywhere — the worker, a script, a future route handler — while
 * the cookie handling stays in the Next-specific module next door.
 *
 * The payload carries the MINIMUM needed to authorise a request: user id,
 * role, account status. Never an email, phone, or anything identifying — a
 * signed cookie is tamper-proof, not private, and it travels to the browser
 * on every single request.
 */

export const SESSION_COOKIE = 'rentra_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function key() {
  return new TextEncoder().encode(getEnv().SESSION_SECRET);
}

export async function encryptSession(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setAudience(`rentra:${payload.role}`)
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key());
}

export async function decryptSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
    // Existing customer tokens remain compatible; legacy client tokens must sign in again.
    if (!['client', 'customer'].includes(payload.role)) return null;
    if (payload.aud !== `rentra:${payload.role}` && !(payload.role === 'customer' && payload.aud === undefined)) return null;
    return payload;
  } catch {
    // Expired, tampered with, or signed by a rotated secret. All the same
    // outcome: no session. Never surface the reason to the caller.
    return null;
  }
}
