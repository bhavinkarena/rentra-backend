import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict, forbidden, unprocessable } from '@/utils/apiError.js';

const uuid = z.string().uuid();
export const PAYOUT_GATE = 'Provider execution, verified bank outcomes and funding readiness are unavailable. Auto configuration does not enable money movement.';

// Settings and new statement decisions share this mutex; no provider calls inside it.
export const lockPayoutPolicy = tx => tx`SELECT pg_advisory_xact_lock(73421, 12)`;

export async function resolvePayoutMode(tx, ownerId = null) {
  const rows = await tx`SELECT DISTINCT ON (coalesce(owner_id::text,'global')) id,owner_id,mode,version
    FROM payout_mode_setting WHERE owner_id IS NULL OR owner_id=${uuid.safeParse(ownerId).success ? ownerId : null}::uuid
    ORDER BY coalesce(owner_id::text,'global'),version DESC`;
  const global = rows.find(r => !r.owner_id);
  const owner = rows.find(r => r.owner_id);
  return { mode: owner?.mode ?? global?.mode ?? 'auto', source: owner?.mode ? 'owner' : 'global',
    globalMode: global?.mode ?? 'auto', globalVersion: global?.version ?? 0, ownerVersion: owner?.version ?? 0 };
}

export async function authorize(tx, actor, write = false) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw forbidden();
  const [admin] = await tx`SELECT permissions FROM admin_user WHERE id=${actor.id} AND is_active FOR SHARE`;
  const allowed = cap => admin && (admin.permissions == null || admin.permissions.includes(`admin.payments.${cap}`));
  if (!allowed(write ? 'write' : 'read')) throw forbidden();
  return Boolean(allowed('write'));
}

export async function listPayoutModes(database, actor) {
  return database.begin(async tx => {
    const canWrite = await authorize(tx, actor);
    const settings = await tx`SELECT s.id,s.owner_id AS "ownerId",s.mode,s.version,s.reason,s.created_at AS "createdAt",
      u.email AS "ownerEmail",a.email AS "createdBy" FROM payout_mode_setting s
      LEFT JOIN "user" u ON u.id=s.owner_id LEFT JOIN admin_user a ON a.id=s.created_by ORDER BY s.version DESC LIMIT 200`;
    return { canWrite, effective: await resolvePayoutMode(tx), settings, gate: PAYOUT_GATE };
  });
}

const schema = z.object({ ownerEmail: z.string().trim().toLowerCase().email().or(z.literal('')).default(''),
  mode: z.enum(['auto','manual','inherit']), reason: z.string().trim().min(4).max(500),
  preview: z.boolean().default(false), previewHash: z.string().length(64).optional(), accepted: z.boolean().optional() }).strict();

export async function payoutModeCommand(database, actor, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw unprocessable({ mode: 'Choose Auto, Manual or owner inheritance, and give a reason.' });
  const value = parsed.data;
  return database.begin(async tx => {
    await authorize(tx, actor, true);
    await lockPayoutPolicy(tx);
    let ownerId = null;
    if (value.ownerEmail) {
      const [owner] = await tx`SELECT id FROM "user" WHERE lower(email)=${value.ownerEmail} AND role='client'`;
      if (!owner) throw unprocessable({ ownerEmail: 'Choose an existing owner.' });
      ownerId = owner.id;
    }
    if (!ownerId && value.mode === 'inherit') throw unprocessable({ mode: 'The global setting must be Auto or Manual.' });
    const current = await resolvePayoutMode(tx, ownerId);
    const proposed = value.mode === 'inherit' ? current.globalMode : value.mode;
    const summary = { actorId: actor.id, ownerId, ownerEmail: value.ownerEmail, current, mode: value.mode, proposed, reason: value.reason };
    const previewHash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
    if (value.preview) return { preview: true, previewHash, ...summary, gate: PAYOUT_GATE };
    if (value.previewHash !== previewHash) throw conflict('STALE_PREVIEW', 'Payout settings changed or this confirmation was already used. Reload and review again.');
    if (!value.accepted) throw unprocessable({ accepted: 'Confirm the reviewed change.' });
    const [saved] = await tx`INSERT INTO payout_mode_setting(owner_id,mode,reason,created_by)
      VALUES (${ownerId},${value.mode === 'inherit' ? null : value.mode},${value.reason},${actor.id}) RETURNING id,version`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
      VALUES ('admin',${actor.id},'payout_mode',${ownerId ?? 'global'},'payout_mode_changed',${JSON.stringify(current)}::text::jsonb,
        ${JSON.stringify({ ...summary, settingId: saved.id, version: saved.version })}::text::jsonb,${value.reason})`;
    return { ok: true, effective: await resolvePayoutMode(tx, ownerId) };
  });
}
