import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';

/**
 * Owner-managed caretaker access (CP16).
 *
 * A caretaker is a `client_staff` row: one owner, one phone. The owner invites
 * with a one-time link (only its SHA-256 is stored, the link is shown once),
 * chooses the properties, and whether the caretaker may record handover,
 * return and completion evidence. Nothing else is grantable: earnings,
 * pricing, KYC and team administration are not caretaker capabilities.
 * Assignment and revocation are read live on every caretaker request.
 */

export const INVITE_TTL_HOURS = 72;
const uuid = z.string().uuid();
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/** Bare 10-digit Indian mobile; the same normalisation the OTP layer uses. */
export function staffPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  const bare =
    digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith('0')
        ? digits.slice(1)
        : digits;
  return /^[6-9]\d{9}$/.test(bare) ? bare : null;
}

const fields = (error) =>
  Object.fromEntries(error.issues.map((issue) => [issue.path[0] ?? '_', issue.message]));
const flag = z.preprocess((value) => value === true || value === 'on' || value === 'true' || value === '1', z.boolean());
const propertyIds = z
  .array(uuid, { invalid_type_error: 'Choose at least one property.' })
  .min(1, 'Choose at least one property.')
  .max(50);
const accessInput = z.object({ propertyIds, evidence: flag });
const inviteInput = accessInput.extend({
  name: z.string().trim().min(2, 'Enter the caretaker’s name.').max(80),
  phone: z.string().transform((value, ctx) => {
    const phone = staffPhone(value);
    if (!phone) ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit Indian mobile number.' });
    return phone;
  }),
});
const versioned = { expectedVersion: z.coerce.number().int().min(1) };

const list = (value) => [].concat(value ?? []).filter(Boolean);

function parse(schema, input) {
  const parsed = schema.safeParse({ ...input, propertyIds: list(input?.propertyIds ?? input?.propertyId) });
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  return parsed.data;
}

async function audit(tx, { actorType, actorId, staffId, action, before = null, after = null, reason = null }) {
  await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, before, after, reason)
    VALUES (${actorType}, ${actorId}, 'client_staff', ${staffId}, ${action},
      ${before ? JSON.stringify(before) : null}::text::jsonb, ${after ? JSON.stringify(after) : null}::text::jsonb, ${reason})`;
}

async function activeOwner(tx, ownerId) {
  const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`;
  if (!owner) throw conflict('CLIENT_NOT_ACTIVE', 'Your account must be active to manage your team.');
}

/** Guessed or foreign property ids are refused as a whole, never partly applied. */
async function ownedProperties(tx, ownerId, ids) {
  const unique = [...new Set(ids)];
  const rows = await tx`SELECT id FROM rentable WHERE client_id=${ownerId} AND id IN ${tx(unique)}`;
  if (rows.length !== unique.length) throw unprocessable({ propertyIds: 'Choose from your own properties.' });
  return unique.sort();
}

async function lockMember(tx, ownerId, staffId) {
  if (!uuid.safeParse(staffId).success) throw notFound('STAFF_NOT_FOUND', 'Team member not found.');
  const [row] = await tx`SELECT * FROM client_staff WHERE id=${staffId} AND client_id=${ownerId} FOR UPDATE`;
  if (!row) throw notFound('STAFF_NOT_FOUND', 'Team member not found.');
  return row;
}

async function setProperties(tx, staffId, ids) {
  await tx`DELETE FROM staff_property WHERE staff_id=${staffId}`;
  for (const id of ids) await tx`INSERT INTO staff_property(staff_id, rentable_id) VALUES (${staffId}, ${id})`;
}

async function issueLink(tx, staffId) {
  await tx`UPDATE staff_invitation SET revoked_at=now()
    WHERE staff_id=${staffId} AND used_at IS NULL AND revoked_at IS NULL`;
  const token = newToken();
  const [row] = await tx`INSERT INTO staff_invitation(staff_id, token_hash, expires_at)
    VALUES (${staffId}, ${hashToken(token)}, now() + ${INVITE_TTL_HOURS} * interval '1 hour') RETURNING expires_at`;
  return { token, expiresAt: row.expires_at };
}

const memberState = (row) =>
  row.revoked_at ? 'revoked' : row.accepted_at ? 'active' : row.pending ? 'invited' : 'invite_expired';

export async function listTeam(database, ownerId) {
  const rows = await database`SELECT s.*,
      (SELECT max(p.created_at) FROM portal_session p WHERE p.staff_id=s.id) AS last_session_at,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title) ORDER BY r.title), '[]'::jsonb)
         FROM staff_property sp JOIN rentable r ON r.id=sp.rentable_id WHERE sp.staff_id=s.id) AS properties,
      (SELECT jsonb_build_object('expiresAt', i.expires_at, 'createdAt', i.created_at) FROM staff_invitation i
         WHERE i.staff_id=s.id AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
         ORDER BY i.created_at DESC LIMIT 1) AS pending
    FROM client_staff s WHERE s.client_id=${ownerId} ORDER BY s.revoked_at IS NOT NULL, s.created_at DESC`;
  const properties = await database`SELECT id, title, status FROM rentable WHERE client_id=${ownerId} ORDER BY title`;
  const history = await database`SELECT l.id, l.action, l.actor_type, l.after, l.reason, l.at, s.name AS staff_name
    FROM audit_log l JOIN client_staff s ON s.id::text=l.entity_id
    WHERE l.entity='client_staff' AND s.client_id=${ownerId} ORDER BY l.at DESC, l.id DESC LIMIT 50`;
  return {
    members: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      state: memberState(row),
      permissions: { evidence: row.permissions?.evidence === true },
      properties: row.properties,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
      lastSessionAt: row.last_session_at,
      pendingInvite: row.pending,
      version: row.version,
    })),
    properties: properties.map((p) => ({ id: p.id, title: p.title, status: p.status })),
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      actor: h.actor_type === 'staff' ? 'caretaker' : h.actor_type === 'client' ? 'you' : 'rentra',
      staffName: h.staff_name,
      properties: h.after?.properties?.length ?? null,
      evidence: h.after?.evidence ?? null,
      reason: h.reason,
      at: h.at,
    })),
  };
}

/** Invites a new caretaker, or re-invites a revoked one with fresh access. */
export async function inviteStaff(database, ownerId, input) {
  const d = parse(inviteInput, input);
  return database.begin(async (tx) => {
    await activeOwner(tx, ownerId);
    const ids = await ownedProperties(tx, ownerId, d.propertyIds);
    const [existing] = await tx`SELECT * FROM client_staff WHERE client_id=${ownerId} AND phone=${d.phone} FOR UPDATE`;
    if (existing && !existing.revoked_at)
      throw conflict('STAFF_EXISTS', 'This number is already on your team. Issue a new link for it instead.');
    const permissions = JSON.stringify({ evidence: d.evidence });
    const [staff] = existing
      ? await tx`UPDATE client_staff SET name=${d.name}, permissions=${permissions}::text::jsonb, is_active=true,
          revoked_at=NULL, revoked_reason=NULL, accepted_at=NULL, version=version+1, updated_at=now()
          WHERE id=${existing.id} RETURNING id, version`
      : await tx`INSERT INTO client_staff(client_id, phone, name, permissions)
          VALUES (${ownerId}, ${d.phone}, ${d.name}, ${permissions}::text::jsonb) RETURNING id, version`;
    await setProperties(tx, staff.id, ids);
    const link = await issueLink(tx, staff.id);
    await audit(tx, {
      actorType: 'client',
      actorId: ownerId,
      staffId: staff.id,
      action: 'staff_invited',
      after: { name: d.name, properties: ids, evidence: d.evidence },
    });
    return { staffId: staff.id, version: staff.version, ...link };
  });
}

/** A fresh one-time link: for a first invite that expired, or to sign in again. */
export async function reissueStaffLink(database, ownerId, staffId) {
  return database.begin(async (tx) => {
    await activeOwner(tx, ownerId);
    const staff = await lockMember(tx, ownerId, staffId);
    if (staff.revoked_at) throw conflict('STAFF_REVOKED', 'This caretaker’s access was revoked. Invite them again.');
    const link = await issueLink(tx, staff.id);
    await audit(tx, { actorType: 'client', actorId: ownerId, staffId: staff.id, action: 'staff_link_issued' });
    return { staffId: staff.id, ...link };
  });
}

/** Reassign properties or change the evidence grant; effective on the next caretaker request. */
export async function updateStaffAccess(database, ownerId, staffId, input) {
  const d = parse(accessInput.extend(versioned), input);
  return database.begin(async (tx) => {
    await activeOwner(tx, ownerId);
    const staff = await lockMember(tx, ownerId, staffId);
    if (staff.version !== d.expectedVersion)
      throw conflict('STAFF_CHANGED', 'This team member changed after you opened it. Reload and try again.');
    if (staff.revoked_at) throw conflict('STAFF_REVOKED', 'This caretaker’s access was revoked. Invite them again.');
    const ids = await ownedProperties(tx, ownerId, d.propertyIds);
    const before = (await tx`SELECT rentable_id FROM staff_property WHERE staff_id=${staff.id} ORDER BY rentable_id`).map((r) => r.rentable_id);
    await setProperties(tx, staff.id, ids);
    const [row] = await tx`UPDATE client_staff SET permissions=${JSON.stringify({ evidence: d.evidence })}::text::jsonb,
        version=version+1, updated_at=now() WHERE id=${staff.id} RETURNING version`;
    await audit(tx, {
      actorType: 'client',
      actorId: ownerId,
      staffId: staff.id,
      action: 'staff_access_changed',
      before: { properties: before, evidence: staff.permissions?.evidence === true },
      after: { properties: ids, evidence: d.evidence },
    });
    return { staffId: staff.id, version: row.version };
  });
}

/** Immediate: sessions end on the caretaker's next request and every unused link dies. */
export async function revokeStaff(database, ownerId, staffId, input) {
  const parsed = z
    .object({ ...versioned, reason: z.string().trim().min(4, 'Give a short reason.').max(500) })
    .safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  return database.begin(async (tx) => {
    const staff = await lockMember(tx, ownerId, staffId);
    if (staff.version !== d.expectedVersion)
      throw conflict('STAFF_CHANGED', 'This team member changed after you opened it. Reload and try again.');
    if (staff.revoked_at) throw conflict('STAFF_REVOKED', 'This caretaker’s access is already revoked.');
    const [row] = await tx`UPDATE client_staff SET revoked_at=now(), is_active=false, revoked_reason=${d.reason},
        version=version+1, updated_at=now() WHERE id=${staff.id} RETURNING version`;
    const sessions = await tx`UPDATE portal_session SET revoked_at=now()
      WHERE staff_id=${staff.id} AND revoked_at IS NULL RETURNING id`;
    await tx`UPDATE staff_invitation SET revoked_at=now() WHERE staff_id=${staff.id} AND used_at IS NULL AND revoked_at IS NULL`;
    await audit(tx, {
      actorType: 'client',
      actorId: ownerId,
      staffId: staff.id,
      action: 'staff_revoked',
      after: { sessionsRevoked: sessions.length },
      reason: d.reason,
    });
    return { staffId: staff.id, version: row.version, sessionsRevoked: sessions.length };
  });
}

/* ------------------------------ invitations ------------------------------ */

async function findInvite(database, token, { lock = false } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const hash = hashToken(token);
  const rows = lock
    ? await database`SELECT i.*, s.name AS staff_name, s.phone, s.client_id, s.revoked_at AS staff_revoked_at,
        o.name AS owner_name, o.account_status FROM staff_invitation i JOIN client_staff s ON s.id=i.staff_id
        JOIN "user" o ON o.id=s.client_id WHERE i.token_hash=${hash} FOR UPDATE OF i, s`
    : await database`SELECT i.*, s.name AS staff_name, s.phone, s.client_id, s.revoked_at AS staff_revoked_at,
        o.name AS owner_name, o.account_status FROM staff_invitation i JOIN client_staff s ON s.id=i.staff_id
        JOIN "user" o ON o.id=s.client_id WHERE i.token_hash=${hash}`;
  return rows[0] ?? null;
}

export function inviteState(row, now = new Date()) {
  if (!row) return 'invalid';
  if (row.used_at) return 'used';
  if (row.revoked_at || row.staff_revoked_at) return 'revoked';
  if (new Date(row.expires_at) <= now) return 'expired';
  if (row.account_status !== 'active') return 'unavailable';
  return 'valid';
}

/** What the invitation page may show before the caretaker proves the phone. */
export async function inspectInvite(database, token) {
  const row = await findInvite(database, token);
  const state = inviteState(row);
  if (state !== 'valid') return { state };
  const properties = await database`SELECT r.title FROM staff_property sp JOIN rentable r ON r.id=sp.rentable_id
    WHERE sp.staff_id=${row.staff_id} ORDER BY r.title`;
  return {
    state,
    ownerName: row.owner_name,
    staffName: row.staff_name,
    phoneHint: row.phone.slice(-2),
    expiresAt: row.expires_at,
    properties: properties.map((p) => p.title),
  };
}

/** The invited phone, for sending the one-time code. Null unless the link is usable. */
export async function invitePhone(database, token) {
  const row = await findInvite(database, token);
  return inviteState(row) === 'valid' ? row.phone : null;
}

/**
 * Consumes the link after the phone code is verified. A second use, including
 * a concurrent one, is refused: exactly one acceptance wins.
 */
export async function consumeInvite(database, token) {
  return database.begin(async (tx) => {
    const row = await findInvite(tx, token, { lock: true });
    const state = inviteState(row);
    if (state !== 'valid')
      throw conflict(`INVITE_${state.toUpperCase()}`, 'This link can no longer be used. Ask the owner for a new one.');
    await tx`UPDATE staff_invitation SET used_at=now() WHERE id=${row.id}`;
    await tx`UPDATE client_staff SET accepted_at=coalesce(accepted_at, now()), updated_at=now() WHERE id=${row.staff_id}`;
    await audit(tx, { actorType: 'staff', actorId: row.staff_id, staffId: row.staff_id, action: 'staff_invite_accepted' });
    return { staffId: row.staff_id };
  });
}

/** Active, accepted caretakers for a phone whose owner is active. */
export async function staffForPhone(database, phone) {
  return database`SELECT s.id, o.name AS owner_name FROM client_staff s JOIN "user" o ON o.id=s.client_id
    WHERE s.phone=${phone} AND s.is_active AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL
      AND o.role='client' AND o.account_status='active'`;
}
