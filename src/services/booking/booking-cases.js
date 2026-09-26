import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withListingInventory } from './inventory.js';
import { lifecycle } from './checkout.js';
import { previewBookingQuote, quoteDigest } from './quotes.js';
import {
  allocateRefund,
  capturedAllocations,
  createRefundObligations,
  testSourcesOnly,
} from './cancellation.js';
import {
  ADMIN_SOURCES,
  AUDIENCES,
  CASE_LABELS,
  CASE_TYPES,
  OUTCOME_LABELS,
  OWNER_CASE_TYPES,
  REFUND_BASES,
  caseEntitlement,
  caseReference,
  createdAudience,
  defaultRefundBasis,
  uncancellableReason,
  visibleTo,
} from '../domain/booking-cases.js';

/**
 * CP14 booking cases. A case concerns exact visits and is resolved once by an
 * admin. Cancellation reuses the customer cancellation engine: refunds are
 * capped by verified captures, and inventory is released inside the listing
 * lock. Replacement dates are never reserved by a case.
 */
export class CaseError extends Error {
  constructor(code, message = code, { status = 400, field = null } = {}) {
    super(message);
    this.name = 'CaseError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const uuid = z.string().uuid();
const instant = (value) => (value ? new Date(value).toISOString() : null);
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

function requireActor(actor, kinds) {
  if (!kinds.includes(actor?.kind) || !uuid.safeParse(actor.id).success) {
    throw new CaseError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
  }
}

async function lockActor(tx, actor, clientId) {
  const [row] =
    actor.kind === 'owner'
      ? await tx`SELECT id,name FROM "user" WHERE id=${actor.id} AND id=${clientId} AND role='client' AND account_status='active' FOR SHARE`
      : await tx`SELECT id,name FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
  return row ?? null;
}

async function audit(tx, actor, entityId, action, after, before = null) {
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
    VALUES(${actor.kind === 'owner' ? 'client' : 'admin'},${actor.id},'booking_case',${entityId},${action},
    ${before ? JSON.stringify(before) : null}::text::jsonb,${JSON.stringify(after)}::text::jsonb)`;
}

/* --------------------------------- create --------------------------------- */

const changeSchema = z
  .object({
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(10),
    slot: z.enum(['day', 'night', 'full_day']),
    guests: z.number().int().min(1).max(500),
  })
  .strict();

const createSchema = z
  .object({
    orderId: uuid,
    type: z.enum(CASE_TYPES),
    visitIds: z.array(uuid).min(1, 'Choose at least one visit.').max(10),
    reason: z.string().trim().min(10).max(1000),
    requestedOutcome: z.string().trim().max(500).nullable().default(null),
    requesterKind: z.enum(['customer', 'owner', 'admin']).optional(),
    source: z.enum(ADMIN_SOURCES).optional(),
    requestedChange: changeSchema.nullable().default(null),
    requestKey: uuid,
  })
  .strict();

export async function createBookingCase(database, actor, input) {
  requireActor(actor, ['owner', 'admin']);
  const parsed = createSchema.parse(input);
  const owner = actor.kind === 'owner';
  if (owner && !OWNER_CASE_TYPES.includes(parsed.type)) {
    throw new CaseError('CASE_TYPE_UNAVAILABLE', 'Owners can request a cancellation or report a no-show, late arrival or operational issue.', { status: 422, field: 'type' });
  }
  const value = {
    ...parsed,
    visitIds: [...new Set(parsed.visitIds)].sort(),
    requesterKind: owner ? 'owner' : (parsed.requesterKind ?? 'admin'),
    source: owner ? 'portal' : (parsed.source ?? 'internal'),
    requestedChange: parsed.type === 'change_request' ? parsed.requestedChange : null,
    requestedOutcome: parsed.requestedOutcome || null,
  };
  const hash = quoteDigest(value);
  const [order] = await database`SELECT o.id,o.rentable_id,r.client_id FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE o.id=${value.orderId}`;
  if (!order) throw new CaseError('BOOKING_NOT_FOUND', 'Booking not found', { status: 404 });
  return withListingInventory(database, order.rentable_id, async (tx) => {
    if (!(await lockActor(tx, actor, order.client_id))) throw new CaseError('BOOKING_NOT_FOUND', 'Booking not found', { status: 404 });
    const [replay] = await tx`SELECT id,reference,order_id,request_hash FROM booking_case WHERE created_by_kind=${actor.kind} AND created_by_id=${actor.id} AND request_key=${value.requestKey}`;
    if (replay) {
      if (replay.request_hash !== hash) throw new CaseError('IDEMPOTENCY_CONFLICT', 'Idempotency conflict', { status: 409 });
      return { id: replay.id, reference: replay.reference, orderId: replay.order_id, replayed: true };
    }
    const visits = await tx`SELECT id FROM booking WHERE order_id=${order.id} AND id IN ${tx(value.visitIds)}`;
    if (visits.length !== value.visitIds.length) {
      throw new CaseError('VISIT_NOT_FOUND', 'Choose visits from this booking.', { status: 422, field: 'visitIds' });
    }
    const id = randomUUID();
    const reference = caseReference(id);
    await tx`INSERT INTO booking_case(id,reference,order_id,type,requester_kind,source,reason,requested_outcome,requested_change,created_by_kind,created_by_id,request_key,request_hash)
      VALUES(${id},${reference},${order.id},${value.type},${value.requesterKind},${value.source},${value.reason},${value.requestedOutcome},
      ${value.requestedChange ? JSON.stringify(value.requestedChange) : null}::text::jsonb,${actor.kind},${actor.id},${value.requestKey},${hash})`;
    for (const visitId of value.visitIds) await tx`INSERT INTO booking_case_visit(case_id,booking_id) VALUES(${id},${visitId})`;
    await tx`INSERT INTO booking_case_update(case_id,kind,audience,body,actor_kind)
      VALUES(${id},'created',${createdAudience(value.requesterKind)},
      ${`${CASE_LABELS[value.type]} request ${reference} received for ${value.visitIds.length} visit${value.visitIds.length === 1 ? '' : 's'}. Rentra will review it; nothing about the booking has changed yet.`},'system')`;
    await audit(tx, actor, id, 'booking_case_opened', { reference, type: value.type, visitIds: value.visitIds, requesterKind: value.requesterKind, source: value.source });
    return { id, reference, orderId: order.id, replayed: false };
  });
}

/* ------------------------------ assign, update ---------------------------- */

const assignSchema = z.object({ caseId: uuid, expectedVersion: z.number().int().min(1), assigneeId: uuid.nullable() }).strict();

export async function assignBookingCase(database, actor, input) {
  requireActor(actor, ['admin']);
  const value = assignSchema.parse(input);
  return database.begin(async (tx) => {
    if (!(await lockActor(tx, actor))) throw new CaseError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const [current] = await tx`SELECT * FROM booking_case WHERE id=${value.caseId} FOR UPDATE`;
    if (!current) throw new CaseError('CASE_NOT_FOUND', 'Case not found', { status: 404 });
    if (current.state !== 'open' || current.version !== value.expectedVersion) throw new CaseError('CASE_CHANGED', 'Case changed', { status: 409 });
    let name = null;
    if (value.assigneeId) {
      [{ name } = {}] = await tx`SELECT name FROM admin_user WHERE id=${value.assigneeId} AND is_active=true`;
      if (!name) throw new CaseError('ASSIGNEE_UNAVAILABLE', 'Choose an active Rentra admin.', { status: 422, field: 'assigneeId' });
    }
    const [updated] = await tx`UPDATE booking_case SET assignee_id=${value.assigneeId},version=version+1,updated_at=clock_timestamp() WHERE id=${current.id} RETURNING version`;
    await tx`INSERT INTO booking_case_update(case_id,kind,audience,body,actor_kind,actor_id)
      VALUES(${current.id},'assigned','internal',${name ? `Assigned to ${name}.` : 'Unassigned.'},'admin',${actor.id})`;
    await audit(tx, actor, current.id, 'booking_case_assigned', { assigneeId: value.assigneeId, version: updated.version }, { assigneeId: current.assignee_id, version: current.version });
    return { id: current.id, orderId: current.order_id, version: updated.version };
  });
}

const updateSchema = z
  .object({ caseId: uuid, audience: z.enum(AUDIENCES).optional(), body: z.string().trim().min(2).max(2000), requestKey: uuid })
  .strict();

/** Admins choose an audience; an owner's message is always between the owner and Rentra. */
export async function addCaseUpdate(database, actor, input) {
  requireActor(actor, ['owner', 'admin']);
  const parsed = updateSchema.parse(input);
  const audience = actor.kind === 'owner' ? 'client' : (parsed.audience ?? 'internal');
  return database.begin(async (tx) => {
    const [current] = await tx`SELECT c.id,c.order_id,c.state,r.client_id FROM booking_case c JOIN booking_order o ON o.id=c.order_id
      JOIN rentable r ON r.id=o.rentable_id WHERE c.id=${parsed.caseId}`;
    if (!current || !(await lockActor(tx, actor, current.client_id))) throw new CaseError('CASE_NOT_FOUND', 'Case not found', { status: 404 });
    if (actor.kind === 'owner' && current.state !== 'open') throw new CaseError('CASE_CHANGED', 'Case changed', { status: 409 });
    const [replay] = await tx`SELECT id FROM booking_case_update WHERE case_id=${current.id} AND actor_kind=${actor.kind} AND actor_id=${actor.id} AND request_key=${parsed.requestKey}`;
    if (replay) return { id: replay.id, orderId: current.order_id, replayed: true };
    const [row] = await tx`INSERT INTO booking_case_update(case_id,kind,audience,body,actor_kind,actor_id,request_key)
      VALUES(${current.id},'message',${audience},${parsed.body},${actor.kind},${actor.id},${parsed.requestKey}) RETURNING id`;
    return { id: row.id, orderId: current.order_id, replayed: false };
  });
}

/* ----------------------------- preview, resolve --------------------------- */

/** The effects of cancelling a case's visits right now, under the listing lock. */
async function casePlan(tx, current, basis) {
  const [{ now }] = await tx`SELECT clock_timestamp() now`;
  const visits = await tx`SELECT b.* FROM booking_case_visit cv JOIN booking b ON b.id=cv.booking_id
    WHERE cv.case_id=${current.id} ORDER BY b.item_position NULLS LAST,b.day,b.id`;
  const allocations = await capturedAllocations(tx, visits.map((v) => v.id));
  const plans = visits.map((visit) => {
    const base = { id: visit.id, reference: visit.reference, date: day(visit.local_day ?? visit.day), slot: visit.slot, state: visit.state, provenance: visit.visit_provenance };
    const reason = uncancellableReason(visit, now);
    if (reason) return { ...base, action: 'unchanged', reason, refundMinor: 0, refunds: [] };
    let entitlement;
    try {
      entitlement = caseEntitlement(visit, basis, now);
    } catch {
      return { ...base, action: 'blocked', reason: 'The accepted policy cannot be applied to this visit; choose a full refund.', refundMinor: 0, refunds: [] };
    }
    const sources = allocations.filter((a) => a.booking_id === visit.id);
    if (sources.length && !testSourcesOnly(sources)) {
      return { ...base, action: 'blocked', reason: 'This payment is outside the Test environment; its refund needs the live refund process.', refundMinor: 0, refunds: [] };
    }
    const refunds = sources.length ? allocateRefund(sources, entitlement) : [];
    return {
      ...base,
      action: 'cancel',
      paid: sources.length > 0,
      rate: entitlement.rate,
      releasedStartAt: instant(visit.blocked_start_at),
      releasedEndAt: instant(visit.blocked_end_at),
      refundMinor: refunds.reduce((sum, a) => sum + a.amount, 0),
      refundByComponent: Object.fromEntries(['rent', 'fee', 'deposit'].map((c) => [c, refunds.filter((a) => a.component === c).reduce((sum, a) => sum + a.amount, 0)])),
      refunds,
    };
  });
  const cancelling = new Set(plans.filter((p) => p.action === 'cancel').map((p) => p.id));
  const [{ remaining }] = await tx`SELECT count(*)::int remaining FROM booking WHERE order_id=${current.order_id} AND state<>'cancelled'
    AND NOT (id = ANY(${[...cancelling]}::uuid[]))`;
  const result = {
    caseId: current.id,
    version: current.version,
    basis,
    visits: plans,
    cancelCount: cancelling.size,
    blocked: plans.some((p) => p.action === 'blocked'),
    refundMinor: plans.reduce((sum, p) => sum + p.refundMinor, 0),
    orderAfter: cancelling.size && remaining === 0 ? 'cancelled' : 'unchanged',
    remainingVisits: remaining,
    environment: 'test',
    actualBankRefundMinor: 0,
  };
  return { result, hash: quoteDigest(result) };
}

const publicPlan = (result) => ({ ...result, visits: result.visits.map(({ refunds: _refunds, ...visit }) => visit) });

const REPLACEMENT_NOTE =
  'Nothing is reserved. A change is a cancellation followed by a new booking: the customer books the new dates through Book again, at the availability and price at that time.';

async function loadCase(database, caseId) {
  if (!uuid.safeParse(caseId).success) throw new CaseError('CASE_NOT_FOUND', 'Case not found', { status: 404 });
  const [current] = await database`SELECT c.*,o.rentable_id,o.customer_id,r.client_id FROM booking_case c JOIN booking_order o ON o.id=c.order_id
    JOIN rentable r ON r.id=o.rentable_id WHERE c.id=${caseId}`;
  if (!current) throw new CaseError('CASE_NOT_FOUND', 'Case not found', { status: 404 });
  return current;
}

const previewSchema = z.object({ caseId: uuid, basis: z.enum(REFUND_BASES) }).strict();

export async function previewCaseResolution(database, actor, input, env = process.env) {
  requireActor(actor, ['admin']);
  const value = previewSchema.parse(input);
  const current = await loadCase(database, value.caseId);
  const planned = await withListingInventory(database, current.rentable_id, async (tx) => {
    if (!(await lockActor(tx, actor))) throw new CaseError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const [fresh] = await tx`SELECT * FROM booking_case WHERE id=${current.id}`;
    if (fresh.state !== 'open') throw new CaseError('CASE_CHANGED', 'Case changed', { status: 409 });
    return casePlan(tx, fresh, value.basis);
  });
  let replacement = null;
  if (current.requested_change) {
    const change = current.requested_change;
    try {
      const quote = await previewBookingQuote(database, { rentableId: current.rentable_id, ...change }, env);
      replacement = { ...change, available: true, totalMinor: quote.totals.totalMinor, reserved: false, note: REPLACEMENT_NOTE };
    } catch (error) {
      replacement = { ...change, available: false, reason: error.message || 'Not available', reserved: false, note: REPLACEMENT_NOTE };
    }
  }
  return { preview: publicPlan(planned.result), hash: planned.hash, replacement };
}

const resolveSchema = z
  .object({
    caseId: uuid,
    expectedVersion: z.number().int().min(1),
    outcome: z.enum(['visits_cancelled', 'declined', 'no_change']),
    basis: z.enum(REFUND_BASES).nullable().default(null),
    hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
    note: z.string().trim().min(10).max(1000),
    audience: z.enum(AUDIENCES),
    requestKey: uuid,
  })
  .strict()
  .refine((v) => v.outcome !== 'visits_cancelled' || (v.basis && v.hash), { message: 'Preview the cancellation first.', path: ['hash'] });

/** Resolve once. A cancellation must match the current preview exactly; a repeat with the same key returns the first result. */
export async function resolveBookingCase(database, actor, input) {
  requireActor(actor, ['admin']);
  const value = resolveSchema.parse(input);
  const requestHash = quoteDigest(value);
  const current = await loadCase(database, value.caseId);
  return withListingInventory(database, current.rentable_id, async (tx) => {
    if (!(await lockActor(tx, actor))) throw new CaseError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const [fresh] = await tx`SELECT * FROM booking_case WHERE id=${current.id} FOR UPDATE`;
    const done = { id: fresh.id, reference: fresh.reference, orderId: fresh.order_id };
    if (fresh.state === 'resolved') {
      if (fresh.resolve_key === value.requestKey && fresh.resolve_hash === requestHash) {
        return { ...done, outcome: fresh.outcome, cancellationId: fresh.cancellation_id, replayed: true };
      }
      throw new CaseError('CASE_CHANGED', 'Case changed', { status: 409 });
    }
    if (fresh.version !== value.expectedVersion) throw new CaseError('CASE_CHANGED', 'Case changed', { status: 409 });
    let cancellationId = null,
      refundIds = [];
    if (value.outcome === 'visits_cancelled') {
      const planned = await casePlan(tx, fresh, value.basis);
      if (planned.hash !== value.hash) throw new CaseError('PREVIEW_CHANGED', 'The effects changed since the preview.', { status: 409 });
      if (planned.result.blocked) throw new CaseError('PREVIEW_BLOCKED', 'Some visits cannot use this refund basis.', { status: 422, field: 'basis' });
      const cancelling = planned.result.visits.filter((v) => v.action === 'cancel');
      if (!cancelling.length) throw new CaseError('NOTHING_TO_CANCEL', 'None of these visits can be cancelled now.', { status: 422, field: 'outcome' });
      cancellationId = randomUUID();
      refundIds = await createRefundObligations(tx, cancelling, {
        reason: `Rentra booking case ${fresh.reference} (${value.basis} refund)`,
        idempotencyKey: cancellationId,
        requestHash,
      });
      const ids = cancelling.map((v) => v.id);
      const changed = await tx`UPDATE booking SET state='cancelled',cancelled_at=clock_timestamp(),cancelled_by=NULL,
        cancellation_reason=${`Rentra booking case ${fresh.reference}`},lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp()
        WHERE id IN ${tx(ids)} AND state='confirmed' AND starts_at>clock_timestamp() RETURNING id`;
      if (changed.length !== ids.length) throw new CaseError('PREVIEW_CHANGED', 'The effects changed since the preview.', { status: 409 });
      await tx`UPDATE inventory_reservation SET state='released',released_at=clock_timestamp() WHERE booking_id IN ${tx(ids)} AND state='committed'`;
      await tx`UPDATE booking_order SET state='cancelled',updated_at=clock_timestamp() WHERE id=${fresh.order_id}
        AND NOT EXISTS(SELECT 1 FROM booking WHERE order_id=${fresh.order_id} AND state<>'cancelled')`;
      const snapshot = { ...publicPlan(planned.result), id: cancellationId, refundIds, caseId: fresh.id, caseReference: fresh.reference, cancelledAt: new Date().toISOString() };
      await tx`INSERT INTO booking_cancellation(id,order_id,customer_id,idempotency_key,request_hash,snapshot)
        VALUES(${cancellationId},${fresh.order_id},${current.customer_id},${cancellationId},${requestHash},${JSON.stringify(snapshot)}::text::jsonb)`;
      // The existing lifecycle event sends the customer's cancellation notice.
      await lifecycle(tx, fresh.order_id, 'cancel_' + cancellationId.replaceAll('-', ''), {
        cancellationId,
        caseId: fresh.id,
        visitIds: ids,
        refundIds,
        environment: 'test',
        actualBankRefundMinor: 0,
      });
    }
    const [resolved] = await tx`UPDATE booking_case SET state='resolved',outcome=${value.outcome},outcome_note=${value.note},
      refund_basis=${value.outcome === 'visits_cancelled' ? value.basis : null},cancellation_id=${cancellationId},resolved_at=clock_timestamp(),
      resolved_by=${actor.id},resolve_key=${value.requestKey},resolve_hash=${requestHash},version=version+1,updated_at=clock_timestamp()
      WHERE id=${fresh.id} RETURNING version`;
    await tx`INSERT INTO booking_case_update(case_id,kind,audience,body,actor_kind,actor_id)
      VALUES(${fresh.id},'resolved',${value.audience},${`${OUTCOME_LABELS[value.outcome]}. ${value.note}`},'admin',${actor.id})`;
    await audit(tx, actor, fresh.id, 'booking_case_resolved', { outcome: value.outcome, basis: value.basis, cancellationId, refundIds, version: resolved.version }, { state: 'open', version: fresh.version });
    return { ...done, outcome: value.outcome, cancellationId, refundIds, version: resolved.version, replayed: false };
  });
}

/* ---------------------------------- reads --------------------------------- */

const listSchema = z.object({
  state: z.enum(['open', 'resolved', 'all']).catch('open'),
  type: z.enum([...CASE_TYPES, 'all']).catch('all'),
  assigned: z.enum(['me', 'unassigned', 'all']).catch('all'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(999999).catch(1),
});

export async function listBookingCases(database, actor, input = {}) {
  requireActor(actor, ['admin']);
  const filters = listSchema.parse({ state: 'open', type: 'all', assigned: 'all', q: '', page: 1, ...input });
  const size = 20;
  return database.begin(async (tx) => {
    if (!(await lockActor(tx, actor))) throw new CaseError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const where = tx`(${filters.state}='all' OR c.state=${filters.state}) AND (${filters.type}='all' OR c.type=${filters.type})
      AND (${filters.assigned}='all' OR (${filters.assigned}='me' AND c.assignee_id=${actor.id}) OR (${filters.assigned}='unassigned' AND c.assignee_id IS NULL))
      AND (${filters.q}='' OR position(lower(${filters.q}) in lower(c.reference))>0 OR position(lower(${filters.q}) in lower(o.reference))>0
        OR position(lower(${filters.q}) in lower(coalesce(o.listing_snapshot->>'title','')))>0)`;
    const [counts] = await tx`SELECT count(*) FILTER (WHERE ${where})::int total,
      count(*) FILTER (WHERE c.state='open')::int open, count(*) FILTER (WHERE c.state='open' AND c.assignee_id IS NULL)::int unassigned,
      count(*) FILTER (WHERE c.state='open' AND c.assignee_id=${actor.id})::int mine
      FROM booking_case c JOIN booking_order o ON o.id=c.order_id`;
    const pages = Math.max(1, Math.ceil(counts.total / size)),
      page = Math.min(filters.page, pages);
    const rows = await tx`SELECT c.id,c.reference,c.type,c.state,c.outcome,c.requester_kind,c.created_at,c.updated_at,o.id order_id,o.reference order_reference,
      o.listing_snapshot->>'title' title,a.name assignee_name,(SELECT count(*)::int FROM booking_case_visit v WHERE v.case_id=c.id) visit_count
      FROM booking_case c JOIN booking_order o ON o.id=c.order_id LEFT JOIN admin_user a ON a.id=c.assignee_id
      WHERE ${where} ORDER BY c.state='open' DESC,c.created_at ASC,c.id LIMIT ${size} OFFSET ${(page - 1) * size}`;
    return {
      ...filters,
      page,
      pages,
      total: counts.total,
      summary: { open: counts.open, unassigned: counts.unassigned, mine: counts.mine },
      items: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        type: r.type,
        state: r.state,
        outcome: r.outcome,
        requesterKind: r.requester_kind,
        createdAt: instant(r.created_at),
        updatedAt: instant(r.updated_at),
        orderId: r.order_id,
        orderReference: r.order_reference,
        title: r.title || 'Booked property',
        assigneeName: r.assignee_name,
        visitCount: r.visit_count,
      })),
    };
  });
}

const updateDTO = (row, viewer) => ({
  id: row.id,
  kind: row.kind,
  audience: row.audience,
  body: row.body,
  at: instant(row.created_at),
  author: row.actor_kind === 'system' ? 'Rentra' : row.actor_kind === 'owner' ? (viewer === 'owner' ? 'You' : `Owner${row.author_name ? ` · ${row.author_name}` : ''}`) : viewer === 'admin' ? `Admin${row.author_name ? ` · ${row.author_name}` : ''}` : 'Rentra operations',
});

async function updatesFor(tx, caseIds) {
  if (!caseIds.length) return [];
  return tx`SELECT u.*,CASE u.actor_kind WHEN 'owner' THEN (SELECT name FROM "user" WHERE id=u.actor_id) WHEN 'admin' THEN (SELECT name FROM admin_user WHERE id=u.actor_id) END author_name
    FROM booking_case_update u WHERE u.case_id = ANY(${caseIds}::uuid[]) ORDER BY u.created_at,u.id`;
}

export async function readBookingCase(database, actor, caseId) {
  requireActor(actor, ['admin']);
  if (!uuid.safeParse(caseId).success) throw new CaseError('CASE_NOT_FOUND', 'Case not found', { status: 404 });
  return database.begin(async (tx) => {
    if (!(await lockActor(tx, actor))) throw new CaseError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const [c] = await tx`SELECT c.*,o.reference order_reference,o.state order_state,o.listing_snapshot->>'title' title,o.policy_snapshot->>'cancellationTier' tier,
      o.rentable_id,u.name customer_name,a.name assignee_name,rb.name resolved_by_name,
      CASE c.created_by_kind WHEN 'owner' THEN (SELECT name FROM "user" WHERE id=c.created_by_id) ELSE (SELECT name FROM admin_user WHERE id=c.created_by_id) END created_by_name,
      bc.snapshot cancellation
      FROM booking_case c JOIN booking_order o ON o.id=c.order_id JOIN "user" u ON u.id=o.customer_id
      LEFT JOIN admin_user a ON a.id=c.assignee_id LEFT JOIN admin_user rb ON rb.id=c.resolved_by LEFT JOIN booking_cancellation bc ON bc.id=c.cancellation_id
      WHERE c.id=${caseId}`;
    if (!c) throw new CaseError('CASE_NOT_FOUND', 'Case not found', { status: 404 });
    const visits = await tx`SELECT b.id,b.reference,b.state,b.local_day,b.day,b.slot,b.guests,b.starts_at,b.ends_at,b.hours_known,b.visit_provenance,
      b.amount_rent_minor,b.amount_fee_minor,b.amount_deposit_minor,b.cancellation_reason,
      (SELECT count(*)::int FROM visit_evidence e WHERE e.booking_id=b.id) evidence_count,
      (SELECT count(*)::int FROM visit_incident i WHERE i.booking_id=b.id AND i.state='open') open_incidents,
      (SELECT count(*)::int FROM visit_attachment x WHERE x.booking_id=b.id) photo_count
      FROM booking_case_visit cv JOIN booking b ON b.id=cv.booking_id WHERE cv.case_id=${c.id} ORDER BY b.item_position NULLS LAST,b.day,b.id`;
    const admins = await tx`SELECT id,name FROM admin_user WHERE is_active=true ORDER BY name,id`;
    const updates = await updatesFor(tx, [c.id]);
    return {
      id: c.id,
      reference: c.reference,
      type: c.type,
      typeLabel: CASE_LABELS[c.type],
      state: c.state,
      outcome: c.outcome,
      outcomeLabel: c.outcome ? OUTCOME_LABELS[c.outcome] : null,
      outcomeNote: c.outcome_note,
      refundBasis: c.refund_basis,
      defaultBasis: defaultRefundBasis(c.type),
      version: c.version,
      requesterKind: c.requester_kind,
      source: c.source,
      reason: c.reason,
      requestedOutcome: c.requested_outcome,
      requestedChange: c.requested_change,
      createdBy: `${c.created_by_kind === 'owner' ? 'Owner' : 'Admin'}${c.created_by_name ? ` · ${c.created_by_name}` : ''}`,
      createdAt: instant(c.created_at),
      updatedAt: instant(c.updated_at),
      resolvedAt: instant(c.resolved_at),
      resolvedBy: c.resolved_by_name,
      assignee: c.assignee_id ? { id: c.assignee_id, name: c.assignee_name } : null,
      order: { id: c.order_id, reference: c.order_reference, state: c.order_state, title: c.title || 'Booked property', cancellationTier: c.tier, customerName: c.customer_name, propertyId: c.rentable_id },
      cancellation: c.cancellation
        ? { id: c.cancellation.id, refundMinor: c.cancellation.refundMinor, refundCount: c.cancellation.refundIds?.length ?? 0, visitIds: c.cancellation.visits?.filter((v) => v.action === 'cancel').map((v) => v.id) ?? [] }
        : null,
      visits: visits.map((v) => ({
        id: v.id,
        reference: v.reference,
        state: v.state,
        date: day(v.local_day ?? v.day),
        slot: v.slot,
        guests: v.guests,
        startsAt: v.hours_known ? instant(v.starts_at) : null,
        endsAt: v.hours_known ? instant(v.ends_at) : null,
        provenance: v.visit_provenance,
        rentMinor: Number(v.amount_rent_minor),
        feeMinor: Number(v.amount_fee_minor),
        depositMinor: Number(v.amount_deposit_minor),
        cancellationReason: v.cancellation_reason,
        evidenceCount: v.evidence_count,
        openIncidents: v.open_incidents,
        photoCount: v.photo_count,
      })),
      admins: admins.map((a) => ({ id: a.id, name: a.name })),
      updates: updates.map((u) => updateDTO(u, 'admin')),
    };
  });
}

/** Cases on one order for the booking record, filtered to what this viewer may read. */
export async function casesForOrder(tx, orderId, viewer) {
  const cases = await tx`SELECT c.id,c.reference,c.type,c.state,c.outcome,c.created_by_kind,c.created_at,c.version,a.name assignee_name,
    (SELECT array_agg(booking_id::text) FROM booking_case_visit WHERE case_id=c.id) visit_ids
    FROM booking_case c LEFT JOIN admin_user a ON a.id=c.assignee_id WHERE c.order_id=${orderId} ORDER BY c.created_at,c.id`;
  const updates = await updatesFor(tx, cases.map((c) => c.id));
  return cases
    .map((c) => {
      const visible = updates.filter((u) => u.case_id === c.id && visibleTo(viewer, u.audience)).map((u) => updateDTO(u, viewer));
      return {
        id: c.id,
        reference: c.reference,
        type: c.type,
        typeLabel: CASE_LABELS[c.type],
        state: c.state,
        outcome: c.outcome,
        outcomeLabel: c.outcome ? OUTCOME_LABELS[c.outcome] : null,
        createdAt: instant(c.created_at),
        visitIds: c.visit_ids ?? [],
        ...(viewer === 'admin' ? { assigneeName: c.assignee_name, version: c.version } : {}),
        ...(viewer === 'owner' ? { requestedByYou: c.created_by_kind === 'owner' } : {}),
        updates: visible,
        _show: viewer === 'admin' || (viewer === 'owner' && c.created_by_kind === 'owner') || visible.length > 0,
      };
    })
    .filter((c) => c._show)
    .map(({ _show, ...c }) => (viewer === 'customer' ? { reference: c.reference, state: c.state, updates: c.updates } : c));
}
