import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { quoteDigest } from '../booking/quotes.js';
import { POLICY_VERSION } from '../domain/help.js';

export class SupportError extends Error { constructor(code) { super(code); this.code = code; } }
const uuid = z.string().uuid(), body = z.string().trim().min(2).max(5000);
const categories = ['booking','change','cancellation','payment','privacy','other'];
const states = ['open','in_progress','waiting_customer','resolved'];
const createSchema = z.object({ category: z.enum(categories), subject: z.string().trim().min(5).max(120), body: body.min(20),
  orderId: uuid.nullable(), privacyRequestId: uuid.nullable(), requestKey: uuid }).strict();
async function authorize(tx, actor, env) {
  if (actor?.kind === 'customer') return (await lockCustomerAccount(tx, actor.session, env)).id;
  if (actor?.kind === 'admin' && uuid.safeParse(actor.id).success) {
    const [staff] = await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (staff) return staff.id;
  }
  throw new SupportError('NOT_FOUND');
}
function replay(row, hash) {
  if (row.request_hash !== hash) throw new SupportError('IDEMPOTENCY_CONFLICT');
  return row;
}
async function owned(tx, actor, actorId, id, lock = false) {
  uuid.parse(id);
  const rows = await tx`SELECT * FROM support_request WHERE id=${id} AND ${actor.kind === 'admin' ? tx`true` : tx`customer_id=${actorId}`}
    ${lock ? tx`FOR UPDATE` : tx``}`;
  if (!rows[0]) throw new SupportError('NOT_FOUND');
  return rows[0];
}
const dto = r => ({ id: r.id, reference: r.reference, subject: r.subject, category: r.category, state: r.state, version: r.version,
  orderId: r.order_id, privacyRequestId: r.privacy_request_id, context: r.context, policyVersion: r.policy_version,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() });

export async function createSupportRequest(database, actor, input, env = process.env) {
  const value = createSchema.parse(input), hash = quoteDigest(value);
  if (actor?.kind !== 'customer') throw new SupportError('CUSTOMER_REQUIRED');
  if ((['booking','change','cancellation','payment'].includes(value.category) && !value.orderId)
    || (value.privacyRequestId && (value.category !== 'privacy' || value.orderId))) throw new SupportError('CONTEXT_REQUIRED');
  return database.begin(async tx => {
    const customerId = await authorize(tx, actor, env);
    const [existing] = await tx`SELECT id,request_hash FROM support_request WHERE customer_id=${customerId} AND request_key=${value.requestKey}`;
    if (existing) return { id: replay(existing, hash).id };
    const context = {};
    if (value.orderId) {
      const [order] = await tx`SELECT reference,policy_version,policy_snapshot,time_zone,listing_snapshot FROM booking_order WHERE id=${value.orderId} AND customer_id=${customerId}`;
      if (!order) throw new SupportError('NOT_FOUND');
      Object.assign(context, { reference: order.reference, title: order.listing_snapshot?.title || 'Booked property', timeZone: order.time_zone,
        bookingPolicyVersion: order.policy_version, cancellationTier: order.policy_snapshot?.cancellationTier || null });
    }
    if (value.privacyRequestId) {
      const [privacy] = await tx`SELECT kind FROM customer_privacy_request WHERE id=${value.privacyRequestId} AND customer_id=${customerId}`;
      if (!privacy) throw new SupportError('NOT_FOUND');
      context.privacyKind = privacy.kind;
    }
    const [{ count }] = await tx`SELECT count(*)::int count FROM support_request WHERE customer_id=${customerId} AND created_at>clock_timestamp()-interval '1 day'`;
    if (count >= 5) throw new SupportError('RATE_LIMIT');
    const id = randomUUID(), reference = 'SUP-' + id.replaceAll('-','').slice(0,16).toUpperCase();
    await tx`INSERT INTO support_request(id,reference,customer_id,order_id,privacy_request_id,category,subject,context,policy_version,request_key,request_hash)
      VALUES(${id},${reference},${customerId},${value.orderId},${value.privacyRequestId},${value.category},${value.subject},${JSON.stringify(context)}::jsonb,${POLICY_VERSION},${value.requestKey},${hash})`;
    await tx`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash)
      VALUES(${id},'customer',${customerId},${value.body},'open',${value.requestKey},${hash})`;
    return { id };
  });
}

export async function replySupportRequest(database, actor, input, env = process.env) {
  const value = z.object({ id: uuid, body, state: z.enum(states), version: z.number().int().nonnegative(), requestKey: uuid }).strict().parse(input);
  const hash = quoteDigest(value);
  return database.begin(async tx => {
    const actorId = await authorize(tx, actor, env), request = await owned(tx, actor, actorId, value.id, true);
    const [existing] = await tx`SELECT request_id,request_hash FROM support_message WHERE actor_kind=${actor.kind} AND actor_id=${actorId} AND request_key=${value.requestKey}`;
    if (existing) { replay(existing, hash); return { id: existing.request_id }; }
    if (value.version !== request.version) throw new SupportError('STALE_REQUEST');
    if (actor.kind === 'customer' && !['open','resolved'].includes(value.state)) throw new SupportError('INVALID_STATE');
    const [{ count }] = await tx`SELECT count(*)::int count FROM support_message WHERE request_id=${request.id} AND created_at>clock_timestamp()-interval '1 hour'`;
    if (count >= 30) throw new SupportError('RATE_LIMIT');
    await tx`INSERT INTO support_message(request_id,actor_kind,actor_id,body,state_after,request_key,request_hash)
      VALUES(${request.id},${actor.kind},${actorId},${value.body},${value.state},${value.requestKey},${hash})`;
    await tx`UPDATE support_request SET state=${value.state},version=version+1,updated_at=clock_timestamp() WHERE id=${request.id}`;
    if (actor.kind === 'admin') await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES('admin',${actorId},'support_request',${request.id},'support_reply',${JSON.stringify({ state: request.state })}::jsonb,${JSON.stringify({ state: value.state })}::jsonb)`;
    return { id: request.id };
  });
}

export async function readSupportRequest(database, actor, id, env = process.env) {
  return database.begin(async tx => {
    const actorId = await authorize(tx, actor, env), row = await owned(tx, actor, actorId, id);
    const messages = await tx`SELECT id,actor_kind,body,state_after,created_at FROM support_message WHERE request_id=${row.id} ORDER BY created_at,id`;
    let privacy = null;
    if (row.privacy_request_id) {
      const [p] = await tx`SELECT kind,state FROM customer_privacy_request WHERE id=${row.privacy_request_id} AND customer_id=${row.customer_id}`;
      privacy = p || null;
    }
    return { ...dto(row), privacy, messages: messages.map(m => ({ id: m.id, author: m.actor_kind === 'admin' ? 'Rentra support' : 'Customer',
      body: m.body, state: m.state_after, at: new Date(m.created_at).toISOString() })) };
  });
}
export async function listSupportRequests(database, actor, input = {}, env = process.env) {
  const state = states.includes(input.state) ? input.state : 'all', page = Math.min(100000, Math.max(1, Number.isSafeInteger(Number(input.page)) ? Number(input.page) : 1));
  return database.begin(async tx => {
    const actorId = await authorize(tx, actor, env);
    const condition = tx`${actor.kind === 'admin' ? tx`true` : tx`customer_id=${actorId}`} AND ${state === 'all' ? tx`true` : tx`state=${state}`}`;
    const [{ count }] = await tx`SELECT count(*)::int count FROM support_request WHERE ${condition}`;
    const rows = await tx`SELECT * FROM support_request WHERE ${condition} ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET ${(page-1)*20}`;
    return { items: rows.map(dto), total: count, page, state, hasNext: count > page*20 };
  });
}
