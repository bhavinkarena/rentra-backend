import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from '../db/index.js';
import { getCurrentUser } from './dal.js';
import { getCurrentAdmin } from './admin.js';
import { readSession, activateSession, roleSessionCookie } from './session.js';
import { encryptSession, decryptSession } from './session-crypto.js';
import { validCustomerSession } from './customer-identity.js';
import { validPortalSession } from './portal-sessions.js';
import { issueSwitchedSession } from './role-switch.js';
import { readCustomerSelection, SELECTION_COOKIE } from './customer-selection.js';

export async function switchAccountRole(targetRole) {
  if (!['client', 'customer'].includes(targetRole))
    return { error: 'Choose a valid account role.', code: 'WRONG_ROLE' };
  if (await getCurrentAdmin())
    return { error: 'Sign out of the administrator account before switching.', code: 'WRONG_ROLE' };
  const source = await readSession();
  if (source?.development && !['development', 'test'].includes(process.env.NODE_ENV))
    return { error: 'Sign in again to continue.', code: 'SESSION_INVALID' };
  const user = await getCurrentUser();
  if (!user) redirect(targetRole === 'client' ? '/partner/login' : '/login');
  if (user.role !== targetRole) {
    const jar = await cookies();
    const savedToken = jar.get(roleSessionCookie(targetRole))?.value;
    const saved = await decryptSession(savedToken);
    const valid =
      saved?.role === targetRole &&
      (!saved.development || ['development', 'test'].includes(process.env.NODE_ENV)) &&
      (targetRole === 'customer'
        ? await validCustomerSession(sql, saved)
        : await validPortalSession(sql, saved, 'client'));
    // A shared browser may have logged into another person's account. A saved
    // role token alone is not evidence that it belongs to the current person.
    const [samePerson] =
      valid && user.phone && user.phoneVerifiedAt
        ? await sql`SELECT id FROM "user" WHERE id=${saved.userId} AND role=${targetRole}
          AND phone=${user.phone} AND phone_verified_at IS NOT NULL`
        : [];
    if (samePerson) {
      await activateSession(savedToken);
    } else {
      const claims = await issueSwitchedSession(sql, source, targetRole);
      if (claims.error) return claims;
      await activateSession(await encryptSession(claims));
    }
  }
  if (targetRole === 'client') redirect('/partner');
  const intent = await readCustomerSelection((await cookies()).get(SELECTION_COOKIE)?.value);
  redirect(intent?.returnTo ?? '/');
}

export async function switchToClient() {
  return switchAccountRole('client');
}
