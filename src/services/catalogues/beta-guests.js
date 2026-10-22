import 'server-only';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '@/utils/apiError.js';
import { customerPhone } from '../auth/customer-identity.js';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { authorize } from './service.js';
import { issueBetaPass } from '../auth/beta-access.js';

/** Closed beta invites (hotel plan, Phase 9): admin list/invite/revoke and the customer's pass claim. */
const code = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

/** Customer: exchange an invite for a beta pass. Only verticals still in partners. */
export async function claimBetaPass(database, session, env = process.env) {
  return database.begin(async (tx) => {
    const customer = await lockCustomerAccount(tx, session, env);
    const rows = await tx`SELECT DISTINCT g.vertical_code FROM vertical_beta_guest g JOIN vertical v ON v.code = g.vertical_code AND v.status = 'partners'
      WHERE g.revoked_at IS NULL AND g.phone = right(${customer.phone ?? ''}, 10) ORDER BY 1`;
    if (!rows.length) throw notFound('NOT_INVITED', 'This account is not on a beta list.');
    return issueBetaPass(rows.map((row) => row.vertical_code), env);
  });
}

/** Admin: invites for one vertical. */
export async function listBetaGuests(database, actor, vertical) {
  code.parse(vertical);
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const [row] = await tx`SELECT code, name, status FROM vertical WHERE code = ${vertical}`;
    if (!row) throw notFound();
    const items = await tx`SELECT g.id, g.phone, g.note, g.created_at AS "createdAt", a.email AS "invitedBy",
        EXISTS (SELECT 1 FROM "user" u WHERE u.role = 'customer' AND right(u.phone, 10) = g.phone) AS "hasAccount"
      FROM vertical_beta_guest g JOIN admin_user a ON a.id = g.invited_by
      WHERE g.vertical_code = ${vertical} AND g.revoked_at IS NULL ORDER BY g.created_at DESC`;
    return { vertical: row, items, canWrite };
  });
}

/** Admin: add phones (one per line or comma separated) or revoke one invite. Audited. */
export async function betaGuestCommand(database, actor, vertical, input) {
  code.parse(vertical);
  const value = z.discriminatedUnion('action', [
    z.object({ action: z.literal('invite'), phones: z.string().max(5000), note: z.string().trim().max(120).optional() }).strict(),
    z.object({ action: z.literal('revoke'), id: z.string().uuid() }).strict(),
  ]).safeParse(input);
  if (!value.success) throw badRequest('INVALID_INVITE', 'Enter Indian mobile numbers, one per line.');
  return database.begin(async (tx) => {
    if (!(await authorize(tx, actor, true))) throw forbidden();
    const [row] = await tx`SELECT status FROM vertical WHERE code = ${vertical} FOR SHARE`;
    if (!row) throw notFound();
    if (value.data.action === 'revoke') {
      const [revoked] = await tx`UPDATE vertical_beta_guest SET revoked_at = now(), revoked_by = ${actor.id}
        WHERE id = ${value.data.id} AND vertical_code = ${vertical} AND revoked_at IS NULL RETURNING phone`;
      if (!revoked) throw notFound();
      await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, "after")
        VALUES ('admin', ${actor.id}, 'vertical_beta_guest', ${value.data.id}, 'beta_invite_revoked', ${JSON.stringify({ vertical })}::text::jsonb)`;
      return { ok: true, revoked: 1 };
    }
    if (row.status !== 'partners') throw conflict('NOT_IN_BETA', 'Invites work only while the vertical is open to partners.');
    const raw = value.data.phones.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
    const parsed = raw.map((p) => customerPhone.safeParse(p));
    const bad = raw.filter((_, i) => !parsed[i].success);
    if (!raw.length || bad.length) throw badRequest('INVALID_INVITE', bad.length ? `Not a valid mobile number: ${bad.slice(0, 3).join(', ')}` : 'Enter at least one number.');
    const phones = [...new Set(parsed.map((p) => p.data))];
    if (phones.length > 500) throw badRequest('INVALID_INVITE', 'Invite at most 500 numbers at a time.');
    const added = await tx`INSERT INTO vertical_beta_guest (vertical_code, phone, note, invited_by)
      SELECT ${vertical}, phone, ${value.data.note || null}, ${actor.id} FROM unnest(${phones}::text[]) phone
      ON CONFLICT (vertical_code, phone) WHERE revoked_at IS NULL DO NOTHING RETURNING id`;
    await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, "after")
      VALUES ('admin', ${actor.id}, 'vertical_beta_guest', ${vertical}, 'beta_invites_added', ${JSON.stringify({ count: added.length })}::text::jsonb)`;
    return { ok: true, added: added.length, alreadyInvited: phones.length - added.length };
  });
}
