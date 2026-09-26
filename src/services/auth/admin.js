import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db, sql } from '@/services/db';
import { issuePortalSession, validPortalSession, revokePortalSession } from './portal-sessions.js';
import { capabilitiesFor } from './capabilities.js';
import { unauthorized } from '@/utils/apiError.js';
import { adminUsers } from '@/services/db/schema/index.js';
import { getEnv } from '@/services/schemas/joi/env';

/**
 * Super Admin session — a SEPARATE cookie from the client/customer session.
 *
 * Sharing one cookie would mean a single token could be read as either an
 * admin or a client depending on which decoder ran, and role confusion on the
 * account that releases payouts is not a bug worth risking. Different cookie,
 * different audience claim, shorter life.
 */

const ADMIN_COOKIE = 'rentra_admin';
const ADMIN_TTL_SECONDS = 60 * 60 * 8; // 8 hours — a shift, not a month
const AUDIENCE = 'rentra:admin';

function key() {
  return new TextEncoder().encode(getEnv().SESSION_SECRET);
}

export async function createAdminSession(adminId, verified) {
  const sessionId = await issuePortalSession(sql, 'admin', adminId, ADMIN_TTL_SECONDS, verified);
  if (!sessionId) throw unauthorized('ADMIN_REQUIRED');
  const token = await new SignJWT({ adminId, sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_TTL_SECONDS}s`)
    .sign(key());

  const jar = await cookies();
  jar.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'strict', // stricter than the client session: no cross-site use
    path: '/',
    maxAge: ADMIN_TTL_SECONDS,
  });
}

export async function destroyAdminSession() {
  await revokePortalSession(sql, await readAdminToken(), 'admin');
  const jar = await cookies();
  jar.delete(ADMIN_COOKIE);
}

async function readAdminToken() {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    // Audience is checked, so a client session token cannot be replayed here.
    const { payload } = await jwtVerify(token, key(), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
    });
    return payload;
  } catch {
    return null;
  }
}

export const getCurrentAdmin = cache(async () => {
  const payload = await readAdminToken();
  if (!payload?.adminId || !(await validPortalSession(sql, payload, 'admin'))) return null;

  const [admin] = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      isActive: adminUsers.isActive,
      permissions: adminUsers.permissions,
      hasTotp: adminUsers.totpSecret,
      lastLoginAt: adminUsers.lastLoginAt,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, payload.adminId))
    .limit(1);

  // Deactivated mid-session? The cookie is still valid but the account is not.
  if (!admin || !admin.isActive) return null;

  const { permissions: _permissions, ...publicAdmin } = admin;
  return { ...publicAdmin, capabilities: capabilitiesFor(admin, 'admin'), hasTotp: Boolean(admin.hasTotp) };
});

export async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/admin/login');
  return admin;
}

export { ADMIN_COOKIE, ADMIN_TTL_SECONDS };
