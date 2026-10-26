import { z } from 'zod';
import { conflict, unprocessable } from '@/utils/apiError.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';

/**
 * Story 2.2 (FR-12): the one guest-paid Rentra service fee.
 *
 * The rate in force for an owner is their latest owner-wide override that is
 * effective now, else the latest effective global rate, else the launch default.
 * There is deliberately no category or property scope. Settings are an
 * append-only history: a change is a new row, never an edit.
 */
export async function resolveServiceFee(database, ownerId, at = null) {
  const [row] = await database`SELECT id, owner_id, rate_bps FROM service_fee_setting
    WHERE (owner_id = ${ownerId ?? null}::uuid OR owner_id IS NULL)
      AND effective_at <= coalesce(${at}::timestamptz, now())
    ORDER BY (owner_id IS NULL), effective_at DESC LIMIT 1`;
  return row
    ? { bps: row.rate_bps, source: row.owner_id ? 'owner' : 'global', settingId: row.id }
    : { bps: BOOKING_POLICY.platformFeeBps, source: 'default', settingId: null };
}

const changeSchema = z.object({
  ownerId: z.union([z.literal(''), z.string().uuid()]).optional(),
  ownerEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email()]).optional(),
  ratePercent: z.coerce.number().min(0).max(30),
  effectiveAt: z.string().optional(),
  reason: z.string().trim().min(4).max(500),
  // The setting id the admin saw for this scope ('' when none): a stale form is refused.
  expectedSettingId: z.union([z.literal(''), z.string().uuid()]).optional(),
});

async function latestFor(tx, ownerId) {
  const [row] = await tx`SELECT * FROM service_fee_setting
    WHERE owner_id IS NOT DISTINCT FROM ${ownerId}::uuid ORDER BY effective_at DESC, created_at DESC LIMIT 1`;
  return row ?? null;
}

/**
 * Finance admins only: the route sits under /admin/payments, so it needs
 * admin.payments.write. Future effective times are allowed; backdating never is.
 */
export async function changeServiceFee(database, { adminId, input, ip = null }) {
  const parsed = changeSchema.safeParse(input ?? {});
  if (!parsed.success)
    throw unprocessable({ ratePercent: 'Enter a rate between 0% and 30%, and a reason.' });
  const d = parsed.data;
  let ownerId = d.ownerId || null;
  if (!ownerId && d.ownerEmail) {
    const [owner] = await database`SELECT id FROM "user" WHERE lower(email)=${d.ownerEmail} AND role='client'`;
    if (!owner) throw unprocessable({ ownerEmail: 'No owner has that email.' });
    ownerId = owner.id;
  }
  const rateBps = Math.round(d.ratePercent * 100);
  if (Math.abs(rateBps - d.ratePercent * 100) > 1e-6)
    throw unprocessable({ ratePercent: 'Use at most two decimal places.' });
  return database.begin(async (tx) => {
    // One change at a time per scope.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'service-fee:' + (ownerId ?? 'global')}))`;
    if (ownerId) {
      const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client'`;
      if (!owner) throw unprocessable({ ownerId: 'Choose an existing owner.' });
    }
    const [{ now }] = await tx`SELECT now()`;
    const effectiveAt = d.effectiveAt ? new Date(d.effectiveAt) : new Date(now);
    if (Number.isNaN(effectiveAt.getTime()))
      throw unprocessable({ effectiveAt: 'Choose a valid date and time.' });
    if (effectiveAt < new Date(now))
      throw unprocessable({ effectiveAt: 'A fee change cannot take effect in the past.' });
    const previous = await latestFor(tx, ownerId);
    if ((d.expectedSettingId || null) !== (previous?.id ?? null))
      throw conflict('FEE_SETTING_CHANGED', 'The service fee changed after you opened it. Reload.');
    const [row] = await tx`INSERT INTO service_fee_setting (owner_id, rate_bps, effective_at, reason, created_by)
      VALUES (${ownerId}, ${rateBps}, ${effectiveAt.toISOString()}, ${d.reason}, ${adminId}) RETURNING *`;
    await tx`INSERT INTO audit_log (actor_type, actor_id, entity, entity_id, action, before, after, reason, ip)
      VALUES ('admin', ${adminId}, 'service_fee', ${ownerId ?? 'global'}, 'service_fee_changed',
        ${JSON.stringify(previous ? { rateBps: previous.rate_bps, effectiveAt: previous.effective_at, settingId: previous.id } : null)}::text::jsonb,
        ${JSON.stringify({ rateBps, effectiveAt, settingId: row.id, ownerId })}::text::jsonb, ${d.reason}, ${ip})`;
    return { ok: true, settingId: row.id, rateBps, effectiveAt };
  });
}

/** Admin view: the global history and every owner override, newest first. */
export async function listServiceFees(database) {
  const rows = await database`SELECT s.id, s.owner_id, s.rate_bps, s.effective_at, s.reason, s.created_at,
      u.email AS owner_email, a.email AS created_by_email
    FROM service_fee_setting s LEFT JOIN "user" u ON u.id=s.owner_id LEFT JOIN admin_user a ON a.id=s.created_by
    ORDER BY (s.owner_id IS NOT NULL), u.email, s.effective_at DESC LIMIT 200`;
  const current = await resolveServiceFee(database, null);
  // The newest row per scope, so the admin form always sends the right expectedSettingId.
  const latest = await database`SELECT DISTINCT ON (coalesce(s.owner_id::text, 'global'))
      coalesce(u.email, 'global') AS scope, s.id
    FROM service_fee_setting s LEFT JOIN "user" u ON u.id=s.owner_id
    ORDER BY coalesce(s.owner_id::text, 'global'), s.effective_at DESC, s.created_at DESC`;
  return {
    globalBps: current.bps,
    latest: Object.fromEntries(latest.map((r) => [r.scope.toLowerCase(), r.id])),
    settings: rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      ownerEmail: r.owner_email,
      rateBps: r.rate_bps,
      effectiveAt: r.effective_at,
      reason: r.reason,
      createdBy: r.created_by_email,
      createdAt: r.created_at,
    })),
  };
}
