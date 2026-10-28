import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { authorize } from './payout-modes.js';

// Story 2.19 (Test only): repayment notice receipt. received_at is the earliest recorded evidence:
// owner portal view, owner acknowledge, or an admin-confirmed receipt time. Links are never receipt.
// reminder_at = +5 days (portal only, no SMS/email), due_at = +7 days. Nothing blocks bookings here.
const uuid = z.string().uuid();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const OWNER_TYPES = ['portal_view', 'owner_ack'];

/** Columns a caller selects (prefix `n` = owner_repayment_notice) to build noticeView. */
export const noticeView = (n) =>
  n?.notice_id
    ? {
        id: n.notice_id, issuedAt: n.notice_issued_at, receivedAt: n.notice_received_at ?? null,
        receivedVia: n.notice_received_via ?? null, reminderAt: n.notice_reminder_at ?? null,
        dueAt: n.notice_due_at ?? null, acknowledged: Boolean(n.notice_acknowledged),
        reminderDue: Boolean(n.notice_reminder_due), version: n.notice_version,
      }
    : null;

const readNotice = async (tx, id) =>
  noticeView((await tx`SELECT n.id notice_id,n.issued_at notice_issued_at,n.received_at notice_received_at,
    n.received_via notice_received_via,n.reminder_at notice_reminder_at,n.due_at notice_due_at,n.version notice_version,
    (n.reminder_at IS NOT NULL AND now()>=n.reminder_at) notice_reminder_due,
    EXISTS(SELECT 1 FROM owner_repayment_notice_event e WHERE e.notice_id=n.id AND e.type='owner_ack') notice_acknowledged
    FROM owner_repayment_notice n WHERE n.id=${id}`)[0]);

/** First link of a recovery issues its notice. Caller holds the owner_recovery lock. */
export const issueNotice = (tx, recoveryId, ownerId) =>
  tx`INSERT INTO owner_repayment_notice(recovery_id,owner_id) VALUES (${recoveryId},${ownerId}) ON CONFLICT (recovery_id) DO NOTHING`;

/**
 * Appends the event, then moves milestones only when the event is earlier than the current receipt.
 * Compared in SQL against the stored occurred_at so microseconds are never lost.
 */
async function applyEvidence(tx, notice, eventId, actor) {
  const [saved] = await tx`UPDATE owner_repayment_notice n SET received_at=e.occurred_at,received_via=e.type,
      reminder_at=e.occurred_at+interval '5 days',due_at=e.occurred_at+interval '7 days',version=n.version+1,updated_at=now()
    FROM owner_repayment_notice_event e WHERE e.id=${eventId} AND n.id=${notice.id}
      AND (n.received_at IS NULL OR e.occurred_at<n.received_at) RETURNING n.*`;
  if (!saved) return;
  const snap = (r) => ({ receivedAt: r.received_at, receivedVia: r.received_via, reminderAt: r.reminder_at, dueAt: r.due_at, version: r.version });
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
    VALUES (${actor.type},${actor.id},'owner_repayment_notice',${notice.id},'owner_repayment_notice_received',
      ${JSON.stringify(snap(notice))}::text::jsonb,${JSON.stringify(snap(saved))}::text::jsonb,${actor.reason})`;
}

/** Returns the replayed notice, throws on a changed payload, or null when the key is new. */
async function replay(tx, notice, kind, actorId, requestKey, requestHash) {
  const [event] = await tx`SELECT request_hash FROM owner_repayment_notice_event
    WHERE notice_id=${notice.id} AND actor_kind=${kind} AND actor_id=${actorId} AND request_key=${requestKey}`;
  if (!event) return null;
  if (event.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'This request key was used for a different request.');
  return { ...(await readNotice(tx, notice.id)), replayed: true };
}

const ownerSchema = z.object({ requestKey: uuid }).strict();

/** Owner POST view/ack on their own notice. Another owner's notice is 404. */
// A same-key race that slips past the row lock hits the unique key; rerun once to replay it.
const once = async (run) => {
  try {
    return await run();
  } catch (error) {
    if (error.code !== '23505') throw error;
    return run();
  }
};

export function recordOwnerNoticeEvent(...args) {
  return once(() => ownerEvent(...args));
}
async function ownerEvent(database, ownerId, recoveryId, type, input, ctx = {}) {
  if (!uuid.safeParse(recoveryId).success || !OWNER_TYPES.includes(type)) throw notFound();
  const parsed = ownerSchema.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable({ requestKey: 'Reload and try again.' });
  const { requestKey } = parsed.data, requestHash = digest({ recoveryId, type });
  return database.begin(async (tx) => {
    // Lock order everywhere: owner "user" row, then owner_recovery, then the notice (Story 2.20).
    await tx`SELECT 1 FROM "user" WHERE id=${ownerId} FOR UPDATE`;
    await tx`SELECT 1 FROM owner_recovery WHERE id=${recoveryId} AND owner_id=${ownerId} FOR UPDATE`;
    const [notice] = await tx`SELECT * FROM owner_repayment_notice WHERE recovery_id=${recoveryId} AND owner_id=${ownerId} FOR UPDATE`;
    if (!notice) throw notFound();
    const replayed = await replay(tx, notice, 'owner', ownerId, requestKey, requestHash);
    if (replayed) return replayed;
    const evidence = { sessionId: ctx.sessionId ?? null, userAgent: String(ctx.userAgent ?? '').slice(0, 500) || null };
    const [event] = await tx`INSERT INTO owner_repayment_notice_event(notice_id,type,occurred_at,actor_kind,actor_id,evidence,request_key,request_hash)
      VALUES (${notice.id},${type},now(),'owner',${ownerId},${JSON.stringify(evidence)}::text::jsonb,${requestKey},${requestHash}) RETURNING id`;
    await applyEvidence(tx, notice, event.id, { type: 'client', id: ownerId, reason: type === 'owner_ack' ? 'Owner acknowledged notice' : 'Owner viewed notice' });
    return readNotice(tx, notice.id);
  });
}

const confirmSchema = z.object({ receivedAt: z.string().datetime({ offset: true }), reason: z.string().trim().min(10).max(500),
  expectedVersion: z.number().int().min(1), requestKey: uuid }).strict();

/** Admin confirms actual receipt at a stated time (finance write). */
export function confirmNoticeReceipt(...args) {
  return once(() => adminConfirm(...args));
}
async function adminConfirm(database, actor, sourceId, input) {
  if (!uuid.safeParse(sourceId).success) throw notFound();
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ receivedAt: 'Give the receipt time and a reason of 10-500 characters.' });
  const value = parsed.data, requestHash = digest({ sourceId, ...value });
  return database.begin(async (tx) => {
    await authorize(tx, actor, true);
    await tx`SELECT 1 FROM "user" WHERE id=(SELECT owner_id FROM owner_recovery WHERE source_id=${sourceId}) FOR UPDATE`;
    await tx`SELECT 1 FROM owner_recovery WHERE source_id=${sourceId} FOR UPDATE`;
    const [notice] = await tx`SELECT n.* FROM owner_repayment_notice n JOIN owner_recovery o ON o.id=n.recovery_id
      WHERE o.source_id=${sourceId} FOR UPDATE OF n`;
    if (!notice) throw notFound();
    const replayed = await replay(tx, notice, 'admin', actor.id, value.requestKey, requestHash);
    if (replayed) return replayed;
    if (notice.version !== value.expectedVersion) throw conflict('NOTICE_CHANGED', 'The notice changed. Reload and try again.');
    // issued_at is the first link's creation (same transaction).
    const [ok] = await tx`SELECT ${value.receivedAt}::timestamptz BETWEEN issued_at AND now() ok FROM owner_repayment_notice WHERE id=${notice.id}`;
    if (!ok.ok) throw unprocessable({ receivedAt: 'Receipt time must be after the notice was issued and not in the future.' });
    const [event] = await tx`INSERT INTO owner_repayment_notice_event(notice_id,type,occurred_at,actor_kind,actor_id,evidence,request_key,request_hash)
      VALUES (${notice.id},'admin_confirmed',${value.receivedAt},'admin',${actor.id},${JSON.stringify({ reason: value.reason })}::text::jsonb,
        ${value.requestKey},${requestHash}) RETURNING id`;
    await applyEvidence(tx, notice, event.id, { type: 'admin', id: actor.id, reason: value.reason });
    return readNotice(tx, notice.id);
  });
}
