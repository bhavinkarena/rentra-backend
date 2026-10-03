import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { badRequest, forbidden, notFound, conflict, unavailable } from '@/utils/apiError.js';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { preparePhotos } from '../booking/visit-evidence.js';
import { evidenceStore } from '../uploads/evidence-store.js';
const uuid = z.string().uuid(),
  body = z.string().trim().min(10).max(2000);
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const instant = (v) => (v ? new Date(v).toISOString() : null);
const parse = (schema, input) => {
  const r = schema.safeParse(input);
  if (!r.success)
    throw badRequest(
      'INVALID_DISPUTE',
      'Check the case fields, identifiers and response deadline.',
    );
  return r.data;
};
async function actorId(tx, actor, write = false) {
  if (actor?.kind === 'customer') return (await lockCustomerAccount(tx, actor.session)).id;
  if (!uuid.safeParse(actor?.id).success) throw forbidden();
  const rows =
    actor.kind === 'admin'
      ? await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active AND (permissions IS NULL OR permissions @> ${JSON.stringify([`admin.payments.${write ? 'write' : 'read'}`])}::text::jsonb)`
      : actor.kind === 'owner'
        ? await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active'`
        : [];
  if (!rows.length) throw forbidden();
  return actor.id;
}
const scope = (tx, actor, id) =>
  actor.kind === 'admin'
    ? tx`true`
    : actor.kind === 'owner'
      ? tx`c.owner_id=${id}`
      : tx`c.customer_id=${id}`;
const visible = (tx, actor) =>
  actor.kind === 'admin' ? tx`true` : tx`m.audience IN (${actor.kind},'everyone')`;
async function owned(tx, actor, id, caseId, lock = false) {
  if (!uuid.safeParse(caseId).success) throw notFound();
  const [c] =
    await tx`SELECT c.* FROM dispute_case c WHERE c.id=${caseId} AND ${scope(tx, actor, id)} ${lock ? tx`FOR UPDATE` : tx``}`;
  if (!c) throw notFound();
  return c;
}
async function audit(tx, actor, id, caseId, action, after) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES (${actor.kind === 'owner' ? 'client' : actor.kind},${id},'dispute_case',${caseId},${action},${JSON.stringify(after)}::text::jsonb)`;
}
async function message(tx, actor, id, c, kind, audience, text, key, hash) {
  const [m] =
    await tx`INSERT INTO dispute_message(case_id,actor_kind,actor_id,kind,audience,body,request_key,request_hash) VALUES (${c},${actor.kind},${id},${kind},${audience},${text},${key},${hash}) RETURNING id`;
  return m.id;
}
function replay(row, hash) {
  if (row.request_hash !== hash)
    throw conflict('REQUEST_KEY_CONFLICT', 'This request key was used for different content.');
}
async function finance(tx, visitId) {
  const rows =
    await tx`SELECT po.id payment_id,t.environment,t.mode,pa.component,sum(pa.actual_minor)::text captured_minor,
   sum(coalesce(r.refunded,0))::text refunded_minor,sum(coalesce(r.reserved,0))::text reserved_minor
  FROM payment_allocation pa JOIN payment_transaction t ON t.id=pa.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order po ON po.id=a.payment_order_id
  LEFT JOIN LATERAL (SELECT sum(ra.actual_minor) FILTER(WHERE rf.state='succeeded') refunded,sum(ra.expected_minor) FILTER(WHERE rf.state<>'failed') reserved FROM refund_allocation ra JOIN refund rf ON rf.id=ra.refund_id WHERE ra.payment_allocation_id=pa.id) r ON true
  WHERE pa.booking_id=${visitId} AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL
  GROUP BY po.id,t.environment,t.mode,pa.component ORDER BY po.id,pa.component`;
  return {
    allocations: rows,
    depositPolicyAvailable: false,
    depositExecutionAvailable: false,
    providerSubmissionAvailable: false,
    depositNotice:
      'Deposit collection, release and deduction are unavailable: no approved operational deposit policy and supported deposit execution workflow is configured. Quoted deposits and claimed damage are not refundable balances.',
    effect:
      'Case decisions do not charge, refund, freeze payouts or change booking status. Any permitted refund requires a separate verified-capture preview and command in Refund operations.',
  };
}
export async function disputeContext(database, actor, orderId) {
  if (!uuid.safeParse(orderId).success) throw notFound();
  return database.begin(async (tx) => {
    const id = await actorId(tx, actor);
    const [o] =
      await tx`SELECT o.id,o.reference,o.listing_snapshot->>'title' title,r.client_id,o.customer_id FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=${orderId}`;
    if (
      !o ||
      (actor.kind === 'owner' && o.client_id !== id) ||
      (actor.kind === 'customer' && o.customer_id !== id)
    )
      throw notFound();
    return {
      id: o.id,
      reference: o.reference,
      title: o.title,
      visits:
        await tx`SELECT id,reference,local_day,state FROM booking WHERE order_id=${o.id} ORDER BY item_position`,
    };
  });
}
export async function createDispute(database, actor, input, files = [], store = evidenceStore()) {
  const v = parse(
    z
      .object({
        orderId: uuid,
        visitId: uuid,
        kind: z.enum(['service', 'deposit', 'provider']),
        subject: z.string().trim().min(5).max(160),
        body,
        claimedMinor: z.coerce.number().int().min(0).max(100000000).default(0),
        requestKey: uuid,
      })
      .strict(),
    input,
  );
  return database.begin(async (tx) => {
    const id = await actorId(tx, actor, true);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.kind + id + v.requestKey},0))`;
    const [o] =
      await tx`SELECT o.*,r.client_id FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=${v.orderId} FOR SHARE OF o,r`;
    if (
      !o ||
      (actor.kind === 'owner' && o.client_id !== id) ||
      (actor.kind === 'customer' && o.customer_id !== id)
    )
      throw notFound();
    if (!(await tx`SELECT id FROM booking WHERE id=${v.visitId} AND order_id=${o.id}`).length)
      throw notFound();
    const photos = await preparePhotos(files);
    const hash = digest(photos.length ? {...v, photos: photos.map(p=>p.sha256)} : v);
    const [old] =
      await tx`SELECT id,request_hash FROM dispute_case WHERE created_by_kind=${actor.kind} AND created_by_id=${id} AND request_key=${v.requestKey}`;
    if (old) {
      replay(old, hash);
      return { id: old.id, replayed: true };
    }
    if(photos.length && !store.configured()) throw unavailable('EVIDENCE_UNAVAILABLE','Photo storage is unavailable. Your case has not been saved.');
    const [{ n }] =
      await tx`SELECT count(*)::int n FROM dispute_case WHERE created_by_id=${id} AND created_at>now()-interval '1 hour'`;
    if (n >= 10) throw badRequest('CASE_LIMIT', 'Too many new cases. Please try again later.');
    const [c] =
      await tx`INSERT INTO dispute_case(order_id,visit_id,owner_id,customer_id,kind,subject,claimed_minor,created_by_kind,created_by_id,request_key,request_hash) VALUES (${o.id},${v.visitId},${o.client_id},${o.customer_id},${v.kind},${v.subject},${v.claimedMinor},${actor.kind},${id},${v.requestKey},${hash}) RETURNING id`;
    const messageId = await message(
      tx,
      actor,
      id,
      c.id,
      'created',
      actor.kind === 'admin' ? 'internal' : actor.kind,
      v.body,
      v.requestKey,
      hash,
    );
    for(const photo of photos){
      const saved = await store.put({folder:`rentra/disputes/${c.id}/${v.requestKey}`,name:photo.sha256,buffer:photo.buffer,mime:photo.mime});
      await tx`INSERT INTO dispute_attachment(message_id,storage_key,mime_type,bytes,sha256) VALUES(${messageId},${saved.key},${photo.mime},${photo.bytes},${photo.sha256})`;
    }
    await audit(tx, actor, id, c.id, 'dispute_created' , {
      orderId: o.id,
      visitId: v.visitId,
      kind: v.kind,
    });
    return { id: c.id };
  });
}
export async function listDisputes(database, actor, input = {}) {
  const v = parse(
    z.object({
      state: z.enum(['open', 'resolved', 'all']).default('open'),
      kind: z.enum(['service', 'deposit', 'provider', 'all']).default('all'),
      page: z.coerce.number().int().min(1).max(10000).default(1),
      orderId: uuid.or(z.literal('')).default(''),
    }),
    input,
  );
  return database.begin(async (tx) => {
    const id = await actorId(tx, actor);
    const rows =
      await tx`SELECT c.id,c.subject,c.kind,c.state,c.version,c.created_at,c.response_due,c.requested_party,c.assignee_id,o.reference FROM dispute_case c JOIN booking_order o ON o.id=c.order_id WHERE ${scope(tx, actor, id)} AND (${v.state}='all' OR c.state=${v.state}) AND (${v.kind}='all' OR c.kind=${v.kind}) AND (${v.orderId}='' OR c.order_id::text=${v.orderId}) ORDER BY c.created_at DESC,c.id LIMIT 31 OFFSET ${(v.page - 1) * 30}`;
    return { filters: v, items: rows.slice(0, 30), hasNext: rows.length > 30 };
  });
}
export async function readDispute(database, actor, caseId) {
  return database.begin(async (tx) => {
    const id = await actorId(tx, actor),
      c = await owned(tx, actor, id, caseId);
    const [o] =
      await tx`SELECT o.reference,o.listing_snapshot->>'title' title,r.client_id FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=${c.order_id}`;
    const messages =
      await tx`SELECT m.id,m.actor_kind,m.kind,m.audience,m.body,m.created_at FROM dispute_message m WHERE m.case_id=${c.id} AND ${visible(tx, actor)} ORDER BY m.created_at,m.id`;
    const files =
      await tx`SELECT a.id,a.message_id,a.mime_type,a.bytes FROM dispute_attachment a JOIN dispute_message m ON m.id=a.message_id WHERE m.case_id=${c.id} AND ${visible(tx, actor)}`;
    const admin = actor.kind === 'admin';
    const operators = admin
      ? await tx`SELECT id,name FROM admin_user WHERE is_active AND (permissions IS NULL OR permissions @> '["admin.payments.write"]'::jsonb) ORDER BY name,id`
      : [];
    const [me] = admin ? await tx`SELECT permissions FROM admin_user WHERE id=${id}` : [];
    return {
      id: c.id,
      orderId: c.order_id,
      visitId: c.visit_id,
      subject: c.subject,
      kind: c.kind,
      state: c.state,
      claimedMinor: String(c.claimed_minor),
      version: c.version,
      claimSummary: c.claim_summary,
      requestedParty: c.requested_party,
      responseDue: instant(c.response_due),
      assigneeId: admin ? c.assignee_id : null,
      resolution: c.resolution,
      outcome: c.outcome,
      resolvedAt: instant(c.resolved_at),
      title: o.title,
      reference: o.reference,
      bookingLinkAvailable: actor.kind !== 'owner' || o.client_id === id,
      messages: messages.map((m) => ({
        ...m,
        attachments: files.filter((a) => a.message_id === m.id),
      })),
      operators,
      canWrite: !admin || me.permissions == null || me.permissions.includes('admin.payments.write'),
      finance: await finance(tx, c.visit_id),
    };
  });
}
export async function replyDispute(database, actor, input, files = [], store = evidenceStore()) {
  const v = parse(
    z
      .object({
        id: uuid,
        version: z.coerce.number().int().min(1),
        body,
        audience: z.enum(['owner', 'customer', 'everyone', 'internal']).optional(),
        requestKey: uuid,
      })
      .strict(),
    input,
  );
  const audience = actor.kind === 'admin' ? v.audience || 'internal' : actor.kind;
  if (actor.kind !== 'admin' && v.audience && v.audience !== actor.kind) throw forbidden();
  await database.begin(async (tx) => owned(tx, actor, await actorId(tx, actor, true), v.id));
  let photos;
  try {
    photos = await preparePhotos(files);
  } catch (e) {
    if (e.code === 'INVALID_ATTACHMENT') throw badRequest(e.code, e.message);
    throw e;
  }
  const hash = digest({ ...v, audience, photos: photos.map((p) => p.sha256) });
  return database.begin(async (tx) => {
    const id = await actorId(tx, actor, true),
      c = await owned(tx, actor, id, v.id, true);
    const [old] =
      await tx`SELECT id,request_hash FROM dispute_message WHERE case_id=${c.id} AND actor_kind=${actor.kind} AND actor_id=${id} AND request_key=${v.requestKey}`;
    if (old) {
      replay(old, hash);
      return { id: c.id, replayed: true };
    }
    if (c.state !== 'open' || c.version !== v.version)
      throw conflict(
        'DISPUTE_CHANGED',
        'This case changed or was resolved. Reload before sending.',
      );
    const [{ n }] = await tx`SELECT count(*)::int n FROM dispute_message WHERE case_id=${c.id}`;
    if (n >= 200)
      throw badRequest(
        'CASE_LIMIT',
        'This case has reached its message limit. Contact support for escalation.',
      );
    const [{ n: attachments }] =
      await tx`SELECT count(*)::int n FROM dispute_attachment a JOIN dispute_message m ON m.id=a.message_id WHERE m.case_id=${c.id}`;
    if (attachments + photos.length > 30)
      throw badRequest('PHOTO_LIMIT', 'This case can hold 30 photos.');
    if (photos.length && !store.configured())
      throw unavailable(
        'UPLOADS_UNAVAILABLE',
        'Photo storage is unavailable. Your response was not saved.',
      );
    const mid = await message(tx, actor, id, c.id, 'reply', audience, v.body, v.requestKey, hash);
    for (const p of photos) {
      const saved = await store.put({
        folder: `disputes/${c.id}/${v.requestKey}`,
        name: p.sha256,
        buffer: p.buffer,
      });
      await tx`INSERT INTO dispute_attachment(message_id,storage_key,mime_type,bytes,sha256) VALUES (${mid},${saved.key},${p.mime},${p.bytes},${p.sha256})`;
    }
    await tx`UPDATE dispute_case SET version=version+1,updated_at=now(),requested_party=CASE WHEN requested_party=${actor.kind} THEN NULL ELSE requested_party END,response_due=CASE WHEN requested_party=${actor.kind} THEN NULL ELSE response_due END WHERE id=${c.id}`;
    await audit(tx, actor, id, c.id, 'dispute_response', { messageId: mid, audience });
    return { id: c.id };
  });
}
const commandSchema = z
  .object({
    id: uuid,
    version: z.coerce.number().int().min(1),
    command: z.enum(['assign', 'request_response', 'resolve']),
    body,
    assigneeId: uuid.nullable().optional(),
    party: z.enum(['owner', 'customer']).optional(),
    due: z.string().datetime().optional(),
    outcome: z.enum(['no_action', 'refund_review', 'support_escalation']).optional(),
    preview: z.boolean().default(false),
    previewToken: z.string().optional(),
    requestKey: uuid,
    claimSummary: body.optional(),
  })
  .strict();
function token(actor, id, version, value) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw unavailable();
  return createHmac('sha256', secret)
    .update(JSON.stringify([actor, id, version, value]))
    .digest('hex');
}
export async function manageDispute(database, actor, input) {
  if (actor.kind !== 'admin') throw forbidden();
  const v = parse(commandSchema, input);
  if (v.preview && v.command !== 'resolve')
    throw badRequest('INVALID_PREVIEW', 'Only resolution supports a preview.');
  return database.begin(async (tx) => {
    const id = await actorId(tx, actor, true),
      c = await owned(tx, actor, id, v.id, true);
    const value = {
        claimSummary: v.claimSummary ?? null,
        command: v.command,
        body: v.body,
        assigneeId: v.assigneeId ?? null,
        party: v.party ?? null,
        due: v.due ?? null,
        outcome: v.outcome ?? null,
      },
      hash = digest(value);
    const [old] =
      await tx`SELECT request_hash FROM dispute_message WHERE case_id=${c.id} AND actor_kind='admin' AND actor_id=${id} AND request_key=${v.requestKey}`;
    if (old && !v.preview) {
      replay(old, hash);
      return { id: c.id, replayed: true };
    }
    if (c.state !== 'open' || c.version !== v.version)
      throw conflict('DISPUTE_CHANGED', 'This case changed or was resolved. Reload and review it.');
    if (v.command === 'assign') {
      if (
        v.assigneeId &&
        !(
          await tx`SELECT id FROM admin_user WHERE id=${v.assigneeId} AND is_active AND (permissions IS NULL OR permissions @> '["admin.payments.write"]'::jsonb) FOR SHARE`
        ).length
      )
        throw badRequest('INVALID_ASSIGNEE', 'Choose an active finance operator.');
      await tx`UPDATE dispute_case SET assignee_id=${v.assigneeId ?? null},version=version+1,updated_at=now() WHERE id=${c.id}`;
      await message(tx, actor, id, c.id, 'assigned', 'internal', v.body, v.requestKey, hash);
    } else if (v.command === 'request_response') {
      const due = new Date(v.due);
      if (
        !v.party ||
        !Number.isFinite(+due) ||
        +due <= Date.now() ||
        +due > Date.now() + 90 * 86400000
      )
        throw badRequest(
          'INVALID_DEADLINE',
          'Choose a participant and a deadline within the next 90 days.',
        );
      await tx`UPDATE dispute_case SET requested_party=${v.party},response_due=${due.toISOString()},claim_summary=coalesce(${v.claimSummary || null},claim_summary),version=version+1,updated_at=now() WHERE id=${c.id}`;
      await message(tx, actor, id, c.id, 'requested', v.party, v.body, v.requestKey, hash);
    } else {
      if (!v.outcome) throw badRequest('INVALID_OUTCOME', 'Choose a supported resolution.');
      const f = await finance(tx, c.visit_id),
        signature = token(id, c.id, c.version, { value, finance: f });
      if (v.preview)
        return {
          id: c.id,
          preview: {
            outcome: v.outcome,
            body: v.body,
            effect: f.effect,
            depositNotice: f.depositNotice,
            previewToken: signature,
          },
        };
      const supplied = Buffer.from(v.previewToken || '');
      const expected = Buffer.from(signature);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw conflict(
          'PREVIEW_REQUIRED',
          'Preview this resolution against the current evidence before confirming.',
        );
      await tx`UPDATE dispute_case SET state='resolved',outcome=${v.outcome},resolution=${v.body},resolved_by=${id},resolved_at=now(),version=version+1,updated_at=now(),requested_party=NULL,response_due=NULL WHERE id=${c.id}`;
      await message(tx, actor, id, c.id, 'resolved', 'everyone', v.body, v.requestKey, hash);
    }
    await audit(tx, actor, id, c.id, 'dispute_' + v.command, value);
    return { id: c.id };
  });
}
export async function disputeAttachment(database, actor, caseId, fileId, store = evidenceStore()) {
  if (!uuid.safeParse(fileId).success) throw notFound();
  const file = await database.begin(async (tx) => {
    const id = await actorId(tx, actor);
    await owned(tx, actor, id, caseId);
    const [f] =
      await tx`SELECT a.* FROM dispute_attachment a JOIN dispute_message m ON m.id=a.message_id WHERE a.id=${fileId} AND m.case_id=${caseId} AND ${visible(tx, actor)}`;
    if (!f) throw notFound();
    await audit(tx, actor, id, caseId, 'dispute_evidence_read', { attachmentId: fileId });
    return f;
  });
  const data = await store.get(file.storage_key);
  if (!data)
    throw unavailable('EVIDENCE_UNAVAILABLE', 'Evidence storage is temporarily unavailable.');
  return { body: data.body, mimeType: file.mime_type };
}
