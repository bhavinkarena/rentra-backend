import 'server-only';
import { z } from 'zod';
import { isLocalDate } from '../domain/booking-dates.js';
import { reconcilePayment } from './checkout-service.js';
import { paymentStatus, maskKeyId } from '../domain/payment-investigation.js';

/**
 * CP19 payment investigation. Read models come from the authoritative ledger
 * (payment order → attempts → verified transactions → allocations / refunds)
 * and provider events. Amounts are aggregated per payment order before any
 * totals, so joins cannot multiply money, and environments are never summed
 * together. The only command re-fetches the provider's own record.
 */
export class InvestigationError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.name = 'InvestigationError';
    this.code = code;
    this.status = status;
  }
}

const uuid = z.string().uuid();
const instant = (value) => (value ? new Date(value).toISOString() : null);
const n = (value) => Number(value ?? 0);
const STATES = ['created', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled'];

async function requireAdmin(tx, actor) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) {
    throw new InvestigationError('OPERATOR_REQUIRED', 'Operator required', 403);
  }
  const [row] = await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
  if (!row) throw new InvestigationError('OPERATOR_REQUIRED', 'Operator required', 403);
}

/** Per-order money and attention, computed once per payment order. */
export function paymentLedger(tx, filters = {}) {
  const capturePeriod = filters.basis === 'capture' ? tx`AND tx.verified_at>=${filters.from}::date AT TIME ZONE 'Asia/Kolkata'
    AND tx.verified_at<(${filters.to}::date+1) AT TIME ZONE 'Asia/Kolkata'` : tx``;
  return tx`SELECT p.id,p.booking_order_id,p.provider,p.environment::text environment,p.mode::text mode,p.currency,p.purpose::text purpose,
      p.state::text state,p.expected_minor,p.provider_order_id,p.created_at,b.reference booking_reference,b.state booking_state,
      b.listing_snapshot->>'title' title,u.name customer_name,
      e.state execution_state,e.failure_code execution_failure,
      coalesce(t.captured,0) captured_minor,coalesce(t.captured_all,0) captured_all_minor,coalesce(t.simulated,0) simulated_minor,
      coalesce(r.refunded,0) refunded_minor,coalesce(r.pending,0) refund_pending_minor,coalesce(r.uncertain,0) refunds_uncertain,
      coalesce(ev.failed,0) events_failed,coalesce(a.unknown,0) attempts_unknown
    FROM payment_order p
    JOIN booking_order b ON b.id=p.booking_order_id
    JOIN "user" u ON u.id=b.customer_id
    LEFT JOIN payment_execution e ON e.payment_order_id=p.id
    LEFT JOIN LATERAL (SELECT sum(tx.captured_minor) FILTER (WHERE tx.kind='capture' AND tx.outcome='succeeded' AND tx.verified_at IS NOT NULL ${capturePeriod}) captured,
        sum(tx.captured_minor) FILTER (WHERE tx.kind='capture' AND tx.outcome='succeeded' AND tx.verified_at IS NOT NULL) captured_all,
        sum(tx.simulated_minor) FILTER (WHERE tx.kind='simulated') simulated
      FROM payment_attempt at JOIN payment_transaction tx ON tx.attempt_id=at.id WHERE at.payment_order_id=p.id) t ON true
    LEFT JOIN LATERAL (SELECT sum(rf.actual_minor) FILTER (WHERE rf.state='succeeded') refunded,
        sum(rf.expected_minor) FILTER (WHERE rf.state IN ('requested','processing','unknown')) pending,
        count(*) FILTER (WHERE rf.state='unknown' OR EXISTS(SELECT 1 FROM refund_execution x WHERE x.refund_id=rf.id AND x.failure_code IS NOT NULL)) uncertain
      FROM payment_attempt at JOIN payment_transaction tx ON tx.attempt_id=at.id JOIN refund rf ON rf.transaction_id=tx.id WHERE at.payment_order_id=p.id) r ON true
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE pe.state='failed') failed FROM payment_event pe
      WHERE pe.provider=p.provider AND pe.environment=p.environment AND p.provider_order_id IS NOT NULL
        AND pe.redacted_payload->>'orderId'=p.provider_order_id) ev ON true
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE at.state='unknown') unknown FROM payment_attempt at WHERE at.payment_order_id=p.id) a ON true`;
}

export const paymentAttentionSql = (tx) =>
  tx`(l.refunds_uncertain>0 OR l.events_failed>0 OR l.attempts_unknown>0
    OR (l.state<>'succeeded' AND (l.execution_state IN ('dispatched','unknown','linked') OR l.execution_failure IS NOT NULL)))`;

const listSchema = z.object({
  basis: z.enum(['created','capture']).default('created'),
  environment: z.enum(['test', 'simulated', 'live', 'all']).catch('test'),
  state: z.enum([...STATES, 'all']).catch('all'),
  attention: z.enum(['all', 'needs_review']).catch('all'),
  q: z.string().trim().max(100).catch(''),
  from: z.string().refine(v=>v==='' || isLocalDate(v)).or(z.literal('')).catch(''),
  to: z.string().refine(v=>v==='' || isLocalDate(v)).or(z.literal('')).catch(''),
  page: z.coerce.number().int().min(1).max(999999).catch(1),
});

function row(l) {
  const item = {
    id: l.id,
    orderId: l.booking_order_id,
    bookingReference: l.booking_reference,
    bookingState: l.booking_state,
    title: l.title || 'Booked property',
    customerName: l.customer_name,
    provider: l.provider,
    environment: l.environment,
    mode: l.mode,
    currency: l.currency,
    purpose: l.purpose,
    state: l.state,
    providerOrderId: l.provider_order_id,
    createdAt: instant(l.created_at),
    expectedMinor: n(l.expected_minor),
    capturedMinor: n(l.captured_minor),
    simulatedMinor: n(l.simulated_minor),
    refundedMinor: n(l.refunded_minor),
    refundPendingMinor: n(l.refund_pending_minor),
    executionState: l.execution_state,
  };
  return { ...item, status: paymentStatus({ ...item, capturedMinor:n(l.captured_all_minor), refundsUncertain: n(l.refunds_uncertain), eventsFailed: n(l.events_failed), attemptsUnknown: n(l.attempts_unknown), executionFailure: l.execution_failure }) };
}

export async function listPaymentOrders(database, actor, input = {}) {
  const f = listSchema.parse({ environment: 'test', state: 'all', attention: 'all', q: '', from: '', to: '', page: 1, ...input });
  if (f.basis === 'capture' && (!f.from || !f.to || f.from > f.to)) throw new InvestigationError('INVALID_FILTER', 'Capture evidence needs a valid date range');
  const size = 25;
  return database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const where = tx`(${f.environment}='all' OR l.environment=${f.environment}) AND (${f.state}='all' OR l.state=${f.state})
      AND (${f.attention}='all' OR ${paymentAttentionSql(tx)})
      AND (${f.basis}='capture' OR ((${f.from}='' OR (l.created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${f.from || '1970-01-01'}::date)
        AND (${f.to}='' OR (l.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${f.to || '1970-01-01'}::date)))
      AND (${f.basis}<>'capture' OR l.captured_minor>0)
      AND (${f.q}='' OR position(lower(${f.q}) in lower(l.booking_reference))>0 OR l.id::text=${f.q} OR l.provider_order_id=${f.q}
        OR EXISTS(SELECT 1 FROM payment_attempt at WHERE at.payment_order_id=l.id AND at.provider_payment_id=${f.q}))`;
    // Totals group by environment: Test, simulated and live money are never added together.
    const totals = await tx`WITH l AS (${paymentLedger(tx, f)}) SELECT l.environment,count(*)::int count,
      sum(l.expected_minor)::text expected,sum(l.captured_minor)::text captured,sum(l.simulated_minor)::text simulated,
      sum(l.refunded_minor)::text refunded,sum(l.refund_pending_minor)::text refund_pending,
      count(*) FILTER (WHERE ${paymentAttentionSql(tx)})::int needs_review
      FROM l WHERE ${where} GROUP BY l.environment ORDER BY l.environment`;
    const total = totals.reduce((sum, t) => sum + t.count, 0);
    const pages = Math.max(1, Math.ceil(total / size)),
      page = Math.min(f.page, pages);
    const rows = await tx`WITH l AS (${paymentLedger(tx, f)}) SELECT l.* FROM l WHERE ${where}
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
        capturedMinor: n(t.captured),
        simulatedMinor: n(t.simulated),
        refundedMinor: n(t.refunded),
        refundPendingMinor: n(t.refund_pending),
        needsReview: t.needs_review,
      })),
      items: rows.map(row),
    };
  });
}

export async function readPaymentOrder(database, actor, id) {
  if (!uuid.safeParse(id).success) throw new InvestigationError('PAYMENT_NOT_FOUND', 'Not found', 404);
  return database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const [l] = await tx`WITH l AS (${paymentLedger(tx)}) SELECT l.*,b.rentable_id,b.customer_id,b.policy_snapshot->>'cancellationTier' tier,
      p.due_at,e.config_version,e.credential_key_id,e.next_check_at,e.updated_at execution_updated_at,
      (SELECT enabled FROM payment_gateway_config ORDER BY version DESC LIMIT 1) gateway_enabled
      FROM l JOIN payment_order p ON p.id=l.id JOIN booking_order b ON b.id=l.booking_order_id
      LEFT JOIN payment_execution e ON e.payment_order_id=l.id WHERE l.id=${id}`;
    if (!l) throw new InvestigationError('PAYMENT_NOT_FOUND', 'Not found', 404);
    const attempts = await tx`SELECT * FROM payment_attempt WHERE payment_order_id=${id} ORDER BY attempt_number`;
    const transactions = await tx`SELECT t.* FROM payment_transaction t JOIN payment_attempt a ON a.id=t.attempt_id
      WHERE a.payment_order_id=${id} ORDER BY t.created_at,t.id`;
    const allocations = await tx`SELECT pa.*,b.reference visit_reference,b.state visit_state FROM payment_allocation pa
      JOIN booking b ON b.id=pa.booking_id JOIN payment_transaction t ON t.id=pa.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id
      WHERE a.payment_order_id=${id} ORDER BY pa.created_at,b.item_position,pa.component`;
    const refunds = await tx`SELECT r.*,x.dispatched_at,x.next_check_at,x.failure_code execution_failure FROM refund r
      JOIN payment_transaction t ON t.id=r.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id
      LEFT JOIN refund_execution x ON x.refund_id=r.id WHERE a.payment_order_id=${id} ORDER BY r.created_at,r.id`;
    const refundAllocations = refunds.length
      ? await tx`SELECT ra.*,b.reference visit_reference FROM refund_allocation ra JOIN booking b ON b.id=ra.booking_id
        WHERE ra.refund_id = ANY(${refunds.map((r) => r.id)}::uuid[]) ORDER BY b.item_position,ra.component`
      : [];
    const paymentIds = attempts.map((a) => a.provider_payment_id).filter(Boolean);
    const events = l.provider_order_id || paymentIds.length
      ? await tx`SELECT id,external_event_id,state::text state,attempts,failure_code,received_at,processed_at,signature_verified_at,
          redacted_payload->>'type' type,redacted_payload->>'paymentId' payment_id,redacted_payload->>'refundId' refund_id
        FROM payment_event WHERE provider=${l.provider} AND environment=${l.environment}
          AND (redacted_payload->>'orderId'=${l.provider_order_id ?? ''} OR redacted_payload->>'paymentId' = ANY(${paymentIds}::text[]))
        ORDER BY received_at,id`
      : [];
    const history = await tx`SELECT kind,created_at FROM booking_lifecycle_event WHERE order_id=${l.booking_order_id}
      AND (kind IN ('held','confirmed','expired','refund_required') OR kind LIKE 'cancel\\_%' OR kind LIKE 'refund\\_%') ORDER BY created_at,id`;
    const reconciles = await tx`SELECT a.at,a.after,x.name FROM audit_log a LEFT JOIN admin_user x ON x.id=a.actor_id
      WHERE a.entity='payment_order' AND a.entity_id=${id} AND a.action='payment_reconcile_requested' ORDER BY a.at DESC LIMIT 20`;
    const base = row(l);
    return {
      ...base,
      booking: { id: l.booking_order_id, reference: l.booking_reference, state: l.booking_state, title: l.title || 'Booked property', propertyId: l.rentable_id, customerId: l.customer_id, customerName: l.customer_name, cancellationTier: l.tier },
      dueAt: instant(l.due_at),
      execution: l.execution_state
        ? { state: l.execution_state, failureCode: l.execution_failure, configVersion: l.config_version, credential: maskKeyId(l.credential_key_id), nextCheckAt: instant(l.next_check_at), updatedAt: instant(l.execution_updated_at) }
        : null,
      gatewayEnabled: Boolean(l.gateway_enabled),
      canReconcile: base.status.reconcilable,
      attempts: attempts.map((a) => ({ id: a.id, number: a.attempt_number, state: a.state, providerPaymentId: a.provider_payment_id, methodFamily: a.method_family, failureCode: a.failure_code, expectedMinor: n(a.expected_minor), startedAt: instant(a.started_at), completedAt: instant(a.completed_at) })),
      transactions: transactions.map((t) => ({
        id: t.id,
        reference: t.reference,
        kind: t.kind,
        outcome: t.outcome,
        providerPaymentId: t.provider_payment_id,
        expectedMinor: n(t.expected_minor),
        authorizedMinor: n(t.authorized_minor),
        capturedMinor: n(t.captured_minor),
        simulatedMinor: n(t.simulated_minor),
        verifiedAt: instant(t.verified_at),
        evidence: t.evidence_hash ? `sha256 ${t.evidence_hash.slice(0, 12)}…` : null,
        createdAt: instant(t.created_at),
        allocations: allocations
          .filter((a) => a.transaction_id === t.id)
          .map((a) => ({ id: a.id, visitReference: a.visit_reference, visitState: a.visit_state, component: a.component, actualMinor: n(a.actual_minor), simulatedMinor: n(a.simulated_minor) })),
      })),
      refunds: refunds.map((r) => ({
        id: r.id,
        reference: r.reference,
        state: r.state,
        reason: r.reason,
        expectedMinor: n(r.expected_minor),
        actualMinor: n(r.actual_minor),
        providerRefundId: r.provider_refund_id,
        createdAt: instant(r.created_at),
        completedAt: instant(r.completed_at),
        verifiedAt: instant(r.verified_at),
        execution: { dispatchedAt: instant(r.dispatched_at), nextCheckAt: instant(r.next_check_at), failureCode: r.execution_failure },
        allocations: refundAllocations.filter((a) => a.refund_id === r.id).map((a) => ({ visitReference: a.visit_reference, component: a.component, expectedMinor: n(a.expected_minor), actualMinor: n(a.actual_minor) })),
      })),
      events: events.map((e) => ({ id: e.id, externalEventId: e.external_event_id, type: e.type, state: e.state, attempts: e.attempts, failureCode: e.failure_code, paymentId: e.payment_id, refundId: e.refund_id, signatureVerifiedAt: instant(e.signature_verified_at), receivedAt: instant(e.received_at), processedAt: instant(e.processed_at) })),
      history: history.map((h) => ({ kind: /^cancel_/.test(h.kind) ? 'visits_cancelled' : /^refund_[a-f0-9]{32}$/.test(h.kind) ? 'refund_processed' : h.kind, at: instant(h.created_at) })),
      reconciliations: reconciles.map((r) => ({ at: instant(r.at), by: r.name, outcome: r.after?.outcome ?? null, code: r.after?.code ?? null, stateAfter: r.after?.stateAfter ?? null })),
    };
  });
}

/** Test-only transport, honoured only under NODE_ENV=test (like the evidence store). */
const testTransport = () => (process.env.NODE_ENV === 'test' ? globalThis.__rentraPaymentFetcher : undefined);

const reconcileSchema = z.object({ id: uuid, requestKey: uuid }).strict();

/**
 * Ask the provider for its own record of this payment and settle only what it
 * verifies. Idempotent: settlement deduplicates provider payments, and a repeat
 * with the same request key returns the recorded result without calling out.
 */
export async function reconcilePaymentOrder(database, actor, input, options = {}) {
  const value = reconcileSchema.parse(input);
  const scope = await database.begin(async (tx) => {
    await requireAdmin(tx, actor);
    const [previous] = await tx`SELECT after FROM audit_log WHERE entity='payment_order' AND entity_id=${value.id}
      AND action='payment_reconcile_requested' AND actor_id=${actor.id} AND after->>'requestKey'=${value.requestKey}`;
    if (previous) return { replay: previous.after };
    const [l] = await tx`WITH l AS (${paymentLedger(tx)}) SELECT l.* FROM l WHERE l.id=${value.id}`;
    if (!l) throw new InvestigationError('PAYMENT_NOT_FOUND', 'Not found', 404);
    if (!row(l).status.reconcilable) throw new InvestigationError('NOTHING_TO_RECONCILE', 'This payment has no provider outcome to re-fetch.', 409);
    return { before: l.state };
  });
  if (scope.replay) return { ...scope.replay, replayed: true };
  let outcome = 'checked',
    code = null;
  try {
    await reconcilePayment(database, value.id, { env: options.env ?? process.env, fetcher: options.fetcher ?? testTransport() });
  } catch (error) {
    outcome = 'unresolved';
    code = /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'PROVIDER_OUTCOME_UNKNOWN';
  }
  const [after] = await database`SELECT p.state::text state,b.state booking_state FROM payment_order p JOIN booking_order b ON b.id=p.booking_order_id WHERE p.id=${value.id}`;
  // No error but still unconfirmed means the provider had nothing verifiable to report.
  if (outcome === 'checked' && !['succeeded', 'failed', 'cancelled'].includes(after.state)) {
    outcome = 'unresolved';
    code = 'NO_PROVIDER_OUTCOME';
  }
  const result = { requestKey: value.requestKey, outcome, code, stateBefore: scope.before, stateAfter: after.state, bookingStateAfter: after.booking_state };
  await database`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
    VALUES('admin',${actor.id},'payment_order',${value.id},'payment_reconcile_requested',${JSON.stringify({ state: scope.before })}::text::jsonb,${JSON.stringify(result)}::text::jsonb)`;
  return { ...result, replayed: false };
}
