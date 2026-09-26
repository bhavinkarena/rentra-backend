import 'server-only';

import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { revalidateListing } from '@/services/cache/listing-cache.js';
import { slugify } from '../domain/listing-url.js';

/**
 * Admin visibility restriction and documented corrections (CP08).
 *
 * Policy (recorded decision):
 * - Hide sets status 'hidden' and keeps the previous status in prior_status.
 *   It stops discovery, quotes and new confirmations at once (they all require
 *   'live'); confirmed visits stay confirmed and their records, arrival details
 *   and accepted snapshots stay available to the customer, the owner and admin.
 * - The owner cannot pause, resume or submit a hidden property. Owner trust
 *   edits while hidden change what restore returns to (pending_review), so a
 *   restore never publishes unreviewed trust content.
 * - Restore returns to prior_status; every other rule (account state,
 *   publication checks) is re-applied by the state it returns to.
 * - Every command carries the lifecycle_version (hide/restore) or
 *   content_version (correction) it was prepared against; stale commands get 409.
 * - Nothing here deletes: history is kept in audit_log and the FK rules.
 */

const uuid = z.string().uuid();
const HIDEABLE = ['live', 'paused', 'pending_review', 'pending_verification', 'draft', 'rejected'];
const CORRECTABLE = ['live', 'paused', 'hidden'];
const UPCOMING = ['confirmed', 'handed_over'];

const fields = (error) =>
  Object.fromEntries(error.issues.map((issue) => [issue.path[0] ?? '_', issue.message]));
const reason = z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(2000);
const lifecycleInput = z.object({ expectedVersion: z.coerce.number().int().min(1), reason });
const optionalText = (schema) => z.union([z.literal(''), schema]).optional();
const correctionInput = z.object({
  expectedContentVersion: z.coerce.number().int().min(1),
  reason,
  title: optionalText(z.string().trim().min(8, 'At least 8 characters').max(90)),
  description: optionalText(z.string().trim().min(40, 'At least 40 characters').max(4000)),
  highlight: z.string().trim().max(60).optional(),
  rulesNotes: z.string().trim().max(1000).optional(),
});

async function lockProperty(tx, id) {
  if (!uuid.safeParse(id).success) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  const [row] = await tx`SELECT * FROM rentable WHERE id=${id} FOR UPDATE`;
  if (!row) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  return row;
}

async function audit(tx, { adminId, id, action, before, after, reason: why, ip }) {
  await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, before, after, reason, ip)
    VALUES ('admin', ${adminId}, 'rentable', ${id}, ${action}, ${JSON.stringify(before)}::text::jsonb,
      ${JSON.stringify(after)}::text::jsonb, ${why}, ${ip})`;
}

/** Legacy hidden rows have no prior status: hand them back to the owner, not to the public. */
const restoreTarget = (row) => row.prior_status ?? (row.published_at || row.verified_at ? 'paused' : 'draft');

async function impact(database, id) {
  const visits = await database`SELECT reference, local_day, day, slot, state, starts_at FROM booking
    WHERE rentable_id=${id} AND state IN ${database(UPCOMING)} AND ends_at > now()
    ORDER BY starts_at LIMIT 10`;
  const [{ upcoming, holds }] = await database`SELECT
      (SELECT count(*)::int FROM booking WHERE rentable_id=${id} AND state IN ${database(UPCOMING)} AND ends_at > now()) AS upcoming,
      (SELECT count(*)::int FROM booking_order WHERE rentable_id=${id} AND state='held' AND hold_expires_at > now()) AS holds`;
  return {
    upcomingVisits: upcoming,
    activeHolds: holds,
    visits: visits.map((v) => ({
      reference: v.reference,
      day: String((v.local_day ?? v.day) instanceof Date ? (v.local_day ?? v.day).toISOString() : (v.local_day ?? v.day)).slice(0, 10),
      slot: v.slot,
      state: v.state,
    })),
  };
}

/** Everything the admin needs to decide, with the version to send back. */
export async function lifecycleState(database, id) {
  const [row] = await database`SELECT r.*, u.account_status, a.email AS restricted_by_email
    FROM rentable r JOIN "user" u ON u.id=r.client_id LEFT JOIN admin_user a ON a.id=r.restricted_by
    WHERE r.id=${id}`;
  if (!row) return null;
  const effects = await impact(database, id);
  const ownerActive = row.account_status === 'active';
  const hidden = row.status === 'hidden';
  const target = hidden ? restoreTarget(row) : null;
  return {
    version: row.lifecycle_version,
    contentVersion: row.content_version,
    status: row.status,
    priorStatus: row.prior_status,
    publiclyVisible: row.status === 'live' && ownerActive,
    restriction: hidden
      ? { at: row.restricted_at, by: row.restricted_by_email, reason: row.restriction_reason }
      : null,
    ...effects,
    hide: {
      allowed: HIDEABLE.includes(row.status),
      blockedReason: hidden ? 'Already hidden.' : HIDEABLE.includes(row.status) ? null : 'Not available for this status.',
      consequences: [
        row.status === 'live'
          ? 'Leaves search and the public page at once; new quotes and checkouts are refused.'
          : 'Stays out of search; the owner cannot resume, submit or publish it while hidden.',
        `${effects.upcomingVisits} confirmed upcoming visit(s) stay confirmed; customers keep their booking record and arrival details.`,
        `${effects.activeHolds} checkout hold(s) in progress will not confirm; a payment captured after the restriction is refunded.`,
        'The owner sees the reason in their workspace and cannot undo the restriction.',
      ],
    },
    restore: {
      allowed: hidden,
      target,
      blockedReason: hidden ? null : 'Only a hidden property can be restored.',
      consequences: hidden
        ? [
            target === 'live'
              ? ownerActive
                ? 'Returns to search and the public page.'
                : 'Returns to live, but stays out of search until the client account is reinstated.'
              : `Returns to ${target.replaceAll('_', ' ')}${target === 'pending_review' ? '; the owner changed trust content and must resubmit.' : '.'}`,
            'The restriction reason stays in the activity history.',
          ]
        : [],
    },
    correction: {
      allowed: CORRECTABLE.includes(row.status),
      blockedReason: CORRECTABLE.includes(row.status)
        ? null
        : 'Correct a property in review through the review decision instead.',
      current: {
        title: row.title,
        description: row.description ?? '',
        highlight: row.highlight ?? '',
        rulesNotes: row.house_rules?.notes ?? '',
      },
    },
  };
}

export async function hideProperty(database, { adminId, id, input, ip = null }) {
  const parsed = lifecycleInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  const result = await database.begin(async (tx) => {
    const row = await lockProperty(tx, id);
    if (row.lifecycle_version !== d.expectedVersion)
      throw conflict('LISTING_CHANGED', 'This property changed after you opened it. Reload and check again.');
    if (!HIDEABLE.includes(row.status))
      throw conflict('ALREADY_HIDDEN', 'This property is already hidden.');
    const effects = await impact(tx, id);
    await tx`UPDATE rentable SET status='hidden', prior_status=${row.status}, restricted_at=now(),
      restricted_by=${adminId}, restriction_reason=${d.reason}, updated_at=now() WHERE id=${id}`;
    await audit(tx, {
      adminId,
      id,
      action: 'listing_hidden',
      before: { status: row.status },
      after: { status: 'hidden', upcomingVisits: effects.upcomingVisits, activeHolds: effects.activeHolds },
      reason: d.reason,
      ip,
    });
    return row;
  });
  revalidateListing({ id, slug: result.slug, publicCode: result.public_code }, { statusChanged: true });
  return { id, status: 'hidden', priorStatus: result.status };
}

export async function restoreProperty(database, { adminId, id, input, ip = null }) {
  const parsed = lifecycleInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  const result = await database.begin(async (tx) => {
    const row = await lockProperty(tx, id);
    if (row.lifecycle_version !== d.expectedVersion)
      throw conflict('LISTING_CHANGED', 'This property changed after you opened it. Reload and check again.');
    if (row.status !== 'hidden') throw conflict('NOT_HIDDEN', 'Only a hidden property can be restored.');
    const target = restoreTarget(row);
    await tx`UPDATE rentable SET status=${target}, prior_status='hidden', restricted_at=NULL,
      restricted_by=NULL, restriction_reason=NULL, updated_at=now() WHERE id=${id}`;
    await audit(tx, {
      adminId,
      id,
      action: 'listing_restored',
      before: { status: 'hidden', restrictionReason: row.restriction_reason },
      after: { status: target },
      reason: d.reason,
      ip,
    });
    return { row, target };
  });
  revalidateListing(
    { id, slug: result.row.slug, publicCode: result.row.public_code },
    { statusChanged: true },
  );
  return { id, status: result.target };
}

/**
 * A documented admin edit of public text (moderation, typos). It keeps the
 * status: the admin is the reviewer. Trust facts (photos, address, capacity)
 * are not correctable here; they go back to the owner through review.
 */
export async function correctProperty(database, { adminId, id, input, ip = null }) {
  const parsed = correctionInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  const result = await database.begin(async (tx) => {
    const row = await lockProperty(tx, id);
    if (row.content_version !== d.expectedContentVersion)
      throw conflict('CONTENT_CHANGED', 'The property content changed after you opened it. Reload and compare.');
    if (!CORRECTABLE.includes(row.status))
      throw conflict('CORRECTION_NOT_ALLOWED', 'Correct a property in review through the review decision instead.');
    const rules = row.house_rules && !Array.isArray(row.house_rules) ? row.house_rules : {};
    const current = {
      title: row.title,
      description: row.description ?? '',
      highlight: row.highlight ?? '',
      rulesNotes: rules.notes ?? '',
    };
    const next = { ...current };
    for (const key of Object.keys(current)) if (d[key] !== undefined && d[key] !== '') next[key] = d[key];
    // Clearing optional text is a real correction too.
    for (const key of ['highlight', 'rulesNotes']) if (d[key] === '') next[key] = '';
    const changed = Object.keys(current).filter((key) => next[key] !== current[key]);
    if (!changed.length) throw unprocessable({ _: 'Nothing changed.' });
    if (changed.includes('rulesNotes') && Array.isArray(row.house_rules) && row.house_rules.length)
      throw unprocessable({ rulesNotes: 'These house rules use an older format. Ask the owner to re-save them.' });
    const slug = next.title !== current.title ? `${slugify(next.title)}-${row.public_code}` : row.slug;
    const houseRules = changed.includes('rulesNotes') ? { ...rules, notes: next.rulesNotes || null } : row.house_rules;
    const [updated] = await tx`UPDATE rentable SET title=${next.title}, slug=${slug}, description=${next.description},
        highlight=${next.highlight || null}, house_rules=${JSON.stringify(houseRules)}::text::jsonb, updated_at=now()
      WHERE id=${id} RETURNING content_version`;
    await audit(tx, {
      adminId,
      id,
      action: 'listing_corrected',
      before: Object.fromEntries(changed.map((key) => [key, current[key]])),
      after: Object.fromEntries(changed.map((key) => [key, next[key]])),
      reason: d.reason,
      ip,
    });
    return { row, slug, changed, contentVersion: updated.content_version };
  });
  revalidateListing(
    { id, slug: result.slug, publicCode: result.row.public_code },
    { previousSlug: result.row.slug },
  );
  return { id, changed: result.changed, contentVersion: result.contentVersion };
}

/** Every recorded lifecycle event for the property, newest first. */
export async function propertyActivity(database, id) {
  const rows = await database`SELECT l.id, l.actor_type, l.action, l.before, l.after, l.reason, l.at,
      coalesce(a.email, u.email) AS actor
    FROM audit_log l
    LEFT JOIN admin_user a ON l.actor_type='admin' AND a.id=l.actor_id
    LEFT JOIN "user" u ON l.actor_type<>'admin' AND u.id=l.actor_id
    WHERE l.entity='rentable' AND l.entity_id=${id}::text ORDER BY l.at DESC, l.id DESC LIMIT 100`;
  return rows.map((r) => ({
    id: r.id,
    actorType: r.actor_type,
    actor: r.actor,
    action: r.action,
    before: r.before,
    after: r.after,
    reason: r.reason,
    at: r.at,
  }));
}

/** What the owner is told: the restriction reason and the latest admin correction. */
export async function clientLifecycle(database, id) {
  const [row] = await database`SELECT status, restriction_reason, restricted_at FROM rentable WHERE id=${id}`;
  const [correction] = await database`SELECT after, reason, at FROM audit_log
    WHERE entity='rentable' AND entity_id=${id}::text AND action='listing_corrected' ORDER BY at DESC LIMIT 1`;
  return {
    restriction:
      row?.status === 'hidden' ? { reason: row.restriction_reason, at: row.restricted_at } : null,
    correction: correction
      ? { fields: Object.keys(correction.after ?? {}), reason: correction.reason, at: correction.at }
      : null,
  };
}
