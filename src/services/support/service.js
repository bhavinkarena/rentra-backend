import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { quoteDigest } from '../booking/quotes.js';
import { publicContent } from '../content/service.js';
import { preparePhotos } from '../booking/visit-evidence.js';
import { raiseAdminAlert } from '../admin/admin-alerts.js';
import { evidenceStore } from '../uploads/evidence-store.js';
import { decisionView, remedyCaps } from './remedy.js';
import { ISSUE_TYPES, REMEDIES, ISSUE_LABELS, issuePriority, isLateReport, discoveryProblem, issueEligibility } from '../domain/stay-issue.js';

import { SupportError } from './errors.js';
export { SupportError };
const uuid = z.string().uuid(),
  body = z.string().trim().min(2).max(5000);
const categories = ['booking', 'change', 'cancellation', 'payment', 'privacy', 'other', 'verification', 'account', 'property', 'calendar', 'earnings', 'stay_issue'];
const stayIssue = z
  .object({
    issueType: z.enum(ISSUE_TYPES),
    discoveredAt: z.string().datetime({ offset: true }),
    affected: z
      .array(z.object({ visitId: uuid, roomTypeId: z.string().trim().min(1).max(64).nullable().default(null) }).strict())
      .min(1)
      .max(50),
    remedy: z.enum(REMEDIES),
    remedyText: z.string().trim().max(500).nullable().default(null),
    lateReason: z.string().trim().max(500).nullable().default(null),
  })
  .strict()
  .refine((v) => v.remedy !== 'other' || v.remedyText?.length >= 1, { path: ['remedyText'], message: 'Describe the fix you want.' });
const states = ['open', 'in_progress', 'waiting_customer', 'resolved'];
const missing = () => new SupportError('NOT_FOUND', 'Support request not found.', 404);
// mode: false=read, true=write, 'note'=read or write (Story 4.3).
async function authorize(tx, actor, env, write = false) {
  if (actor?.kind === 'customer') return (await lockCustomerAccount(tx, actor.session, env)).id;
  if (actor?.kind === 'owner' && uuid.safeParse(actor.id).success) {
    const [client] =
      await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status IN ('active','pending_application') FOR SHARE`;
    if (client) return client.id;
  }
  if (actor?.kind === 'admin' && uuid.safeParse(actor.id).success) {
    const [staff] =
      await tx`SELECT id,permissions FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (
      staff &&
      (staff.permissions == null ||
        (write === 'note'
          ? ['admin.support.read', 'admin.support.write'].some((p) => staff.permissions.includes(p))
          : staff.permissions.includes(`admin.support.${write ? 'write' : 'read'}`)))
    )
      return staff.id;
  }
  throw missing();
}
const scope = (tx, actor, id) =>
  actor.kind === 'admin'
    ? tx`true`
    : actor.kind === 'owner'
      ? tx`client_id=${id}`
      : tx`customer_id=${id}`;
function replay(row, hash) {
  if (row.request_hash !== hash)
    throw new SupportError(
      'IDEMPOTENCY_CONFLICT',
      'This request key was already used for different content.',
    );
  return row;
}
async function owned(tx, actor, actorId, id, lock = false) {
  if (!uuid.safeParse(id).success) throw missing();
  const [row] =
    await tx`SELECT * FROM support_request WHERE id=${id} AND ${scope(tx, actor, actorId)} ${lock ? tx`FOR UPDATE` : tx``}`;
  if (!row) throw missing();
  return row;
}
const dto = (r, admin = false) => ({
  id: r.id,
  reference: r.reference,
  subject: r.subject,
  category: r.category,
  state: r.state,
  version: r.version,
  participant: r.client_id ? 'client' : 'customer',
  orderId: r.order_id,
  propertyId: r.property_id,
  privacyRequestId: r.privacy_request_id,
  context: r.context,
  policyVersion: r.policy_version,
  discoveredAt: r.discovered_at ? new Date(r.discovered_at).toISOString() : null,
  late: r.late ?? null,
  firstResponseAt: r.first_response_at ? new Date(r.first_response_at).toISOString() : null,
  ...(admin
    ? {
        alertFailed: Boolean(r.alert_failed),
        priority: r.priority,
        clientId: r.client_id,
        customerId: r.customer_id,
        assignedTo: r.assigned_to,
        relatedRequestId: r.related_request_id,
      }
    : {}),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
  unread: Boolean(r.unread),
});
async function audit(tx, actor, id, action, after) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES (${actor.kind === 'owner' ? 'client' : actor.kind},${actor.id || actor.session.userId},'support_request',${id},${action},${JSON.stringify(after)}::text::jsonb)`;
}
export async function createSupportRequest(database, actor, input, env = process.env, files = [], store = evidenceStore()) {
  const value = z
    .object({
      category: z.enum(categories),
      subject: z.string().trim().max(120).nullable().default(null),
      body,
      orderId: uuid.nullable(),
      privacyRequestId: uuid.nullable(),
      propertyId: uuid.nullable().default(null),
      visitId: uuid.nullable().default(null),
      stayIssue: stayIssue.nullable().default(null),
      requestKey: uuid,
    })
    .strict()
    .superRefine((v, ctx) => {
      const issue = v.category === 'stay_issue';
      if (issue && !v.stayIssue) ctx.addIssue({ code: 'custom', path: ['stayIssue'], message: 'Describe the problem.' });
      if (!issue && v.stayIssue) ctx.addIssue({ code: 'custom', path: ['category'], message: 'Choose a supported topic.' });
      if (issue ? v.body.length < 10 || v.body.length > 2000 : v.body.length < 20)
        ctx.addIssue({ code: 'custom', path: ['body'], message: issue ? 'Use 10 to 2000 characters.' : 'Use at least 20 characters.' });
      if (!issue && (v.subject?.length ?? 0) < 5) ctx.addIssue({ code: 'custom', path: ['subject'], message: 'Use 5 to 120 characters.' });
    })
    .parse(input);
  // A stay issue's subject is derived, so the guest only describes the problem once.
  if (value.stayIssue) value.subject = `Stay issue: ${ISSUE_LABELS[value.stayIssue.issueType]}`;
  await database.begin(async tx => authorize(tx, actor, env, true));
  let photos;
  try { photos = await preparePhotos(files); }
  catch (error) { if (error.code === 'INVALID_ATTACHMENT') throw new SupportError(error.code,error.message,422); throw error; }
  const hashValue = {...value};if(!hashValue.visitId)delete hashValue.visitId;if(!hashValue.stayIssue)delete hashValue.stayIssue;
  const hash = quoteDigest(photos.length ? { ...hashValue, photos: photos.map(p => p.sha256) } : hashValue);
  if (actor?.kind !== 'owner' && ['verification', 'account', 'property', 'calendar', 'earnings'].includes(value.category)) throw new SupportError('INVALID_TOPIC', 'Choose a supported topic.', 422);
  if (!['customer', 'owner'].includes(actor?.kind)) throw missing();
  if (value.category === 'stay_issue' && actor.kind !== 'customer') throw new SupportError('INVALID_TOPIC', 'Choose a supported topic.', 422);
  if (value.category === 'stay_issue' && (!value.orderId || value.visitId))
    throw new SupportError('CONTEXT_REQUIRED', 'Choose a supported record for this topic.', 422);
  if (
    (actor.kind === 'customer' && ['booking', 'change', 'cancellation', 'payment'].includes(value.category) && !value.orderId) ||
    (value.privacyRequestId &&
      (actor.kind !== 'customer' || value.category !== 'privacy' || value.orderId)) ||
    (value.propertyId && actor.kind !== 'owner') || (value.visitId && !value.orderId)
  )
    throw new SupportError('CONTEXT_REQUIRED', 'Choose a supported record for this topic.', 422);
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env, true);
    if (actor.kind === 'owner') {
      const [owner] = await tx`SELECT account_status FROM "user" WHERE id=${actorId}`;
      if (owner.account_status === 'pending_application' && (!['verification', 'account', 'other'].includes(value.category) || value.orderId || value.propertyId || value.privacyRequestId)) {
        throw new SupportError('INVALID_TOPIC', 'Choose Verification, Account or Other while your verification is in progress.', 422);
      }
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.kind + actorId},0))`;
    const [existing] =
      await tx`SELECT id,request_hash FROM support_request WHERE ${scope(tx, actor, actorId)} AND request_key=${value.requestKey}`;
    if (existing) return { id: replay(existing, hash).id };
    if (photos.length && !store.configured()) throw new SupportError('UPLOADS_UNAVAILABLE','Photo storage is unavailable. Your request has not been saved.',503);
    const context = {};
    if (value.orderId) {
      const [order] =
        await tx`SELECT o.* FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=${value.orderId} AND ${actor.kind === 'owner' ? tx`r.client_id=${actorId}` : tx`o.customer_id=${actorId}`}`;
      if (!order || (value.propertyId && order.rentable_id !== value.propertyId)) throw missing();
      Object.assign(context, {
        reference: order.reference,
        title: order.listing_snapshot?.title || 'Booked property',
        timeZone: order.time_zone,
        bookingPolicyVersion: order.policy_version,
        cancellationTier: order.policy_snapshot?.cancellationTier || null,
      });
    }
    let issue = null;
    if (value.stayIssue) issue = await stayIssueContext(tx, value.orderId, value.stayIssue);
    if (issue) Object.assign(context, { stayIssue: issue.context });
    if (value.visitId) {
      const [visit]=await tx`SELECT reference,local_day::text visit_date,slot FROM booking WHERE id=${value.visitId} AND order_id=${value.orderId}`;
      if(!visit)throw missing();Object.assign(context,{visitReference:visit.reference,visitDate:visit.visit_date,slot:visit.slot});
    }
    if (value.propertyId) {
      const [property] =
        await tx`SELECT title FROM rentable WHERE id=${value.propertyId} AND client_id=${actorId}`;
      if (!property) throw missing();
      context.propertyTitle = property.title;
    }
    if (value.privacyRequestId) {
      const [p] =
        await tx`SELECT kind FROM customer_privacy_request WHERE id=${value.privacyRequestId} AND customer_id=${actorId}`;
      if (!p) throw missing();
      context.privacyKind = p.kind;
    }
    const [{ count }] =
      await tx`SELECT count(*)::int count FROM support_request WHERE ${scope(tx, actor, actorId)} AND created_at>clock_timestamp()-interval '1 day'`;
    if (count >= 5) throw new SupportError('RATE_LIMIT', 'Please try again tomorrow.', 429);
    const termsVersion = (await publicContent(tx,'terms')).version;
    const id = randomUUID(),
      reference = 'SUP-' + id.replaceAll('-', '').slice(0, 16).toUpperCase();
    await tx`INSERT INTO support_request(id,reference,customer_id,client_id,property_id,order_id,privacy_request_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
      VALUES(${id},${reference},${actor.kind === 'customer' ? actorId : null},${actor.kind === 'owner' ? actorId : null},${value.propertyId},${value.orderId},${value.privacyRequestId},${value.category},${value.subject},${JSON.stringify(context)}::text::jsonb,${termsVersion},${value.requestKey},${hash},
        ${issue ? issuePriority(value.stayIssue.issueType) : 'normal'},${issue ? value.stayIssue.discoveredAt : null},${issue ? issue.late : null})`;
    const [message] = await tx`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash) VALUES(${id},${actor.kind},${actorId},${value.body},'open',${value.requestKey},${hash}) RETURNING id`;
    for (const photo of photos) {
      const saved = await store.put({folder: `rentra/support/${id}/${value.requestKey}`,name:photo.sha256,buffer:photo.buffer,mime:photo.mime});
      await tx`INSERT INTO support_attachment(message_id,storage_key,mime_type,bytes,sha256) VALUES(${message.id},${saved.key},${photo.mime},${photo.bytes},${photo.sha256})`;
    }
    // Story 4.2: urgent cases alert every support admin in the same transaction; replays return above.
    if (issue && issuePriority(value.stayIssue.issueType) === 'urgent')
      await raiseAdminAlert(tx, {
        kind: 'support_urgent',
        eventKey: `support_urgent:${id}`,
        supportRequestId: id,
        detail: { reference, subject: value.subject, issueType: value.stayIssue.issueType },
      });
    if (issue)
      await audit(tx, actor, id, 'stay_issue_reported', {
        orderId: value.orderId, issueType: value.stayIssue.issueType, priority: issuePriority(value.stayIssue.issueType),
        late: issue.late, remedy: value.stayIssue.remedy, photos: photos.length,
      });
    return { id };
  });
}

const issueError = (code, message, status = 422) => new SupportError(code, message, status);
/**
 * Story 4.1: validates a stay issue against the guest's own order (already scoped by the caller) and
 * returns the context snapshot. Reads only — filing never changes the order, bookings or money.
 */
async function stayIssueContext(tx, orderId, issue, now = new Date()) {
  const [order] = await tx`SELECT state FROM booking_order WHERE id=${orderId}`;
  const visits = await tx`SELECT id,reference,local_day::text AS day,starts_at,ends_at,state,cancelled_at,slot_snapshot FROM booking WHERE order_id=${orderId} ORDER BY item_position`;
  const eligibility = issueEligibility(order.state, visits.map((v) => ({ ...v, startsAt: v.starts_at, endsAt: v.ends_at, cancelledAt: v.cancelled_at })), now);
  const stayed = eligibility.visits;
  if (!eligibility.open)
    throw issueError('ISSUE_WINDOW_CLOSED', 'Problems can be reported from confirmation until 30 days after checkout.', 409);
  const problem = discoveryProblem(issue.discoveredAt, eligibility.firstStart, now);
  if (problem) throw issueError('DISCOVERY_INVALID', problem === 'future' ? 'The discovery time cannot be in the future.' : 'Choose when you noticed it: not in the future and not before your stay.');
  const affected = [];
  const seen = new Set();
  for (const item of issue.affected) {
    const visit = stayed.find((v) => v.id === item.visitId);
    const room = item.roomTypeId ? (visit?.slot_snapshot?.rooms || []).find((r) => String(r.roomTypeId) === item.roomTypeId) : null;
    if (!visit || (item.roomTypeId && !room) || seen.has(item.visitId + ':' + item.roomTypeId))
      throw issueError('AFFECTED_INVALID', 'Choose visits and rooms from this booking.');
    seen.add(item.visitId + ':' + item.roomTypeId);
    affected.push({ visitId: visit.id, visitReference: visit.reference, date: visit.day, roomTypeId: item.roomTypeId, roomName: room?.name || null });
  }
  const late = isLateReport(issue.discoveredAt, now);
  if (late && (issue.lateReason?.length ?? 0) < 10)
    throw issueError('LATE_REASON_REQUIRED', 'Tell us why this is being reported more than 72 hours after you found it (10 to 500 characters).');
  return {
    late,
    context: {
      issueType: issue.issueType,
      discoveredAt: new Date(issue.discoveredAt).toISOString(),
      affected,
      remedy: issue.remedy,
      remedyText: issue.remedy === 'other' ? issue.remedyText : null,
      late,
      lateReason: late ? issue.lateReason : null,
    },
  };
}

export async function replySupportRequest(
  database,
  actor,
  input,
  env = process.env,
  files = [],
  store = evidenceStore(),
) {
  const value = z
    .object({
      id: uuid,
      body,
      state: z.enum(states),
      version: z.number().int().nonnegative(),
      requestKey: uuid,
    })
    .strict()
    .parse(input);
  if (actor.kind !== 'admin' && !['open', 'resolved'].includes(value.state))
    throw new SupportError('INVALID_STATE', 'Only support staff can set this status.', 403);
  return postMessage(database, actor, value, false, env, files, store);
}

/** Story 4.3: private admin note. Needs only support read; never changes case state, version or timestamps. */
export async function addSupportNote(
  database,
  actor,
  input,
  env = process.env,
  files = [],
  store = evidenceStore(),
) {
  if (actor?.kind !== 'admin') throw missing();
  const value = z.object({ id: uuid, body, requestKey: uuid }).strict().parse(input);
  return postMessage(database, actor, value, true, env, files, store);
}

async function postMessage(database, actor, value, internal, env, files, store) {
  // Authorize before storage; recheck under the case lock before persisting.
  await database.begin(async (tx) =>
    owned(tx, actor, await authorize(tx, actor, env, internal ? 'note' : true), value.id),
  );
  let photos;
  try {
    photos = await preparePhotos(files);
  } catch (error) {
    if (error.code === 'INVALID_ATTACHMENT') throw new SupportError(error.code, error.message, 422);
    throw error;
  }
  const hash = quoteDigest({ ...value, internal, photos: photos.map((p) => p.sha256) });
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env, internal ? 'note' : true);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.kind + actorId + value.requestKey},0))`;
    const request = await owned(tx, actor, actorId, value.id, true);
    const [existing] =
      await tx`SELECT request_id,request_hash FROM support_message WHERE actor_kind=${actor.kind} AND actor_id=${actorId} AND request_key=${value.requestKey}`;
    if (existing) {
      replay(existing, hash);
      return { id: existing.request_id };
    }
    if (photos.length && !store.configured())
      throw new SupportError(
        'UPLOADS_UNAVAILABLE',
        'Photo storage is unavailable. Your message has not been saved.',
        503,
      );
    if (!internal && value.version !== request.version)
      throw new SupportError(
        'STALE_REQUEST',
        'This conversation changed. Reload and review the latest version before sending.',
      );
    const [{ count }] =
      await tx`SELECT count(*)::int count FROM support_message WHERE request_id=${request.id} AND created_at>clock_timestamp()-interval '1 hour'`;
    if (count >= 30)
      throw new SupportError('RATE_LIMIT', 'Too many replies. Please try again later.', 429);
    const [{ n }] =
      await tx`SELECT count(*)::int n FROM support_attachment a JOIN support_message m ON m.id=a.message_id WHERE m.request_id=${request.id}`;
    if (n + photos.length > 30)
      throw new SupportError('ATTACHMENT_LIMIT', 'This conversation can hold 30 photos.', 422);
    const state = internal ? request.state : value.state;
    const [message] =
      await tx`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash,internal) VALUES(${request.id},${actor.kind},${actorId},${value.body},${state},${value.requestKey},${hash},${internal}) RETURNING id`;
    for (const photo of photos) {
      const saved = await store.put({
        folder: `rentra/support/${request.id}/${value.requestKey}`,
        name: photo.sha256,
        buffer: photo.buffer,
        mime: photo.mime,
      });
      await tx`INSERT INTO support_attachment(message_id,storage_key,mime_type,bytes,sha256) VALUES(${message.id},${saved.key},${photo.mime},${photo.bytes},${photo.sha256})`;
    }
    // Notes leave support_request untouched (updated_at drives guest "new reply" cues).
    if (!internal) {
      // Story 4.2: only the first public admin reply counts as the first human response.
      const responded = actor.kind === 'admin';
      await tx`UPDATE support_request SET state=${state},version=version+1,
        first_response_at=${responded ? tx`coalesce(first_response_at, clock_timestamp())` : tx`first_response_at`},updated_at=clock_timestamp() WHERE id=${request.id}`;
    }
    if (actor.kind === 'admin')
      await audit(tx, actor, request.id, internal ? 'support_internal_note' : 'support_reply', {
        ...(internal ? {} : { state }),
        internal,
      });
    return { id: request.id };
  });
}

export async function manageSupportRequest(database, actor, input, env = process.env) {
  if (actor.kind !== 'admin') throw missing();
  const value = z
    .object({
      id: uuid,
      version: z.number().int().nonnegative(),
      assignedTo: uuid.nullable(),
      priority: z.enum(['normal', 'urgent']),
      relatedRequestId: uuid.nullable(),
      reason: z.string().trim().min(5).max(500),
    })
    .strict()
    .parse(input);
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env, true),
      row = await owned(tx, actor, actorId, value.id, true);
    if (row.version !== value.version)
      throw new SupportError('STALE_REQUEST', 'This case changed. Reload before assigning it.');
    if (value.assignedTo) {
      const [staff] =
        await tx`SELECT id FROM admin_user WHERE id=${value.assignedTo} AND is_active=true AND (permissions IS NULL OR permissions @> '["admin.support.read","admin.support.write"]'::jsonb) FOR SHARE`;
      if (!staff)
        throw new SupportError('INVALID_ASSIGNEE', 'Choose an active support operator.', 422);
    }
    if (value.relatedRequestId) {
      if (value.relatedRequestId === row.id)
        throw new SupportError('INVALID_LINK', 'Choose a different case.', 422);
      await owned(tx, actor, actorId, value.relatedRequestId);
    }
    await tx`UPDATE support_request SET assigned_to=${value.assignedTo},priority=${value.priority},related_request_id=${value.relatedRequestId},version=version+1,updated_at=clock_timestamp() WHERE id=${row.id}`;
    await audit(tx, actor, row.id, 'support_assignment', {
      assignedTo: value.assignedTo,
      previousAssignee: row.assigned_to,
      priority: value.priority,
      relatedRequestId: value.relatedRequestId,
      reason: value.reason,
    });
    return { id: row.id };
  });
}
export async function readSupportRequest(database, actor, id, env = process.env) {
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env),
      row = await owned(tx, actor, actorId, id),
      admin = actor.kind === 'admin';
    if (actor.kind === 'owner') await tx`UPDATE client_update SET read_at=coalesce(read_at,now()) WHERE client_id=${actorId} AND detail->>'supportId'=${row.id}::text AND read_at IS NULL`;
    const messages =
      await tx`SELECT id,actor_kind,body,state_after,created_at,internal FROM support_message WHERE request_id=${row.id} AND ${admin ? tx`true` : tx`NOT internal`} ORDER BY created_at,id`;
    const attachments =
      await tx`SELECT a.id,a.message_id,a.mime_type,a.bytes FROM support_attachment a JOIN support_message m ON m.id=a.message_id WHERE m.request_id=${row.id} AND ${admin ? tx`true` : tx`NOT m.internal`}`;
    let privacy = null;
    if (row.privacy_request_id) {
      const [p] =
        await tx`SELECT kind,state FROM customer_privacy_request WHERE id=${row.privacy_request_id} AND customer_id=${row.customer_id}`;
      privacy = p || null;
    }
    const operators = admin
      ? await tx`SELECT id,name FROM admin_user WHERE is_active=true AND (permissions IS NULL OR permissions @> '["admin.support.read","admin.support.write"]'::jsonb) ORDER BY name,id`
      : [];
    const alerts = admin
      ? await tx`SELECT a.id, a.kind, a.email_state, a.email_failure, a.created_at, u.name admin_name
          FROM admin_alert a JOIN admin_user u ON u.id=a.admin_id WHERE a.support_request_id=${row.id} ORDER BY a.created_at, u.name`
      : [];
    const [staff] = admin
      ? await tx`SELECT permissions FROM admin_user WHERE id=${actorId} AND is_active=true`
      : [];
    // Story 4.4: the active reviewed remedy decision; controls only with payments access.
    const [decision] = admin && row.category === 'stay_issue'
      ? await tx`SELECT * FROM incident_remedy_decision WHERE support_request_id=${row.id} AND superseded_at IS NULL`
      : [];
    const caps = remedyCaps(staff);
    const history = admin
      ? await tx`SELECT action,at,"after" FROM audit_log WHERE entity='support_request' AND entity_id=${row.id} ORDER BY at,id`
      : [];
    return {
      ...dto(row, admin),
      privacy,
      ...(admin
        ? {
            operators,
            history,
            remedy: row.category === 'stay_issue' && row.order_id
              ? { decision: decision ? decisionView(decision) : null, canPreview: caps.canPreview, canDecide: caps.canDecide }
              : null,
            canReply:
              !!staff &&
              (staff.permissions == null ||
                (Array.isArray(staff.permissions) &&
                  staff.permissions.includes('admin.support.write'))),
            alerts: alerts.map((a) => ({
              id: a.id,
              kind: a.kind,
              admin: a.admin_name,
              emailState: a.email_state,
              emailFailure: a.email_failure,
              at: new Date(a.created_at).toISOString(),
            })),
          }
        : {}),
      messages: messages.map((m) => ({
        id: m.id,
        author:
          m.actor_kind === 'admin'
            ? 'Rentra support'
            : m.actor_kind === 'owner'
              ? 'Owner'
              : 'Customer',
        body: m.body,
        state: m.state_after,
        internal: m.internal,
        at: new Date(m.created_at).toISOString(),
        attachments: attachments
          .filter((a) => a.message_id === m.id)
          .map((a) => ({ id: a.id, mimeType: a.mime_type, bytes: a.bytes })),
      })),
    };
  });
}
export async function listSupportRequests(database, actor, input = {}, env = process.env) {
  const state = (states.includes(input.state) || (actor.kind==='admin' && input.state==='unresolved')) ? input.state : 'all',
    page = Math.min(
      100000,
      Math.max(1, Number.isSafeInteger(Number(input.page)) ? Number(input.page) : 1),
    );
  const participant = ['client', 'customer'].includes(input.participant)
      ? input.participant
      : 'all',
    assignment = ['mine', 'unassigned'].includes(input.assignment) ? input.assignment : 'all',
    view =
      actor.kind === 'admin' && ['urgent', 'aged', 'unassigned', 'failed_delivery'].includes(input.view)
        ? input.view
        : 'all';
  // Story 4.2 views. Aged: not resolved and no first public reply for 12 elapsed hours.
  const aged = (tx) => tx`(state<>'resolved' AND first_response_at IS NULL AND created_at<=clock_timestamp()-interval '12 hours')`;
  const failed = (tx) =>
    tx`EXISTS(SELECT 1 FROM admin_alert a WHERE a.support_request_id=support_request.id AND a.email_state IN ('failed','blocked'))`;
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env);
    const condition = tx`${scope(tx, actor, actorId)} AND ${state === 'all' ? tx`true` : state === 'unresolved' ? tx`state<>'resolved'` : tx`state=${state}`} AND ${actor.kind !== 'admin' || participant === 'all' ? tx`true` : participant === 'client' ? tx`client_id IS NOT NULL` : tx`customer_id IS NOT NULL`} AND ${actor.kind !== 'admin' || assignment === 'all' ? tx`true` : assignment === 'mine' ? tx`assigned_to=${actorId}` : tx`assigned_to IS NULL`} AND ${
      view === 'urgent' ? tx`priority='urgent' AND state<>'resolved'` : view === 'aged' ? aged(tx) : view === 'unassigned' ? tx`assigned_to IS NULL AND state<>'resolved'` : view === 'failed_delivery' ? failed(tx) : tx`true`}`;
    const order =
      view === 'urgent' ? tx`${aged(tx)} DESC,` : view === 'aged' ? tx`priority='urgent' DESC,` : tx``;
    const [{ count }] =
      await tx`SELECT count(*)::int count FROM support_request WHERE ${condition}`;
    const rows =
      await tx`SELECT support_request.*, ${actor.kind === 'owner' ? tx`EXISTS(SELECT 1 FROM client_update u WHERE u.client_id=${actorId} AND u.read_at IS NULL AND u.detail->>'supportId'=support_request.id::text)` : tx`false`} unread, ${actor.kind === 'admin' ? failed(tx) : tx`false`} alert_failed FROM support_request WHERE ${condition} ORDER BY ${order} updated_at DESC,id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
    return {
      items: rows.map((r) => dto(r, actor.kind === 'admin')),
      total: count,
      page,
      state,
      participant,
      assignment,
      view,
      hasNext: count > page * 20,
    };
  });
}
export async function supportAttachment(
  database,
  actor,
  id,
  attachmentId,
  env = process.env,
  store = evidenceStore(),
) {
  if (!uuid.safeParse(attachmentId).success) throw missing();
  const file = await database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env);
    await owned(tx, actor, actorId, id);
    const [row] =
      await tx`SELECT a.* FROM support_attachment a JOIN support_message m ON m.id=a.message_id WHERE a.id=${attachmentId} AND m.request_id=${id} AND ${actor.kind === 'admin' ? tx`true` : tx`NOT m.internal`}`;
    if (!row) throw missing();
    await audit(tx, actor, id, 'support_attachment_read', { attachmentId });
    return row;
  });
  const content = await store.get(file.storage_key);
  if (!content)
    throw new SupportError('ATTACHMENT_UNAVAILABLE', 'Attachment is temporarily unavailable.', 503);
  return { ...content, mimeType: file.mime_type, bytes: file.bytes };
}
