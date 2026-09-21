import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '@/services/db';
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

export async function createAdminSession(adminId) {
  const token = await new SignJWT({ adminId })
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
  if (!payload?.adminId) return null;

  const [admin] = await db
    .select({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      isActive: adminUsers.isActive,
      hasTotp: adminUsers.totpSecret,
      lastLoginAt: adminUsers.lastLoginAt,
    })
    .from(adminUsers)
    .where(eq(adminUsers.id, payload.adminId))
    .limit(1);

  // Deactivated mid-session? The cookie is still valid but the account is not.
  if (!admin || !admin.isActive) return null;

  return { ...admin, hasTotp: Boolean(admin.hasTotp) };
});

export async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/admin/login');
  return admin;
}

export { ADMIN_COOKIE, ADMIN_TTL_SECONDS };
