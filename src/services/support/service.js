import 'server-only';
import { AppError } from '../../utils/apiError.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { quoteDigest } from '../booking/quotes.js';
import { POLICY_VERSION } from '../domain/help.js';
import { preparePhotos } from '../booking/visit-evidence.js';
import { evidenceStore } from '../uploads/evidence-store.js';

export class SupportError extends AppError {
  constructor(code, message = code, statusCode = 409) {
    super(message, statusCode, { code });
  }
}
const uuid = z.string().uuid(),
  body = z.string().trim().min(2).max(5000);
const categories = ['booking', 'change', 'cancellation', 'payment', 'privacy', 'other'];
const states = ['open', 'in_progress', 'waiting_customer', 'resolved'];
const missing = () => new SupportError('NOT_FOUND', 'Support request not found.', 404);
async function authorize(tx, actor, env, write = false) {
  if (actor?.kind === 'customer') return (await lockCustomerAccount(tx, actor.session, env)).id;
  if (actor?.kind === 'owner' && uuid.safeParse(actor.id).success) {
    const [client] =
      await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR SHARE`;
    if (client) return client.id;
  }
  if (actor?.kind === 'admin' && uuid.safeParse(actor.id).success) {
    const [staff] =
      await tx`SELECT id,permissions FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (
      staff &&
      (staff.permissions == null ||
        staff.permissions.includes(`admin.support.${write ? 'write' : 'read'}`))
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
  ...(admin
    ? {
        clientId: r.client_id,
        customerId: r.customer_id,
        assignedTo: r.assigned_to,
        priority: r.priority,
        relatedRequestId: r.related_request_id,
      }
    : {}),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});
async function audit(tx, actor, id, action, after) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES (${actor.kind === 'owner' ? 'client' : actor.kind},${actor.id || actor.session.userId},'support_request',${id},${action},${JSON.stringify(after)}::text::jsonb)`;
}
export async function createSupportRequest(database, actor, input, env = process.env) {
  const value = z
    .object({
      category: z.enum(categories),
      subject: z.string().trim().min(5).max(120),
      body: body.min(20),
      orderId: uuid.nullable(),
      privacyRequestId: uuid.nullable(),
      propertyId: uuid.nullable().default(null),
      requestKey: uuid,
    })
    .strict()
    .parse(input);
  const hash = quoteDigest(value);
  if (!['customer', 'owner'].includes(actor?.kind)) throw missing();
  if (
    (['booking', 'change', 'cancellation', 'payment'].includes(value.category) && !value.orderId) ||
    (value.privacyRequestId &&
      (actor.kind !== 'customer' || value.category !== 'privacy' || value.orderId)) ||
    (value.propertyId && actor.kind !== 'owner')
  )
    throw new SupportError('CONTEXT_REQUIRED', 'Choose a supported record for this topic.', 422);
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env, true);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.kind + actorId},0))`;
    const [existing] =
      await tx`SELECT id,request_hash FROM support_request WHERE ${scope(tx, actor, actorId)} AND request_key=${value.requestKey}`;
    if (existing) return { id: replay(existing, hash).id };
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
    const id = randomUUID(),
      reference = 'SUP-' + id.replaceAll('-', '').slice(0, 16).toUpperCase();
    await tx`INSERT INTO support_request(id,reference,customer_id,client_id,property_id,order_id,privacy_request_id,category,subject,context,policy_version,request_key,request_hash)
      VALUES(${id},${reference},${actor.kind === 'customer' ? actorId : null},${actor.kind === 'owner' ? actorId : null},${value.propertyId},${value.orderId},${value.privacyRequestId},${value.category},${value.subject},${JSON.stringify(context)}::text::jsonb,${POLICY_VERSION},${value.requestKey},${hash})`;
    await tx`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash) VALUES(${id},${actor.kind},${actorId},${value.body},'open',${value.requestKey},${hash})`;
    return { id };
  });
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
      internal: z.boolean().default(false),
    })
    .strict()
    .parse(input);
  if (actor.kind !== 'admin' && (value.internal || !['open', 'resolved'].includes(value.state)))
    throw new SupportError(
      'INVALID_STATE',
      'Only support staff can set this visibility or status.',
      403,
    );
  // Authorize before storage; recheck under the case lock before persisting.
  await database.begin(async (tx) =>
    owned(tx, actor, await authorize(tx, actor, env, true), value.id),
  );
  let photos;
  try {
    photos = await preparePhotos(files);
  } catch (error) {
    if (error.code === 'INVALID_ATTACHMENT') throw new SupportError(error.code, error.message, 422);
    throw error;
  }
  const hash = quoteDigest({ ...value, photos: photos.map((p) => p.sha256) });
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env, true);
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

    if (value.version !== request.version)
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
    const state = value.internal ? request.state : value.state;
    const [message] =
      await tx`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash,internal) VALUES(${request.id},${actor.kind},${actorId},${value.body},${state},${value.requestKey},${hash},${value.internal}) RETURNING id`;
    for (const photo of photos) {
      const saved = await store.put({
        folder: `rentra/support/${request.id}/${value.requestKey}`,
        name: photo.sha256,
        buffer: photo.buffer,
        mime: photo.mime,
      });
      await tx`INSERT INTO support_attachment(message_id,storage_key,mime_type,bytes,sha256) VALUES(${message.id},${saved.key},${photo.mime},${photo.bytes},${photo.sha256})`;
    }
    await tx`UPDATE support_request SET state=${state},version=version+1,updated_at=clock_timestamp() WHERE id=${request.id}`;
    if (actor.kind === 'admin')
      await audit(
        tx,
        actor,
        request.id,
        value.internal ? 'support_internal_note' : 'support_reply',
        { state, internal: value.internal },
      );
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
    const history = admin
      ? await tx`SELECT action,at,"after" FROM audit_log WHERE entity='support_request' AND entity_id=${row.id} ORDER BY at,id`
      : [];
    return {
      ...dto(row, admin),
      privacy,
      ...(admin ? { operators, history } : {}),
      messages: messages.map((m) => ({
        id: m.id,
        author:
          m.actor_kind === 'admin'
            ? 'Rentra support'
            : m.actor_kind === 'owner'
              ? 'Client'
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
  const state = states.includes(input.state) ? input.state : 'all',
    page = Math.min(
      100000,
      Math.max(1, Number.isSafeInteger(Number(input.page)) ? Number(input.page) : 1),
    );
  const participant = ['client', 'customer'].includes(input.participant)
      ? input.participant
      : 'all',
    assignment = ['mine', 'unassigned'].includes(input.assignment) ? input.assignment : 'all';
  return database.begin(async (tx) => {
    const actorId = await authorize(tx, actor, env);
    const condition = tx`${scope(tx, actor, actorId)} AND ${state === 'all' ? tx`true` : tx`state=${state}`} AND ${actor.kind !== 'admin' || participant === 'all' ? tx`true` : participant === 'client' ? tx`client_id IS NOT NULL` : tx`customer_id IS NOT NULL`} AND ${actor.kind !== 'admin' || assignment === 'all' ? tx`true` : assignment === 'mine' ? tx`assigned_to=${actorId}` : tx`assigned_to IS NULL`}`;
    const [{ count }] =
      await tx`SELECT count(*)::int count FROM support_request WHERE ${condition}`;
    const rows =
      await tx`SELECT * FROM support_request WHERE ${condition} ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`;
    return {
      items: rows.map((r) => dto(r, actor.kind === 'admin')),
      total: count,
      page,
      state,
      participant,
      assignment,
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
