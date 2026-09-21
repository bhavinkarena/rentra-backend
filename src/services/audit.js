import 'server-only';

import { db } from '@/services/db';
import { auditLog } from '@/services/db/schema/index.js';

/**
 * Write an audit row. Fire-and-forget by design: an audit failure must never
 * break the action it was recording.
 *
 * Worth writing before anything reads it — the first time a Client disputes a
 * suspension you will need to show what happened and when, and that cannot be
 * reconstructed after the fact.
 *
 * @param {object} e
 * @param {'client'|'customer'|'admin'|'system'} e.actorType
 * @param {string} [e.actorId]
 * @param {string} e.entity      e.g. 'user', 'rentable', 'booking'
 * @param {string} [e.entityId]
 * @param {string} e.action      e.g. 'login', 'otp_issued', 'account_approved'
 * @param {object} [e.before]
 * @param {object} [e.after]
 * @param {string} [e.reason]
 * @param {string} [e.ip]
 */
export async function audit(e) {
  try {
    await db.insert(auditLog).values({
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      entity: e.entity,
      entityId: e.entityId ? String(e.entityId) : null,
      action: e.action,
      before: e.before ?? null,
      after: e.after ?? null,
      reason: e.reason ?? null,
      ip: e.ip ?? null,
    });
  } catch (err) {
    console.error('[audit] failed to record %s on %s:', e.action, e.entity, err?.message);
  }
}
