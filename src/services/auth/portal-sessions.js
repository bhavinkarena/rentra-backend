import { z } from 'zod';

const uuid = z.string().uuid();
const identity = (claims, kind) => kind === 'admin' ? claims?.adminId : kind === 'staff' ? claims?.staffId
  : kind === 'client' && claims?.role === 'client' ? claims.userId : null;

/** Issuance locks the principal, matching the revocation trigger's lock order. */
export async function issuePortalSession(database, kind, id, ttlSeconds, verified = {}) {
  if (!['admin', 'client', 'staff'].includes(kind) || !uuid.safeParse(id).success) throw new Error('Invalid session principal');
  return database.begin(async tx => {
    const rows = kind === 'admin'
      ? await tx`SELECT id,email,password_hash,totp_secret FROM admin_user WHERE id=${id} AND is_active=true FOR UPDATE`
      : kind === 'staff'
        ? await tx`SELECT s.id FROM client_staff s WHERE s.id=${id} AND s.is_active=true AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM "user" o WHERE o.id=s.client_id AND o.role='client' AND o.account_status='active') FOR UPDATE OF s`
        : await tx`SELECT id,email FROM "user" WHERE id=${id} AND role='client' AND account_status IN ('active','pending_application') FOR UPDATE`;
    if (!rows.length) return null;
    if (verified.email !== undefined && verified.email !== rows[0].email) return null;
    if (kind === 'admin' && verified.passwordHash !== undefined
      && (verified.passwordHash !== rows[0].password_hash || verified.totpSecret !== rows[0].totp_secret)) return null;
    const [session] = kind === 'staff'
      ? await tx`INSERT INTO portal_session(staff_id,expires_at) VALUES (${id},now()+${ttlSeconds}*interval '1 second') RETURNING id`
      : await tx`INSERT INTO portal_session(user_id,admin_id,expires_at)
        VALUES (${kind === 'client' ? id : null},${kind === 'admin' ? id : null},now()+${ttlSeconds}*interval '1 second') RETURNING id`;
    return session.id;
  });
}

export async function validPortalSession(database, claims, kind) {
  const id = identity(claims, kind);
  if (!uuid.safeParse(id).success || !uuid.safeParse(claims?.sessionId).success) return false;
  if (kind === 'staff') {
    const rows = await database`SELECT p.id FROM portal_session p JOIN client_staff s ON s.id=p.staff_id
      WHERE p.id=${claims.sessionId} AND p.revoked_at IS NULL AND p.expires_at>now() AND s.id=${id} AND s.is_active=true AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM "user" o WHERE o.id=s.client_id AND o.role='client' AND o.account_status='active')`;
    return rows.length === 1;
  }
  const rows = kind === 'admin'
    ? await database`SELECT s.id FROM portal_session s JOIN admin_user a ON a.id=s.admin_id
      WHERE s.id=${claims.sessionId} AND a.id=${id} AND a.is_active=true AND s.revoked_at IS NULL AND s.expires_at>now()`
    : await database`SELECT s.id FROM portal_session s JOIN "user" u ON u.id=s.user_id
      WHERE s.id=${claims.sessionId} AND u.id=${id} AND u.role='client' AND u.account_status IN ('active','pending_application') AND s.revoked_at IS NULL AND s.expires_at>now()`;
  return rows.length === 1;
}

export async function revokePortalSession(database, claims, kind) {
  const id = identity(claims, kind);
  if (!uuid.safeParse(id).success || !uuid.safeParse(claims?.sessionId).success) return;
  await database.begin(async tx => {
    const column = { admin: tx`admin_id`, staff: tx`staff_id`, client: tx`user_id` }[kind];
    const rows = await tx`UPDATE portal_session SET revoked_at=now() WHERE id=${claims.sessionId} AND ${column}=${id} AND revoked_at IS NULL RETURNING id`;
    if (rows.length) await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action)
      VALUES (${kind},${id},'portal_session',${claims.sessionId},'session_revoked')`;
  });
}
