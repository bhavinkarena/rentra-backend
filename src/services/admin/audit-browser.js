import 'server-only';
import { z } from 'zod';
import { capabilitiesFor } from '../auth/capabilities.js';
import { recentAuthentication } from '../auth/recent-auth.js';
import { encryptArtifact, decryptArtifact } from '../exports/artifact.js';
import { getContext } from '@/runtime/context.js';
import { forbidden, unauthorized, notFound, conflict, unprocessable } from '@/utils/apiError.js';

export const DATASETS = ['audit_events', 'payment_orders', 'operation_receipts'];
const uuid = z.string().uuid();
const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const filterSchema = z
  .object({
    from: date,
    to: date,
    actorType: z.enum(['admin', 'client', 'customer', 'system', 'staff']).optional(),
    actorId: uuid.optional(),
    action: identifier.optional(),
    entity: identifier.optional(),
    target: uuid.optional(),
    correlation: uuid.optional(),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.to) >= Date.parse(v.from) &&
      Date.parse(v.to) - Date.parse(v.from) <= 30 * 86400000,
  );
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw unprocessable({}, 'Use valid filters and an ordered UTC date range of at most 31 days.');
  return result.data;
};
const canonical = (value) => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, sortKeys(value[k])]),
      )
    : value;
}
const iso = (v) => new Date(v).toISOString();
export function defaultFilters() {
  const to = new Date().toISOString().slice(0, 10);
  return { from: new Date(Date.parse(to) - 6 * 86400000).toISOString().slice(0, 10), to };
}
export function normalizeFilters(input = {}) {
  return parse(filterSchema, {
    ...defaultFilters(),
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== '' && v != null)),
  });
}
async function authorize(tx, actor, write = false, dataset = 'audit_events') {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw forbidden();
  const [operator] =
    await tx`SELECT is_active,permissions FROM admin_user WHERE id=${actor.id} FOR SHARE`;
  const [session] =
    await tx`SELECT id FROM auth_session WHERE id=${uuid.safeParse(actor.sessionId).success ? actor.sessionId : null} AND admin_id=${actor.id} AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`;
  if (!session) throw unauthorized('SESSION_ENDED');
  const grants = operator
    ? capabilitiesFor({ isActive: operator.is_active, permissions: operator.permissions }, 'admin')
    : [];
  const required = [
    'admin.audit.read',
    ...(write ? ['admin.audit.write'] : []),
    ...(dataset === 'payment_orders' ? ['admin.payments.read'] : []),
    ...(dataset === 'operation_receipts' ? ['admin.records.read'] : []),
  ];
  if (required.some((c) => !grants.includes(c))) throw forbidden('CAPABILITY_REQUIRED');
  if (
    write &&
    !(
      await recentAuthentication(tx, {
        kind: 'admin',
        principalId: actor.id,
        sessionId: actor.sessionId,
      })
    ).fresh
  )
    throw forbidden(
      'RECENT_AUTH_REQUIRED',
      'Sign in again within 15 minutes before creating or retrying an export.',
    );
  return grants;
}
async function record(tx, actor, action, id, after = {}, reason = null) {
  const candidate = getContext().requestId;
  const correlation = uuid.safeParse(candidate).success
    ? candidate
    : uuid.safeParse(id).success
      ? id
      : null;
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,correlation_id,after,reason) VALUES (${actor.kind},${actor.id ?? null},'admin_audit',${id},${action},${correlation},${JSON.stringify(after)}::text::jsonb,${reason})`;
}
function where(tx, f, cutoff = new Date()) {
  return tx`at>=(${f.from}::date::timestamp AT TIME ZONE 'UTC') AND at<((${f.to}::date+1)::timestamp AT TIME ZONE 'UTC') AND at<=${cutoff instanceof Date ? iso(cutoff) : cutoff}
    AND (${f.actorType ?? null}::text IS NULL OR actor_type::text=${f.actorType ?? null})
    AND (${f.actorId ?? null}::uuid IS NULL OR actor_id=${f.actorId ?? null})
    AND (${f.action ?? null}::text IS NULL OR action=${f.action ?? null})
    AND (${f.entity ?? null}::text IS NULL OR entity=${f.entity ?? null})
    AND (${f.target ?? null}::text IS NULL OR entity_id=${f.target ?? null})
    AND (${f.correlation ?? null}::uuid IS NULL OR correlation_id=${f.correlation ?? null})`;
}
const safeWords = new Set([
  'active',
  'inactive',
  'blocked',
  'suspended',
  'pending_application',
  'open',
  'closed',
  'queued',
  'failed',
  'completed',
  'cancelled',
  'confirmed',
  'requested',
  'processing',
  'unknown',
  'succeeded',
  'test',
  'live',
  'simulated',
  'real',
  'legacy_unknown',
  'approved',
  'rejected',
  'in_review',
  'partial_anonymization_complete',
  'scoped_export_ready',
  'published',
  'archived',
  'paused',
  'hidden',
  'day',
  'night',
  'full_day',
]);
const allowedFields = new Set([
  'state',
  'status',
  'accountStatus',
  'account_status',
  'version',
  'effectiveVersion',
  'count',
  'added',
  'attempted',
  'skipped',
  'removed',
  'disabled',
  'fullDeletion',
  'active',
  'isActive',
  'environment',
  'mode',
  'amountMinor',
  'expected_minor',
  'from',
  'to',
  'endExclusive',
  'slot',
  'id',
  'orderId',
  'requestId',
  'requestKey',
  'commandId',
  'outcome',
]);
function safeValue(v) {
  if (v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)))
    return v;
  if (
    typeof v === 'string' &&
    (uuid.safeParse(v).success || date.safeParse(v).success || safeWords.has(v))
  )
    return v;
  return '[withheld]';
}
function projection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => allowedFields.has(k))
      .map(([k, v]) => [k, safeValue(v)]),
  );
}
export function auditProjection(r) {
  const before = projection(r.before),
    after = projection(r.after);
  return {
    id: r.id,
    at: iso(r.at),
    actor: { type: r.actor_type, id: r.actor_id },
    action: identifier.safeParse(r.action).success ? r.action : '[withheld]',
    target: {
      type: identifier.safeParse(r.entity).success ? r.entity : '[withheld]',
      id: uuid.safeParse(r.entity_id).success ? r.entity_id : null,
    },
    correlation:
      r.correlation_id ??
      ['requestKey', 'commandId', 'requestId']
        .map((k) => r.after?.[k])
        .find((v) => uuid.safeParse(v).success) ??
      null,
    reason: r.reason
      ? 'Recorded; free text withheld. Review the source case with its domain permission.'
      : null,
    before,
    after,
    changes: [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null })),
    redaction:
      'Allowlisted identifiers, dates, states and integer counts only. IP, names, contacts, free text, nested payloads, secrets and unknown fields are withheld.',
  };
}
export async function auditList(db, actor, query = {}) {
  const { page: rawPage = 1, ...raw } = query,
    page = parse(z.coerce.number().int().min(1).max(100000), rawPage),
    filters = normalizeFilters(raw);
  return db.begin(async (tx) => {
    const grants = await authorize(tx, actor),
      cutoff = new Date();
    const [count] =
      await tx`SELECT count(*)::int total FROM audit_log WHERE ${where(tx, filters, cutoff)}`;
    const rows =
      await tx`SELECT id,at,actor_type,actor_id,entity,entity_id,action,correlation_id,reason IS NOT NULL has_reason FROM audit_log WHERE ${where(tx, filters, cutoff)} ORDER BY at DESC,id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`;
    await record(tx, actor, 'audit_search_read', null, { count: rows.length });
    return {
      filters,
      page,
      total: count.total,
      pages: Math.max(1, Math.ceil(count.total / 25)),
      refreshedAt: iso(cutoff),
      items: rows.map((r) => auditProjection({ ...r, reason: r.has_reason ? 'recorded' : null })),
      canExport: grants.includes('admin.audit.write'),
      datasets: DATASETS.filter(
        (d) => d !== 'payment_orders' || grants.includes('admin.payments.read'),
      ).filter((d) => d !== 'operation_receipts' || grants.includes('admin.records.read')),
    };
  });
}
function operationReceipt(r) {
  return {
    operation: r.action,
    eventId: r.id,
    actor: { type: r.actor_type, id: r.actor_id },
    target: uuid.safeParse(r.entity_id).success ? r.entity_id : null,
    committedAt: iso(r.at),
    scope: projection(r.after),
    outcome: 'committed',
    countsRecorded: Number.isSafeInteger(r.after?.added),
    semantics:
      'Calendar date addition inserts missing rows atomically and preserves existing rows. This receipt describes the original committed operation; it does not execute or undo it.',
  };
}
export async function auditDetail(db, actor, id) {
  if (!uuid.safeParse(id).success) throw notFound();
  return db.begin(async (tx) => {
    const grants = await authorize(tx, actor);
    const [row] = await tx`SELECT * FROM audit_log WHERE id=${id}`;
    if (!row) throw notFound();
    await record(tx, actor, 'audit_event_read', id);
    return {
      event: auditProjection(row),
      operationReceipt:
        row.action === 'calendar_dates_added' && grants.includes('admin.records.read')
          ? operationReceipt(row)
          : null,
    };
  });
}
const createSchema = z
  .object({
    dataset: z.enum(DATASETS),
    filters: filterSchema,
    environment: z.enum(['test', 'live', 'simulated']).optional(),
    limit: z.number().int().min(1).max(2000),
    requestKey: uuid,
    reason: z.string().trim().min(20).max(1000),
    confirmed: z.literal(true),
  })
  .strict();
const jobDTO = (j) => ({
  id: j.id,
  dataset: j.dataset,
  scope: j.scope,
  state: j.state,
  version: j.version,
  attempts: j.attempts,
  errorCode: j.error_code,
  createdAt: iso(j.created_at),
  expiresAt: j.expires_at ? iso(j.expires_at) : null,
  receipt: j.receipt,
  downloadAvailable: Boolean(
    j.state === 'completed' && j.artifact_ciphertext && new Date(j.expires_at) > new Date(),
  ),
});
export async function createExport(db, actor, input) {
  const v = parse(createSchema, input);
  if (
    v.dataset === 'payment_orders' &&
    (!v.environment || Object.keys(v.filters).some((k) => !['from', 'to'].includes(k)))
  )
    throw unprocessable({}, 'Payment exports require one explicit environment and UTC dates only.');
  if (v.dataset !== 'payment_orders' && v.environment)
    throw unprocessable({}, 'Environment is only valid for payment exports.');
  const scope = {
    filters: v.filters,
    limit: v.limit,
    ...(v.environment ? { environment: v.environment } : {}),
  };
  return db.begin(async (tx) => {
    await authorize(tx, actor, true, v.dataset);
    // Serializes duplicate request keys and concurrent creations for this creator.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id},28))`;
    const [old] =
      await tx`SELECT * FROM admin_export_job WHERE creator_id=${actor.id} AND request_key=${v.requestKey}`;
    if (old) {
      if (
        old.dataset !== v.dataset ||
        canonical(old.scope) !== canonical(scope) ||
        old.reason !== v.reason
      )
        throw conflict('REQUEST_KEY_REUSED');
      return jobDTO(old);
    }
    const [active] =
      await tx`SELECT count(*)::int n FROM admin_export_job WHERE creator_id=${actor.id} AND state='queued'`;
    if (active.n >= 3)
      throw conflict('EXPORT_QUEUE_FULL', 'Wait for a queued export before creating another.');
    const [job] =
      await tx`INSERT INTO admin_export_job(creator_id,request_key,dataset,scope,reason) VALUES (${actor.id},${v.requestKey},${v.dataset},${JSON.stringify(scope)}::text::jsonb,${v.reason}) RETURNING *`;
    await record(
      tx,
      actor,
      'export_queued',
      job.id,
      { dataset: v.dataset, limit: v.limit },
      v.reason,
    );
    return jobDTO(job);
  });
}
async function ownJob(tx, actor, id, write = false) {
  if (!uuid.safeParse(id).success) throw notFound();
  await authorize(tx, actor, write);
  const [job] =
    await tx`SELECT * FROM admin_export_job WHERE id=${id} AND creator_id=${actor.id} FOR UPDATE`;
  if (!job) throw notFound();
  await authorize(tx, actor, write, job.dataset);
  return job;
}
export async function exportList(db, actor) {
  return db.begin(async (tx) => {
    const grants = await authorize(tx, actor);
    const jobs =
      await tx`SELECT * FROM admin_export_job WHERE creator_id=${actor.id} ORDER BY created_at DESC,id DESC LIMIT 25`;
    const visible = jobs
      .filter((j) => j.dataset !== 'payment_orders' || grants.includes('admin.payments.read'))
      .filter((j) => j.dataset !== 'operation_receipts' || grants.includes('admin.records.read'));
    await record(tx, actor, 'export_list_read', null, { count: visible.length });
    return { items: visible.map(jobDTO), canExport: grants.includes('admin.audit.write') };
  });
}
export async function exportDetail(db, actor, id) {
  return db.begin(async (tx) => {
    const j = await ownJob(tx, actor, id);
    await record(tx, actor, 'export_status_read', id);
    return {
      job: jobDTO(j),
      canExport: (await authorize(tx, actor)).includes('admin.audit.write'),
    };
  });
}
export async function retryExport(db, actor, id, input) {
  const v = parse(
    z
      .object({
        version: z.number().int().positive(),
        reason: z.string().trim().min(20).max(1000),
        confirmed: z.literal(true),
      })
      .strict(),
    input,
  );
  return db.begin(async (tx) => {
    const j = await ownJob(tx, actor, id, true);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${actor.id},28))`;
    const [queued] =
      await tx`SELECT count(*)::int n FROM admin_export_job WHERE creator_id=${actor.id} AND state='queued'`;
    if (queued.n >= 3) throw conflict('EXPORT_QUEUE_FULL');
    if (j.version !== v.version) throw conflict('EXPORT_CHANGED');
    if (j.state !== 'failed') throw conflict('EXPORT_NOT_FAILED');
    if (new Date() - new Date(j.created_at) > 86400000)
      throw conflict('EXPORT_REQUEST_EXPIRED', 'Create a new scoped request.');
    const [next] =
      await tx`UPDATE admin_export_job SET state='queued',error_code=NULL,version=version+1,updated_at=now() WHERE id=${id} RETURNING *`;
    await record(tx, actor, 'export_retried', id, {}, v.reason);
    return jobDTO(next);
  });
}
export async function processExport(db, id, options = {}) {
  try {
    return await db.begin(async (tx) => {
      const [creator] =
        await tx`SELECT a.id,a.is_active,a.permissions FROM admin_user a JOIN admin_export_job j ON j.creator_id=a.id WHERE j.id=${id} FOR SHARE OF a`;
      const [j] = await tx`SELECT * FROM admin_export_job WHERE id=${id} FOR UPDATE`;
      if (!j || j.state !== 'queued') return false;
      const grants = creator
        ? capabilitiesFor(
            { isActive: creator.is_active, permissions: creator.permissions },
            'admin',
          )
        : [];
      const required = [
        'admin.audit.read',
        'admin.audit.write',
        ...(j.dataset === 'payment_orders' ? ['admin.payments.read'] : []),
        ...(j.dataset === 'operation_receipts' ? ['admin.records.read'] : []),
      ];
      if (required.some((c) => !grants.includes(c))) throw forbidden('CAPABILITY_REQUIRED');
      if (new Date() - new Date(j.created_at) > 86400000) throw conflict('EXPORT_REQUEST_EXPIRED');
      await options.beforeBuild?.(j);
      const { filters: f, limit, environment } = j.scope;
      let rows, items;
      if (j.dataset === 'payment_orders') {
        rows =
          await tx`SELECT id,booking_order_id,environment,mode,currency,purpose,expected_minor,state,created_at FROM payment_order WHERE environment=${environment} AND created_at>=(${f.from}::date::timestamp AT TIME ZONE 'UTC') AND created_at<((${f.to}::date+1)::timestamp AT TIME ZONE 'UTC') AND created_at<=(SELECT created_at FROM admin_export_job WHERE id=${j.id}) ORDER BY created_at,id LIMIT ${limit + 1}`;
        items = rows;
      } else {
        rows =
          await tx`SELECT * FROM audit_log WHERE ${where(tx, f, tx`(SELECT created_at FROM admin_export_job WHERE id=${j.id})`)} AND (${j.dataset !== 'operation_receipts'} OR action='calendar_dates_added') ORDER BY at,id LIMIT ${limit + 1}`;
        items = rows.map(j.dataset === 'audit_events' ? auditProjection : operationReceipt);
      }
      if (rows.length > limit)
        throw conflict('EXPORT_BOUNDS_EXCEEDED', 'Narrow the scope and create a new request.');
      const exclusions =
        j.dataset === 'payment_orders'
          ? [
              'Provider identifiers, credentials, payment tokens, account contact fields, ledger aggregates and other environments',
            ]
          : ['Free text, IP addresses, names/contacts, secrets, nested/unknown payload fields'];
      const payload = JSON.stringify({
        dataset: j.dataset,
        scope: j.scope,
        requestedAt: iso(j.created_at),
        generatedAt: new Date().toISOString(),
        exclusions,
        items,
      });
      if (Buffer.byteLength(payload) > 5 * 1024 * 1024) throw conflict('EXPORT_BOUNDS_EXCEEDED');
      const expiresAt = new Date(Date.now() + 86400000),
        receipt = {
          jobId: id,
          dataset: j.dataset,
          scope: j.scope,
          rowCount: rows.length,
          bytes: Buffer.byteLength(payload),
          completedAt: new Date().toISOString(),
          expiresAt: iso(expiresAt),
          exclusions,
          semantics:
            'Read-only scoped copy. Row selection ends at request creation; values are projected at generation. No business mutation is executed.',
        };
      await tx`UPDATE admin_export_job SET state='completed',artifact_ciphertext=${encryptArtifact(payload, id, options.env ?? process.env)},receipt=${JSON.stringify(receipt)}::text::jsonb,expires_at=${iso(expiresAt)},attempts=attempts+1,version=version+1,updated_at=now() WHERE id=${id}`;
      await record(tx, { kind: 'system' }, 'export_completed', id, { count: rows.length });
      return true;
    });
  } catch (error) {
    await db.begin(async (tx) => {
      const [j] =
        await tx`UPDATE admin_export_job SET state='failed',error_code=${['CAPABILITY_REQUIRED', 'EXPORT_REQUEST_EXPIRED', 'EXPORT_BOUNDS_EXCEEDED', 'EXPORT_KEY_UNAVAILABLE'].includes(error.code) ? error.code : 'EXPORT_FAILED'},attempts=attempts+1,version=version+1,updated_at=now() WHERE id=${id} AND state='queued' RETURNING id`;
      if (j) await record(tx, { kind: 'system' }, 'export_failed', id);
    });
    return false;
  }
}
export async function runExportJobs(db, options = {}) {
  await db`UPDATE admin_export_job SET artifact_ciphertext=NULL WHERE artifact_ciphertext IS NOT NULL AND expires_at<=clock_timestamp()`;
  const jobs =
    await db`SELECT id FROM admin_export_job WHERE state='queued' ORDER BY created_at,id LIMIT 10`;
  for (const j of jobs) await processExport(db, j.id, options);
  return jobs.length;
}
export async function exportDownload(db, actor, id, receipt = false, env = process.env) {
  return db.begin(async (tx) => {
    const j = await ownJob(tx, actor, id);
    if (j.state !== 'completed' || !j.receipt) throw conflict('ARTIFACT_NOT_READY');
    if (!receipt && (!j.artifact_ciphertext || new Date(j.expires_at) <= new Date()))
      throw conflict('EXPORT_EXPIRED');
    const bytes = receipt
      ? Buffer.from(JSON.stringify(j.receipt, null, 2))
      : decryptArtifact(j.artifact_ciphertext, id, env);
    await record(tx, actor, receipt ? 'export_receipt_downloaded' : 'export_downloaded', id);
    return bytes;
  });
}
