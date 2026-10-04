import { z } from 'zod';

const uuid = z.string().uuid();

/** Read-only visibility check: never creates a customer account. */
export async function hasCustomerAccount(database, owner) {
  if (
    owner?.role !== 'client' ||
    !owner.phone ||
    !owner.phoneVerifiedAt ||
    !['active', 'pending_application'].includes(owner.accountStatus)
  )
    return false;
  const [customer] = await database`SELECT id FROM "user"
    WHERE role='customer' AND phone=${owner.phone}
      AND phone_verified_at IS NOT NULL AND account_status='active' LIMIT 1`;
  return Boolean(customer);
}

/** A live session plus a verified mobile proves ownership of the other role.
 * Never use an unverified profile field or client-supplied account ID to link accounts.
 * New sessions inherit the source expiry; switching cannot keep a login alive forever.
 */
export async function issueSwitchedSession(database, source, targetRole, env = process.env) {
  if (
    !['client', 'customer'].includes(targetRole) ||
    !['client', 'customer'].includes(source?.role) ||
    !uuid.safeParse(source?.userId).success ||
    !uuid.safeParse(source?.sessionId).success ||
    (source.development && !['development', 'test'].includes(env.NODE_ENV))
  ) {
    return { error: 'Sign in again to continue.', code: 'SESSION_INVALID' };
  }
  return database.begin(async (tx) => {
    // Serialize both directions for one phone before locking either principal.
    const [identity] =
      await tx`SELECT phone FROM "user" WHERE id=${source.userId} AND role=${source.role}`;
    if (identity?.phone)
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'role-switch:' + identity.phone},0))`;
    const [actor] = await tx`SELECT u.id,u.role,u.phone,u.phone_verified_at,u.name,s.expires_at
      FROM "user" u JOIN auth_session s ON s.user_id=u.id
      WHERE u.id=${source.userId} AND u.role=${source.role} AND s.id=${source.sessionId}
        AND s.revoked_at IS NULL AND s.expires_at>now()
        AND (u.account_status='active' OR (u.role='client' AND u.account_status='pending_application'))
      FOR UPDATE OF u`;
    if (!actor)
      return {
        error: 'Your session has expired or was revoked. Sign in again.',
        code: 'SESSION_INVALID',
      };
    if (actor.phone !== identity?.phone)
      return { error: 'Your contact changed. Try switching again.', code: 'CONTACT_CHANGED' };
    if (!actor.phone || !actor.phone_verified_at) {
      return {
        error:
          'Verify your mobile number once in owner account details to enable booking and account switching.',
        code: 'PHONE_VERIFICATION_REQUIRED',
      };
    }
    const status = targetRole === 'customer' ? 'active' : 'pending_application';
    await tx`INSERT INTO "user"(phone,phone_verified_at,role,account_status,name)
      VALUES (${actor.phone},now(),${targetRole},${status},${actor.name}) ON CONFLICT (phone,role) DO NOTHING`;
    const [target] = await tx`SELECT id,account_status,phone_verified_at FROM "user"
      WHERE phone=${actor.phone} AND role=${targetRole} FOR UPDATE`;
    if (!target.phone_verified_at) {
      return {
        error:
          'This mobile is attached to an account that has not verified it. Verify that account once before switching.',
        code: 'ACCOUNT_LINK_REQUIRED',
      };
    }
    if (
      !['active', ...(targetRole === 'client' ? ['pending_application'] : [])].includes(
        target.account_status,
      )
    ) {
      return {
        error: 'This account is restricted. Contact Rentra for help.',
        code: 'ACCOUNT_RESTRICTED',
      };
    }
    const [session] = await tx`INSERT INTO auth_session(user_id,expires_at)
      VALUES (${target.id},${actor.expires_at}) RETURNING id`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action)
      VALUES (${targetRole},${target.id},'user',${target.id},'account_role_switched')`;
    return {
      userId: target.id,
      role: targetRole,
      accountStatus: target.account_status,
      sessionId: session.id,
      development: Boolean(source.development),
    };
  });
}
