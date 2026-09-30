import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { ADMIN_CAPABILITIES, capabilitiesFor } from '../auth/capabilities.js';
import { recentAuthentication } from '../auth/recent-auth.js';
import {
  hashPassword,
  generateStrongPassword,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from '../auth/admin-crypto.js';
import { conflict, forbidden, notFound, unauthorized, unprocessable } from '@/utils/apiError.js';

const uuid = z.string().uuid();
const digest = (token) => createHash('sha256').update(token).digest('hex');
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw unprocessable({}, 'Check the operator details and confirmation.');
  return result.data;
};
const grant = z.array(z.enum(ADMIN_CAPABILITIES)).max(ADMIN_CAPABILITIES.length).nullable();
const commandSchema = z.object({
  command: z.enum(['create', 'access', 'enroll', 'recover', 'cancel_enrollment', 'revoke']),
  version: z.number().int().min(1).optional(),
  reason: z.string().trim().min(8).max(1000),
  confirmed: z.literal(true),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  permissions: grant.optional(),
  active: z.boolean().optional(),
  sessionId: uuid.optional(),
});
function publicOperator(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    active: row.is_active,
    fullAccess: row.permissions === null,
    capabilities: capabilitiesFor({ isActive: true, permissions: row.permissions }, 'admin'),
    hasTotp: Boolean(row.has_totp),
    enrollmentPending: Boolean(row.enrollment_pending),
    version: row.security_version,
    lastLoginAt: row.last_login_at,
    lockedUntil: row.locked_until,
  };
}
async function actorRow(tx, actor, write = false) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw forbidden();
  const [row] = await tx`SELECT id,is_active,permissions FROM admin_user WHERE id=${actor.id}`;
  const caps =
    row && capabilitiesFor({ isActive: row.is_active, permissions: row.permissions }, 'admin');
  if (!caps?.includes(`admin.security.${write ? 'write' : 'read'}`))
    throw forbidden('CAPABILITY_REQUIRED');
  if (
    write &&
    !(
      await recentAuthentication(tx, {
        kind: 'admin',
        principalId: actor.id,
        sessionId: actor.sessionId,
      })
    ).fresh
  )
    throw forbidden(
      'RECENT_AUTH_REQUIRED',
      'Sign in again within 15 minutes before changing access.',
    );
  return row;
}
async function audit(tx, actor, id, action, reason, after = {}) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,reason,after)
    VALUES ('admin',${actor.id},'admin_user',${id},${action},${reason},${JSON.stringify(after)}::text::jsonb)`;
}
export async function listOperators(db, actor, query = {}) {
  await actorRow(db, actor);
  const f = parse(
    z.object({
      q: z.string().trim().max(100).default(''),
      status: z.enum(['all', 'active', 'inactive']).default('all'),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    }),
    query,
  );
  const where = db`(${f.q}='' OR position(lower(${f.q}) in lower(name||' '||email))>0)
    AND (${f.status}='all' OR is_active=(${f.status}='active'))`;
  const [count] = await db`SELECT count(*)::int total FROM admin_user WHERE ${where}`;
  const pages = Math.max(1, Math.ceil(count.total / 20)),
    page = Math.min(f.page, pages);
  const rows = await db`SELECT id,name,email,is_active,permissions,totp_secret IS NOT NULL has_totp,
    enrollment_hash IS NOT NULL enrollment_pending,security_version,last_login_at,locked_until
    FROM admin_user WHERE ${where} ORDER BY name,id LIMIT 20 OFFSET ${(page - 1) * 20}`;
  return {
    ...f,
    page,
    pages,
    total: count.total,
    items: rows.map(publicOperator),
    capabilityOptions: ADMIN_CAPABILITIES,
    canWrite: Boolean(await canWrite(db, actor)),
  };
}
async function canWrite(db, actor) {
  const [row] = await db`SELECT is_active,permissions FROM admin_user WHERE id=${actor.id}`;
  return (
    row &&
    capabilitiesFor({ isActive: row.is_active, permissions: row.permissions }, 'admin').includes(
      'admin.security.write',
    )
  );
}
export async function readOperator(db, actor, id) {
  await actorRow(db, actor);
  if (!uuid.safeParse(id).success) throw notFound();
  const [row] =
    await db`SELECT id,name,email,is_active,permissions,totp_secret IS NOT NULL has_totp,
    enrollment_hash IS NOT NULL enrollment_pending,security_version,last_login_at,locked_until
    FROM admin_user WHERE id=${id}`;
  if (!row) throw notFound();
  const sessions = await db`SELECT id,created_at,expires_at FROM auth_session WHERE admin_id=${id}
    AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 100`;
  const history =
    await db`SELECT action,reason,at AS created_at FROM audit_log WHERE entity='admin_user'
    AND entity_id=${id} AND action LIKE 'operator_%' ORDER BY at DESC LIMIT 30`;
  return {
    operator: publicOperator(row),
    sessions,
    history,
    capabilityOptions: ADMIN_CAPABILITIES,
    canWrite: Boolean(await canWrite(db, actor)),
    self: id === actor.id,
  };
}
async function ensureOtherSuper(tx, id) {
  const [row] = await tx`SELECT count(*)::int n FROM admin_user WHERE id<>${id} AND is_active
    AND permissions IS NULL AND totp_secret IS NOT NULL AND enrollment_hash IS NULL
    AND (locked_until IS NULL OR locked_until<=clock_timestamp())`;
  if (!row.n)
    throw conflict(
      'LAST_SUPER_ADMIN',
      'Keep another active Super Admin with an enrolled factor and usable sign-in.',
    );
}
function permittedPermissions(manager, target, permissions) {
  if (manager.permissions === null) return;
  if (
    target?.permissions === null ||
    target?.permissions?.some((p) => !manager.permissions.includes(p)) ||
    permissions === null ||
    permissions?.some((p) => !manager.permissions.includes(p))
  )
    throw forbidden(
      'GRANT_NOT_PERMITTED',
      'You can assign only capabilities you hold, and cannot manage full Super Admins.',
    );
}
export async function operatorCommand(db, actor, id, input) {
  const f = parse(commandSchema, input);
  return db.begin(async (tx) => {
    // Shared across all security writers: serialize last-admin checks and recovery completion.
    await tx`SELECT pg_advisory_xact_lock(260026)`;
    const manager = await actorRow(tx, actor, true);
    let target;
    if (f.command === 'create') {
      if (!f.email || !f.name || f.permissions === undefined) throw unprocessable({});
      permittedPermissions(manager, null, f.permissions);
      const [exists] = await tx`SELECT id FROM admin_user WHERE email=${f.email}`;
      if (exists) throw conflict('EMAIL_IN_USE', 'That operator email already exists.');
      [target] = await tx`INSERT INTO admin_user(email,name,password_hash,permissions)
        VALUES (${f.email},${f.name},${hashPassword(generateStrongPassword())},${f.permissions === null ? null : JSON.stringify([...new Set(f.permissions)])}::text::jsonb) RETURNING *`;
      id = target.id;
    } else {
      if (!uuid.safeParse(id).success) throw notFound();
      [target] = await tx`SELECT * FROM admin_user WHERE id=${id} FOR UPDATE`;
      if (!target) throw notFound();
      if (f.version !== target.security_version)
        throw conflict('OPERATOR_CHANGED', 'This operator changed. Reload before confirming.');
      permittedPermissions(manager, target, f.permissions);
    }
    if (['access', 'recover'].includes(f.command)) {
      if (id === actor.id)
        throw conflict(
          'SELF_LOCKOUT',
          'Ask another authorized operator to change your access or recover your factor.',
        );
      if (
        target.permissions === null &&
        target.is_active &&
        (f.command === 'recover' || f.active === false || f.permissions !== null)
      )
        await ensureOtherSuper(tx, id);
    }
    if (f.command === 'access') {
      if (f.active === undefined || f.permissions === undefined) throw unprocessable({});
      const permissions = f.permissions === null ? null : [...new Set(f.permissions)].sort();
      if (
        f.active === target.is_active &&
        JSON.stringify(permissions) === JSON.stringify(target.permissions)
      )
        throw conflict('NO_CHANGE', 'Access is unchanged.');
      await tx`UPDATE admin_user SET is_active=${f.active},permissions=${permissions === null ? null : JSON.stringify(permissions)}::text::jsonb,
        enrollment_hash=NULL,enrollment_secret=NULL,enrollment_expires_at=NULL,security_version=security_version+1 WHERE id=${id}`;
    } else if (['create', 'enroll', 'recover'].includes(f.command)) {
      if (!target.is_active)
        throw conflict('OPERATOR_INACTIVE', 'Activate this operator before enrollment.');
      if (f.command === 'enroll' && target.totp_secret)
        throw conflict('FACTOR_EXISTS', 'Use audited recovery to replace an enrolled factor.');
      if (target.permissions === null && target.totp_secret) await ensureOtherSuper(tx, id);
      const token = randomBytes(32).toString('hex');
      await tx`UPDATE admin_user SET enrollment_hash=${digest(token)},enrollment_secret=${generateTotpSecret()},
        enrollment_expires_at=clock_timestamp()+interval '30 minutes',totp_secret=NULL,
        password_hash=${hashPassword(generateStrongPassword())},security_version=security_version+1 WHERE id=${id}`;
      await audit(tx, actor, id, `operator_${f.command}`, f.reason, { expiresInMinutes: 30 });
      return { ok: true, id, enrollmentToken: token, expiresInMinutes: 30 };
    } else if (f.command === 'cancel_enrollment') {
      if (!target.enrollment_hash) throw conflict('NO_ENROLLMENT', 'No pending enrollment.');
      await tx`UPDATE admin_user SET enrollment_hash=NULL,enrollment_secret=NULL,enrollment_expires_at=NULL,
        security_version=security_version+1 WHERE id=${id}`;
    } else if (f.command === 'revoke') {
      const rows =
        await tx`UPDATE auth_session SET revoked_at=clock_timestamp() WHERE admin_id=${id}
        AND revoked_at IS NULL AND expires_at>clock_timestamp() AND (${f.sessionId ?? null}::uuid IS NULL OR id=${f.sessionId ?? null}::uuid) RETURNING id`;
      await audit(tx, actor, id, 'operator_revoke', f.reason, { count: rows.length });
      return { ok: true, id };
    }
    await audit(
      tx,
      actor,
      id,
      `operator_${f.command}`,
      f.reason,
      f.command === 'access' ? { active: f.active, permissions: f.permissions } : {},
    );
    return { ok: true, id };
  });
}
export async function enrollOperator(db, input) {
  const f = parse(
    z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      command: z.enum(['preview', 'complete']),
      password: z.string().min(12).max(128).optional(),
      totp: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
    }),
    input,
  );
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(260026)`;
    const [row] =
      await tx`SELECT * FROM admin_user WHERE enrollment_hash=${digest(f.token)} AND is_active
      AND enrollment_expires_at>clock_timestamp() FOR UPDATE`;
    if (!row)
      throw unauthorized(
        'ENROLLMENT_ENDED',
        'This enrollment link expired or was revoked. Request a new link.',
      );
    if (f.command === 'preview')
      return {
        email: row.email,
        uri: totpUri({ email: row.email, secret: row.enrollment_secret }),
      };
    if (!f.password || !verifyTotp({ secret: row.enrollment_secret, token: f.totp }))
      throw unprocessable(
        {},
        'Enter a password of at least 12 characters and the correct authenticator code.',
      );
    await tx`UPDATE admin_user SET password_hash=${hashPassword(f.password)},totp_secret=${row.enrollment_secret},
      enrollment_hash=NULL,enrollment_secret=NULL,enrollment_expires_at=NULL,failed_attempts=0,locked_until=NULL,
      security_version=security_version+1 WHERE id=${row.id}`;
    await audit(
      tx,
      { id: row.id },
      row.id,
      'operator_enrollment_completed',
      'Password and factor confirmed by enrollment recipient',
    );
    return { ok: true };
  });
}
