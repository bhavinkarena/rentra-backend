import 'server-only';
import { z } from 'zod';
import { withListingInventory } from '../booking/inventory.js';
import { capturedAllocations, createRefundObligations, testSourcesOnly } from '../booking/cancellation.js';
import { quoteDigest } from '../booking/quotes.js';
import { allocateAdditionalRefund, PROVIDER_FAILED, refundStatus } from '../domain/refund-status.js';
import { reconcileRefund } from './refunds.js';

/**
 * CP20 refund operations. Read models come from refund obligations and their
 * allocations; money is aggregated per refund before any totals and
 * environments are never summed together. Commands:
 *   · request an additional refund of a visit's remaining verified capture,
 *     previewed and hash-guarded, under the listing lock that every refund
 *     writer takes, so concurrent requests cannot exceed the captured funds;
 *   · send or check an existing obligation with the provider, through the
 *     single-dispatch engine: a refund is POSTed at most once, and every
 *     later call only looks it up.
 */
export class RefundOperationError extends Error {
  constructor(code, message = code, status = 400, field = null) {
    super(message);
    this.name = 'RefundOperationError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const uuid = z.string().uuid();
const n = (value) => Number(value ?? 0);
const instant = (value) => (value ? new Date(value).toISOString() : null);
export const OPERATOR_REASON = 'Rentra operator refund';

async function requireAdmin(tx, actor) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success)
    throw new RefundOperationError('OPERATOR_REQUIRED', 'Operator required', 403);
  const [row] = await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
  if (!row) throw new RefundOperationError('OPERATOR_REQUIRED', 'Operator required', 403);
}

/** One row per refund obligation with its payment, booking and execution. */
function ledger(tx) {
  return tx`SELECT r.id,r.reference,r.provider,r.environment::text environment,r.mode::text mode,r.currency,
      r.state::text state,r.reason,r.expected_minor,r.actual_minor,r.provider_refund_id,r.created_at,r.completed_at,r.verified_at,
      x.dispatched_at,x.next_check_at,x.failure_code,
      t.provider_payment_id,a.payment_order_id,b.id order_id,b.reference booking_reference,b.rentable_id,
      b.listing_snapshot->>'title' title,
      CASE WHEN r.reason LIKE 'Rentra booking case %' THEN 'booking_case'
        WHEN r.reason='Customer visit cancellation' THEN 'customer_cancellation'
        WHEN r.reason LIKE 'Capture after inventory expiry%' THEN 'late_capture'
        WHEN r.reason LIKE ${OPERATOR_REASON + '%'} THEN 'operator' ELSE 'other' END source
    FROM refund r JOIN payment_transaction t ON t.id=r.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id
    JOIN payment_order p ON p.id=a.payment_order_id JOIN booking_order b ON b.id=p.booking_order_id
    LEFT JOIN refund_execution x ON x.refund_id=r.id`;
}

const statusOf = (l) =>
  refundStatus({
    provider: l.provider,
    environment: l.environment,
    mode: l.mode,
    state: l.state,
    dispatchedAt: l.dispatched_at,
    failureCode: l.failure_code,
  });

/** SQL twin of refundStatus keys, so filters and counts agree with the badges. */
const statusSql = (tx) => tx`CASE WHEN l.mode='simulated' THEN 'simulated' WHEN l.state='succeeded' THEN 'refunded'
  WHEN NOT (l.provider='razorpay' AND l.environment='test' AND l.mode='real') THEN 'unsupported'
  WHEN l.state='requested' AND l.dispatched_at IS NULL THEN 'queued'
  WHEN l.failure_code=${PROVIDER_FAILED} THEN 'provider_failed'
  WHEN l.state='unknown' OR l.failure_code IS NOT NULL THEN 'uncertain' ELSE 'processing' END`;

const STATUSES = ['queued', 'processing', 'uncertain', 'provider_failed', 'refunded', 'unsupported', 'simulated'];
const listSchema = z.object({
  environment: z.enum(['test', 'simulated', 'live', 'all']).catch('test'),
  status: z.enum(['all', 'attention', ...STATUSES]).catch('all'),
  source: z.enum(['all', 'customer_cancellation', 'booking_case', 'late_capture', 'operator', 'other']).catch('all'),
  q: z.string().trim().max(100).catch(''),
  page: z.coerce.number().int().min(1).max(999999).catch(1),
});

function item(l) {
  return {
    id: l.id,
    reference: l.reference,
    environment: l.mode === 'simulated' ? 'simulated' : l.environment,
    source: l.source,
    reason: l.reason,
    expectedMinor: n(l.expected_minor),
    actualMinor: n(l.actual_minor),
    providerRefundId: l.provider_refund_id,
    orderId: l.order_id,
    bookingReference: l.booking_reference,
    title: l.title || 'Booked property',
    paymentOrderId: l.payment_order_id,
    createdAt: instant(l.created_at),
    completedAt: instant(l.completed_at),
    execution: { dispatchedAt: instant(l.dispatched_at), nextCheckAt: instant(l.next_check_at), failureCode: l.failure_code },
    status: statusOf(l),
  };
}

export async function listRefunds(database, actor, input = {}) {
  const f = listSchema.parse({ environment: 'test', status: 'all', source: 'all', q: '', page: 1, ...input });
  const size = 25;
  return database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const env = tx`CASE WHEN l.mode='simulated' THEN 'simulated' ELSE l.environment END`;
    const attention = tx`${statusSql(tx)} IN ('uncertain','provider_failed','unsupported')`;
    const where = tx`(${f.environment}='all' OR ${env}=${f.environment})
      AND (${f.status}='all' OR (${f.status}='attention' AND ${attention}) OR ${statusSql(tx)}=${f.status})
      AND (${f.source}='all' OR l.source=${f.source})
      AND (${f.q}='' OR position(lower(${f.q}) in lower(l.reference))>0 OR position(lower(${f.q}) in lower(l.booking_reference))>0
        OR l.provider_refund_id=${f.q} OR l.id::text=${f.q})`;
    const totals = await tx`WITH l AS (${ledger(tx)}) SELECT ${env} environment,count(*)::int count,
        sum(l.expected_minor)::text expected,sum(l.actual_minor) FILTER (WHERE l.state='succeeded')::text refunded,
        sum(l.expected_minor) FILTER (WHERE l.state<>'succeeded')::text pending,
        count(*) FILTER (WHERE ${attention})::int attention
      FROM l WHERE ${where} GROUP BY 1 ORDER BY 1`;
    const total = totals.reduce((sum, t) => sum + t.count, 0);
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(f.page, pages);
    const rows = await tx`WITH l AS (${ledger(tx)}) SELECT l.* FROM l WHERE ${where}
      ORDER BY l.created_at DESC,l.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`;
    return {
      ...f,
      page,
      pages,
      total,
      asOf: new Date().toISOString(),
      totals: totals.map((t) => ({
        environment: t.environment,
        count: t.count,
        expectedMinor: n(t.expected),
        refundedMinor: n(t.refunded),
        pendingMinor: n(t.pending),
        attention: t.attention,
      })),
      items: rows.map(item),
    };
  });
}

export async function readRefund(database, actor, id) {
  if (!uuid.safeParse(id).success) throw new RefundOperationError('REFUND_NOT_FOUND', 'Not found', 404);
  return database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const [l] = await tx`WITH l AS (${ledger(tx)}) SELECT l.* FROM l WHERE l.id=${id}`;
    if (!l) throw new RefundOperationError('REFUND_NOT_FOUND', 'Not found', 404);
    const allocations = await tx`SELECT ra.*,b.reference visit_reference,b.state visit_state,pa.actual_minor captured_minor
      FROM refund_allocation ra JOIN booking b ON b.id=ra.booking_id JOIN payment_allocation pa ON pa.id=ra.payment_allocation_id
      WHERE ra.refund_id=${id} ORDER BY b.item_position NULLS LAST,ra.component`;
    const [cancellation] = await tx`SELECT id,created_at,snapshot->>'caseId' case_id,snapshot->>'caseReference' case_reference
      FROM booking_cancellation WHERE order_id=${l.order_id} AND snapshot->'refundIds' ? ${id}`;
    const [requested] = await tx`SELECT a.at,a.reason,a.after,x.name FROM audit_log a LEFT JOIN admin_user x ON x.id=a.actor_id
      WHERE a.entity='refund' AND a.entity_id=${id} AND a.action='refund_requested' LIMIT 1`;
    const events = await tx`SELECT id,external_event_id,state::text state,attempts,failure_code,received_at,processed_at,
        redacted_payload->>'type' type FROM payment_event
      WHERE provider='razorpay' AND environment='test' AND redacted_payload->>'receipt'=${id} ORDER BY received_at,id`;
    const history = await tx`SELECT kind,created_at FROM booking_lifecycle_event WHERE order_id=${l.order_id}
      AND (kind=${'refund_' + id.replaceAll('-', '')} OR kind='refund_required' OR kind LIKE 'cancel\\_%') ORDER BY created_at,id`;
    const commands = await tx`SELECT a.at,a.after,x.name FROM audit_log a LEFT JOIN admin_user x ON x.id=a.actor_id
      WHERE a.entity='refund' AND a.entity_id=${id} AND a.action='refund_reconcile_requested' ORDER BY a.at DESC LIMIT 20`;
    const siblings = await tx`WITH l AS (${ledger(tx)}) SELECT l.* FROM l WHERE l.payment_order_id=${l.payment_order_id} AND l.id<>${id}
      ORDER BY l.created_at`;
    return {
      ...item(l),
      providerPaymentId: l.provider_payment_id,
      verifiedAt: instant(l.verified_at),
      booking: { id: l.order_id, reference: l.booking_reference, title: l.title || 'Booked property', propertyId: l.rentable_id },
      allocations: allocations.map((a) => ({
        visitReference: a.visit_reference,
        visitState: a.visit_state,
        component: a.component,
        capturedMinor: n(a.captured_minor),
        expectedMinor: n(a.expected_minor),
        actualMinor: n(a.actual_minor),
      })),
      origin: cancellation
        ? {
            kind: cancellation.case_id ? 'booking_case' : 'customer_cancellation',
            cancellationId: cancellation.id,
            caseId: cancellation.case_id,
            caseReference: cancellation.case_reference,
            at: instant(cancellation.created_at),
          }
        : requested
          ? { kind: 'operator', by: requested.name, reason: requested.reason, at: instant(requested.at), visit: requested.after?.visitReference ?? null }
          : { kind: l.source },
      events: events.map((e) => ({ id: e.id, externalEventId: e.external_event_id, type: e.type, state: e.state, attempts: e.attempts, failureCode: e.failure_code, receivedAt: instant(e.received_at), processedAt: instant(e.processed_at) })),
      history: history.map((h) => ({ kind: /^cancel_/.test(h.kind) ? 'visits_cancelled' : h.kind === 'refund_required' ? 'refund_required' : 'refund_processed', at: instant(h.created_at) })),
      commands: commands.map((c) => ({ at: instant(c.at), by: c.name, outcome: c.after?.outcome ?? null, code: c.after?.code ?? null, stateAfter: c.after?.stateAfter ?? null })),
      siblings: siblings.map(item),
    };
  });
}

/* ------------------------------ operator refund ----------------------------- */

const amount = z.coerce.number().int().min(0).max(100000000);
const previewSchema = z.object({
  orderId: uuid,
  visitId: uuid,
  rent: amount.default(0),
  fee: amount.default(0),
  deposit: amount.default(0),
});

/** Captured, verified-refunded, pending and remaining per component for one visit. */
async function planRefund(tx, value) {
  const [visit] = await tx`SELECT b.id,b.reference,b.state,b.order_id,o.rentable_id FROM booking b JOIN booking_order o ON o.id=b.order_id
    WHERE b.id=${value.visitId} AND b.order_id=${value.orderId}`;
  if (!visit) throw new RefundOperationError('VISIT_NOT_FOUND', 'Choose a visit from this booking.', 404);
  const sources = await capturedAllocations(tx, [visit.id]);
  const verified = await tx`SELECT pa.component,coalesce(sum(ra.actual_minor),0)::text refunded FROM refund_allocation ra
    JOIN refund r ON r.id=ra.refund_id JOIN payment_allocation pa ON pa.id=ra.payment_allocation_id
    WHERE ra.booking_id=${visit.id} AND r.state='succeeded' GROUP BY pa.component`;
  const requested = { rent: value.rent, fee: value.fee, deposit: value.deposit };
  const { lines, exceeded } = allocateAdditionalRefund(sources, requested);
  const components = ['rent', 'fee', 'deposit'].map((component) => {
    const own = sources.filter((s) => s.component === component);
    const captured = own.reduce((sum, s) => sum + n(s.actual_minor), 0);
    const reserved = own.reduce((sum, s) => sum + n(s.reserved), 0);
    const refunded = n(verified.find((v) => v.component === component)?.refunded);
    return {
      component,
      capturedMinor: captured,
      refundedMinor: refunded,
      pendingMinor: reserved - refunded,
      remainingMinor: Math.max(0, captured - reserved),
      requestedMinor: requested[component],
    };
  });
  const blocked = !sources.length
    ? 'This visit has no verified captured payment to refund.'
    : !testSourcesOnly(sources)
      ? 'This payment is outside the Razorpay Test environment; it needs the live refund process.'
      : Object.keys(exceeded).length
        ? `The request exceeds what remains refundable: ${Object.entries(exceeded).map(([c, left]) => `${c} ₹${(left / 100).toFixed(2)}`).join(', ')}.`
        : !lines.length
          ? 'Enter an amount to refund.'
          : null;
  const result = {
    orderId: value.orderId,
    visit: { id: visit.id, reference: visit.reference, state: visit.state },
    components,
    refundMinor: lines.reduce((sum, line) => sum + line.amount, 0),
    obligations: [...new Set(lines.map((line) => line.transactionId))].length,
    blocked,
  };
  return { rentableId: visit.rentable_id, lines, result: { ...result, hash: quoteDigest(result) } };
}

/** The order's visits with what remains refundable, for choosing what to preview. */
export async function refundableVisits(database, actor, orderId) {
  if (!uuid.safeParse(orderId).success) throw new RefundOperationError('ORDER_NOT_FOUND', 'Not found', 404);
  return database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const [order] = await tx`SELECT id,reference,listing_snapshot->>'title' title FROM booking_order WHERE id=${orderId}`;
    if (!order) throw new RefundOperationError('ORDER_NOT_FOUND', 'Not found', 404);
    const visits = await tx`SELECT id,reference,state,local_day,day FROM booking WHERE order_id=${orderId} ORDER BY item_position NULLS LAST,day,id`;
    const sources = visits.length ? await capturedAllocations(tx, visits.map((v) => v.id)) : [];
    return {
      orderId,
      reference: order.reference,
      title: order.title || 'Booked property',
      testOnly: sources.length > 0 && testSourcesOnly(sources),
      visits: visits.map((v) => {
        const own = sources.filter((s) => s.booking_id === v.id);
        return {
          id: v.id,
          reference: v.reference,
          state: v.state,
          date: String((v.local_day ?? v.day) instanceof Date ? (v.local_day ?? v.day).toISOString() : (v.local_day ?? v.day)).slice(0, 10),
          capturedMinor: own.reduce((sum, s) => sum + n(s.actual_minor), 0),
          remainingMinor: own.reduce((sum, s) => sum + Math.max(0, n(s.actual_minor) - n(s.reserved)), 0),
        };
      }),
    };
  });
}

export async function previewOperatorRefund(database, actor, input) {
  const value = previewSchema.parse(input ?? {});
  return database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    return (await planRefund(tx, value)).result;
  });
}

const requestSchema = previewSchema.extend({
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(120),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  requestKey: uuid,
});

/**
 * Records new refund obligations for exactly the previewed lines. The listing
 * lock serialises this with cancellations, cases and other operator refunds,
 * and the plan is recomputed under it: a stale preview or a concurrent request
 * that used the funds first gets PREVIEW_CHANGED, never an over-refund.
 */
export async function requestOperatorRefund(database, actor, input) {
  const value = requestSchema.parse(input ?? {});
  const requestHash = quoteDigest({ ...value, requestKey: undefined });
  const [order] = await database`SELECT rentable_id FROM booking_order WHERE id=${value.orderId}`;
  if (!order) throw new RefundOperationError('VISIT_NOT_FOUND', 'Choose a visit from this booking.', 404);
  return withListingInventory(database, order.rentable_id, async (tx) => {
    await requireAdmin(tx, actor);
    const replay = await tx`SELECT id,request_hash FROM refund WHERE idempotency_key=${value.requestKey} AND reason LIKE ${OPERATOR_REASON + '%'}`;
    if (replay.length) {
      if (replay.some((r) => r.request_hash !== requestHash))
        throw new RefundOperationError('IDEMPOTENCY_CONFLICT', 'This request key was already used for a different refund.', 409);
      return { refundIds: replay.map((r) => r.id), replayed: true };
    }
    const plan = await planRefund(tx, value);
    if (plan.result.hash !== value.hash)
      throw new RefundOperationError('PREVIEW_CHANGED', 'The refundable amounts changed since the preview. Preview again.', 409);
    if (plan.result.blocked) throw new RefundOperationError('REFUND_BLOCKED', plan.result.blocked, 422);
    const refundIds = await createRefundObligations(tx, [{ id: value.visitId, refunds: plan.lines }], {
      reason: `${OPERATOR_REASON}: ${value.reason}`.slice(0, 160),
      idempotencyKey: value.requestKey,
      requestHash,
    });
    for (const refundId of refundIds)
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,after,reason)
        VALUES('admin',${actor.id},'refund',${refundId},'refund_requested',
          ${JSON.stringify({ orderId: value.orderId, visitId: value.visitId, visitReference: plan.result.visit.reference, rent: value.rent, fee: value.fee, deposit: value.deposit })}::text::jsonb,
          ${value.reason})`;
    return { refundIds, refundMinor: plan.result.refundMinor, replayed: false };
  });
}

/* ---------------------------- send / check command -------------------------- */

/** Test-only transport, honoured only under NODE_ENV=test (like the CP19 console). */
const testTransport = () => (process.env.NODE_ENV === 'test' ? globalThis.__rentraPaymentFetcher : undefined);
const reconcileSchema = z.object({ id: uuid, requestKey: uuid }).strict();

/**
 * Send a queued obligation or check an existing one with the provider. The
 * engine claims dispatch once, so repeated or concurrent commands never POST
 * a second refund; the same request key returns the recorded result.
 */
export async function reconcileRefundObligation(database, actor, input, options = {}) {
  const value = reconcileSchema.parse(input);
  const scope = await database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const [previous] = await tx`SELECT after FROM audit_log WHERE entity='refund' AND entity_id=${value.id}
      AND action='refund_reconcile_requested' AND actor_id=${actor.id} AND after->>'requestKey'=${value.requestKey}`;
    if (previous) return { replay: previous.after };
    const [l] = await tx`WITH l AS (${ledger(tx)}) SELECT l.* FROM l WHERE l.id=${value.id}`;
    if (!l) throw new RefundOperationError('REFUND_NOT_FOUND', 'Not found', 404);
    const status = statusOf(l);
    if (!status.command) throw new RefundOperationError('NOTHING_TO_RECONCILE', 'This refund has nothing to send or check.', 409);
    return { before: l.state, command: status.command };
  });
  if (scope.replay) return { ...scope.replay, replayed: true };
  let code = null;
  try {
    await reconcileRefund(database, value.id, { env: options.env ?? process.env, fetcher: options.fetcher ?? testTransport() });
  } catch (error) {
    code = /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'REFUND_OUTCOME_UNKNOWN';
  }
  const [after] = await database`SELECT r.state::text state,x.failure_code FROM refund r LEFT JOIN refund_execution x ON x.refund_id=r.id WHERE r.id=${value.id}`;
  const outcome = after.state === 'succeeded' ? 'refunded' : after.state === 'processing' && !after.failure_code ? 'pending' : 'unresolved';
  const result = {
    requestKey: value.requestKey,
    command: scope.command,
    outcome,
    code: code ?? after.failure_code ?? null,
    stateBefore: scope.before,
    stateAfter: after.state,
  };
  await database`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
    VALUES('admin',${actor.id},'refund',${value.id},'refund_reconcile_requested',${JSON.stringify({ state: scope.before })}::text::jsonb,${JSON.stringify(result)}::text::jsonb)`;
  return { ...result, replayed: false };
}
