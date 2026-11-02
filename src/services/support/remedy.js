import 'server-only';
import { z } from 'zod';
import { SupportError } from './errors.js';
import { forbidden, unprocessable } from '../../utils/apiError.js';
import { facts } from '../finance/owner-recovery.js';
import { payoutStates } from '../finance/payout-state.js';
import { capturedAllocations, testSourcesOnly, allocateRefund, createRefundObligations } from '../booking/cancellation.js';
import { allocateByWeights } from '../domain/booking-money.js';
import { promoteIncidentObligations, obligationView } from '../finance/incident-obligation.js';
import { quoteDigest } from '../booking/quotes.js';
import { withListingInventory } from '../booking/inventory.js';
import { ledger } from '../payments/refund-operations.js';
import { incidentRemedy } from '../domain/incident-remedy.js';

/**
 * Story 4.4: a read-only cumulative remedy preview on a stay-issue case, and a saved reviewed
 * decision (deny, or target % + responsibility) for Story 4.5 to execute. Nothing here creates a
 * refund, obligation or payout, calls a provider, or changes booking or support state.
 */
const uuid = z.string().uuid();
const COMPONENTS = ['rent', 'fee', 'tax'];
const missing = () => new SupportError('NOT_FOUND', 'Support request not found.', 404);

/** One rule for the API and the read model: preview = payments read or write, decide = write. */
export function remedyCaps(staff) {
  const p = staff?.permissions;
  const has = (cap) => !!staff && (p == null || (Array.isArray(p) && p.includes(cap)));
  return {
    canReadCase: has('admin.support.read') || has('admin.support.write'),
    canPreview: has('admin.payments.read') || has('admin.payments.write'),
    canDecide: has('admin.payments.write'),
  };
}

/** Missing/inactive admin 403; case not readable 404; payments capability missing 403. */
async function access(tx, actor, write) {
  const [staff] =
    actor?.kind === 'admin' && uuid.safeParse(actor.id).success
      ? await tx`SELECT permissions FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`
      : [];
  if (!staff) throw forbidden();
  const caps = remedyCaps(staff);
  if (!caps.canReadCase) throw missing();
  if (!(write ? caps.canDecide : caps.canPreview)) throw forbidden();
}

async function stayCase(tx, id) {
  if (!uuid.safeParse(id).success) throw missing();
  const [row] = await tx`SELECT s.id,s.reference,s.version,s.category,s.order_id,s.context,o.rentable_id,r.client_id owner_id
    FROM support_request s LEFT JOIN booking_order o ON o.id=s.order_id LEFT JOIN rentable r ON r.id=o.rentable_id WHERE s.id=${id}`;
  if (!row) throw missing();
  if (row.category !== 'stay_issue' || !row.order_id)
    throw new SupportError('REMEDY_UNAVAILABLE', 'Remedies apply only to stay issues linked to a booking.', 422);
  return row;
}

const inputSchema = z.object({
  visitIds: z.array(uuid).max(50).optional(),
  targetPct: z.coerce.number().int().min(0).max(100),
  responsibility: z.enum(['proportional', 'owner_funded']),
});

async function plan(tx, row, input) {
  const value = inputSchema.parse(input);
  const orderVisits = await tx`SELECT id,reference,local_day::text AS day FROM booking WHERE order_id=${row.order_id} ORDER BY item_position NULLS LAST,local_day,id`;
  const affected = [...new Set((row.context?.stayIssue?.affected || []).map((a) => a.visitId))];
  // Absent = the guest's reported visits; an explicit empty selection is refused.
  if (value.visitIds && !value.visitIds.length) throw new SupportError('VISIT_REQUIRED', 'Choose at least one visit.', 422);
  const visitIds = [...new Set(value.visitIds ?? affected)].sort();
  if (!visitIds.length || visitIds.some((id) => !orderVisits.some((v) => v.id === id)))
    throw new SupportError('VISIT_NOT_IN_ORDER', 'Choose visits from this booking.', 422);
  const sources = (await capturedAllocations(tx, visitIds)).filter((s) => COMPONENTS.includes(s.component));
  const paid = Object.fromEntries(COMPONENTS.map((c) => [c, sources.filter((s) => s.component === c).reduce((a, s) => a + Number(s.actual_minor), 0)]));
  // Case refunds: ledger source booking_case, or a reason starting exactly "Rentra support case ".
  // Story 4.5 must create its refunds with that reason prefix so they are counted here.
  const rows = await tx`WITH l AS (${ledger(tx)}) SELECT ra.component,
      CASE WHEN l.source='booking_case' OR l.reason LIKE 'Rentra support case %' THEN 'case' WHEN l.state='succeeded' THEN 'prior' ELSE 'in_flight' END bucket,
      sum(CASE WHEN l.state='succeeded' THEN ra.actual_minor ELSE ra.expected_minor END)::text minor
    FROM refund_allocation ra JOIN l ON l.id=ra.refund_id
    WHERE ra.booking_id IN ${tx(visitIds)} AND l.state<>'failed' AND ra.component IN ${tx(COMPONENTS)} GROUP BY 1,2 ORDER BY 1,2`;
  const counted = Object.fromEntries(COMPONENTS.map((c) => [c, rows.filter((r) => r.component === c).reduce((a, r) => a + Number(r.minor), 0)]));
  const bucket = (b) => rows.filter((r) => r.bucket === b).reduce((a, r) => a + Number(r.minor), 0);
  const states = await payoutStates(tx, visitIds);
  let recoveredMinor = 0;
  for (const s of sources.filter((x) => x.component === 'rent'))
    for (const f of await facts(tx, s.id)) recoveredMinor += Number(f.recoveredMinor);
  const visits = visitIds.map((id) => ({
    rentMinor: sources.filter((s) => s.booking_id === id && s.component === 'rent').reduce((a, s) => a + Number(s.actual_minor), 0),
    paidOut: states.get(id)?.state === 'paid',
  }));
  const maths = incidentRemedy({ paid, counted, targetPct: value.targetPct, responsibility: value.responsibility, visits, recoveredMinor });
  const result = {
    supportRequestId: row.id,
    caseVersion: row.version,
    orderId: row.order_id,
    visitIds,
    affectedVisitIds: affected,
    orderVisits: orderVisits.map((v) => ({ id: v.id, reference: v.reference, date: v.day })),
    targetPct: value.targetPct,
    responsibility: value.responsibility,
    testOnly: sources.length > 0 && testSourcesOnly(sources),
    paidByComponent: paid,
    priorRefundedMinor: bucket('prior'),
    inFlightMinor: bucket('in_flight'),
    caseReimbursedMinor: bucket('case'),
    payoutStates: visitIds.map((id) => ({ visitId: id, state: states.get(id)?.state ?? 'not_started' })),
    recoveredMinor,
    ...maths,
    projection: true,
  };
  return { ...result, digest: quoteDigest(result) };
}

export async function previewIncidentRemedy(database, actor, input = {}) {
  return database.begin(async (tx) => {
    await access(tx, actor, false);
    return plan(tx, await stayCase(tx, input.supportRequestId), input);
  });
}

const decideSchema = z.object({
  supportRequestId: uuid,
  kind: z.enum(['deny', 'award']),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(1000),
  visitIds: z.array(uuid).max(50).optional(),
  targetPct: z.coerce.number().int().min(0).max(100).optional(),
  responsibility: z.enum(['proportional', 'owner_funded']).optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestKey: uuid,
});

/** Saves the reviewed decision; an award must match a fresh server preview (digest) under the listing lock. */
export async function decideIncidentRemedy(database, actor, input) {
  const parsed = decideSchema.parse(input ?? {});
  const value = parsed.kind === 'deny'
    ? { supportRequestId: parsed.supportRequestId, kind: 'deny', reason: parsed.reason, requestKey: parsed.requestKey }
    : parsed;
  if (value.kind === 'award' && (value.targetPct == null || !value.responsibility || !value.digest))
    throw new SupportError('PREVIEW_REQUIRED', 'Preview the award before saving it.', 422);
  const requestHash = quoteDigest({ ...value, visitIds: value.visitIds && [...new Set(value.visitIds)].sort(), requestKey: undefined });
  const [scope] = await database`SELECT o.rentable_id FROM support_request s JOIN booking_order o ON o.id=s.order_id WHERE s.id=${uuid.safeParse(value.supportRequestId).success ? value.supportRequestId : null}`;
  const run = async (tx) => {
    await access(tx, actor, true);
    const [previous] = await tx`SELECT * FROM incident_remedy_decision WHERE request_key=${value.requestKey}`;
    if (previous) {
      if (previous.request_hash !== requestHash || previous.support_request_id !== value.supportRequestId)
        throw new SupportError('IDEMPOTENCY_CONFLICT', 'This request key was already used for a different decision.', 409);
      return { ...decisionView(previous), replayed: true };
    }
    const row = await stayCase(tx, value.supportRequestId);
    // The lock was chosen from a read outside this transaction; the case must still map to it.
    if (row.rentable_id !== scope.rentable_id)
      throw new SupportError('PREVIEW_CHANGED', 'The case changed since the preview. Preview again.', 409);
    let preview = null;
    if (value.kind === 'award') {
      preview = await plan(tx, row, value);
      if (preview.digest !== value.digest) {
        const error = new SupportError('PREVIEW_CHANGED', 'The figures changed since the preview. Review the new figures.', 409);
        error.preview = preview;
        throw error;
      }
    }
    await tx`UPDATE incident_remedy_decision SET superseded_at=now() WHERE support_request_id=${row.id} AND superseded_at IS NULL`;
    const [saved] = await tx`INSERT INTO incident_remedy_decision(support_request_id,kind,reason,visit_ids,target_pct,responsibility,preview,digest,decided_by,request_key,request_hash)
      VALUES(${row.id},${value.kind},${value.reason},${preview ? preview.visitIds : []}::uuid[],${preview ? value.targetPct : null},${preview ? value.responsibility : null},
        ${preview ? JSON.stringify(preview) : null}::text::jsonb,${preview ? preview.digest : null},${actor.id},${value.requestKey},${requestHash}) RETURNING *`.catch((error) => {
        // A concurrent decision on the same case won the single active slot.
        if (error.code === '23505' && error.constraint_name === 'incident_remedy_decision_active')
          throw new SupportError('PREVIEW_CHANGED', 'Another decision was saved for this case. Review it and preview again.', 409);
        throw error;
      });
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after",reason)
      VALUES('admin',${actor.id},'support_request',${row.id},'incident_remedy_decided',${JSON.stringify({
        decisionId: saved.id, kind: value.kind, reason: value.reason, orderId: row.order_id, ownerId: row.owner_id,
        targetPct: preview ? value.targetPct : null, responsibility: preview ? value.responsibility : null,
        additionalDueMinor: preview ? preview.additionalDueMinor : null,
      })}::text::jsonb,${value.reason})`;
    return { ...decisionView(saved), replayed: false };
  };
  if (!scope) {
    // No order: report not found / not allowed first, then refuse explicitly.
    await database.begin(async (tx) => {
      await access(tx, actor, true);
      await stayCase(tx, value.supportRequestId);
    });
    throw new SupportError('REMEDY_UNAVAILABLE', 'Remedies apply only to stay issues linked to a booking.', 422);
  }
  return withListingInventory(database, scope.rentable_id, run);
}

export function decisionView(d) {
  return {
    id: d.id,
    kind: d.kind,
    reason: d.reason,
    visitIds: d.visit_ids,
    targetPct: d.target_pct,
    responsibility: d.responsibility,
    preview: d.preview,
    state: d.state,
    decidedBy: d.decided_by,
    createdAt: new Date(d.created_at).toISOString(),
    supersededAt: d.superseded_at ? new Date(d.superseded_at).toISOString() : null,
  };
}

/* ------------------------------ Story 4.5 execute ------------------------------ */

const executeSchema = z.object({ decisionId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/), requestKey: uuid });
const conflictError = (code, message, extra = {}) => Object.assign(new SupportError(code, message, 409), extra);

/** Refund rows of an execution with a display status from the existing refund engine. */
async function executionView(tx, e) {
  const refunds = e.refund_ids.length
    ? await tx`SELECT r.id,r.reference,r.state,r.expected_minor::text expected,r.actual_minor::text actual,x.dispatched_at
        FROM refund r LEFT JOIN refund_execution x ON x.refund_id=r.id WHERE r.id IN ${tx(e.refund_ids)} ORDER BY r.id`
    : [];
  const [obligation] = e.obligation_id ? await tx`SELECT * FROM incident_owner_obligation WHERE id=${e.obligation_id}` : [];
  const [link] = obligation
    ? await tx`SELECT id,state,amount_minor::text amount FROM owner_repayment WHERE incident_obligation_id=${obligation.id}
        ORDER BY (state='open') DESC,created_at DESC LIMIT 1`
    : [];
  const status = (r) => r.state === 'succeeded' ? 'verified' : r.state === 'failed' ? 'failed'
    : r.state === 'requested' && !r.dispatched_at ? 'queued' : r.state === 'unknown' ? 'unknown' : 'sent';
  return {
    id: e.id,
    decisionId: e.decision_id,
    environment: 'test',
    refunds: refunds.map((r) => ({ id: r.id, reference: r.reference, status: status(r), amountMinor: r.expected, actualMinor: r.actual })),
    obligation: obligation ? { ...obligationView(obligation), link: link ? { id: link.id, state: link.state, amountMinor: link.amount } : null } : null,
    executedBy: e.executed_by,
    createdAt: new Date(e.created_at).toISOString(),
  };
}

/** Every execution on the case, newest first, including those of superseded decisions (read model). */
export async function readExecutions(tx, supportRequestId) {
  const rows = await tx`SELECT e.* FROM incident_remedy_execution e JOIN incident_remedy_decision d ON d.id=e.decision_id
    WHERE d.support_request_id=${supportRequestId} ORDER BY e.created_at DESC,e.id`;
  const views = [];
  for (const e of rows) views.push(await executionView(tx, e));
  return views;
}

/**
 * Executes the case's active award once: re-checks the saved decision against a fresh preview under
 * the listing lock, queues only the additional guest refund (Test sources only) and, for an
 * owner-funded award, records the owner's extra fee share as an incident obligation. Never offsets
 * a payout or debits the owner; booking and support state stay unchanged.
 */
export async function executeIncidentAward(database, actor, input) {
  const parsed = executeSchema.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(parsed.error.flatten().fieldErrors, 'Reload the decision and try again.');
  const value = parsed.data;
  const requestHash = quoteDigest({ decisionId: value.decisionId, digest: value.digest });
  const [scope] = await database`SELECT d.support_request_id,o.rentable_id FROM incident_remedy_decision d
    JOIN support_request s ON s.id=d.support_request_id JOIN booking_order o ON o.id=s.order_id WHERE d.id=${value.decisionId}`;
  if (!scope) {
    await database.begin((tx) => access(tx, actor, true));
    throw missing();
  }
  return withListingInventory(database, scope.rentable_id, async (tx) => {
    await access(tx, actor, true);
    const [previous] = await tx`SELECT * FROM incident_remedy_execution WHERE request_key=${value.requestKey}`;
    if (previous) {
      if (previous.request_hash !== requestHash)
        throw conflictError('IDEMPOTENCY_CONFLICT', 'This request key was already used for a different execution.');
      return { ...(await executionView(tx, previous)), replayed: true };
    }
    const [decision] = await tx`SELECT * FROM incident_remedy_decision WHERE id=${value.decisionId} FOR UPDATE`;
    if ((await tx`SELECT 1 FROM incident_remedy_execution WHERE decision_id=${decision.id}`).length)
      throw conflictError('ALREADY_EXECUTED', 'This award was already executed.');
    if (decision.kind !== 'award' || decision.superseded_at)
      throw conflictError('DECISION_NOT_ACTIVE', 'Only the active award on this case can be executed.');
    const row = await stayCase(tx, decision.support_request_id);
    if (row.rentable_id !== scope.rentable_id) throw conflictError('PREVIEW_CHANGED', 'The case changed. Save a new decision first.');
    // Story 2.20 lock order: listing mutex, then the owner "user" row.
    await tx`SELECT 1 FROM "user" WHERE id=${row.owner_id} FOR UPDATE`;
    const preview = await plan(tx, row, { visitIds: decision.visit_ids, targetPct: decision.target_pct, responsibility: decision.responsibility });
    if (value.digest !== decision.digest || preview.digest !== decision.digest)
      throw conflictError('PREVIEW_CHANGED', 'The figures changed since the decision. Save a new decision first.', { preview });
    const additional = preview.additionalDueMinor;
    const paid = preview.paidByComponent;
    const [rent, fee, tax] = additional > 0 ? allocateByWeights(additional, [paid.rent, paid.fee, paid.tax]) : [0, 0, 0];
    let refundIds = [];
    if (additional > 0) {
      const sources = (await capturedAllocations(tx, preview.visitIds)).filter((s) => COMPONENTS.includes(s.component));
      if (!sources.length || !testSourcesOnly(sources))
        throw conflictError('REFUND_BLOCKED', 'This payment is outside Razorpay Test; it needs the live refund process.');
      const lines = allocateRefund(sources, { rent, fee, tax, deposit: 0 }, { remainingOnly: true });
      if (lines.reduce((a, l) => a + l.amount, 0) !== additional)
        throw conflictError('REFUND_BLOCKED', 'What remains refundable does not cover this award. Save a new decision first.');
      const visitOf = new Map(sources.map((s) => [s.id, s.booking_id]));
      const visits = preview.visitIds.map((id) => ({ id, refunds: lines.filter((l) => visitOf.get(l.allocationId) === id) })).filter((v) => v.refunds.length);
      refundIds = await createRefundObligations(tx, visits, {
        // The "Rentra support case " prefix is what the 4.4 preview counts as a case reimbursement.
        reason: `Rentra support case ${row.reference}: ${decision.reason.trim()}`.slice(0, 160),
        idempotencyKey: decision.id,
        requestHash,
      });
    }
    let obligation = null;
    // Earlier executed awards on this order already hold part of the owner extra (e.g. a reassigned
    // fee); a later award records only what is new, so the cumulative owner extra is never counted twice.
    const [{ earlier }] = await tx`SELECT coalesce(sum(amount_minor),0)::text earlier FROM incident_owner_obligation
      WHERE order_id=${row.order_id} AND state<>'cancelled'`;
    const owed = decision.responsibility === 'owner_funded'
      ? Math.max(0, preview.reassignedFromRentraMinor + fee - Number(earlier)) : 0;
    if (owed > 0) {
      [obligation] = await tx`INSERT INTO incident_owner_obligation(decision_id,owner_id,order_id,amount_minor,components)
        VALUES (${decision.id},${row.owner_id},${row.order_id},${owed},
          ${JSON.stringify({ reassigned_fee_minor: preview.reassignedFromRentraMinor, owner_fee_share_minor: fee })}::text::jsonb) RETURNING *`;
      await promoteIncidentObligations(tx, [row.order_id], { type: 'admin', id: actor.id });
    }
    const [saved] = await tx`INSERT INTO incident_remedy_execution(decision_id,refund_ids,obligation_id,digest,executed_by,request_key,request_hash)
      VALUES (${decision.id},${refundIds}::uuid[],${obligation?.id ?? null},${decision.digest},${actor.id},${value.requestKey},${requestHash}) RETURNING *`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after",reason)
      VALUES('admin',${actor.id},'support_request',${row.id},'incident_award_executed',${JSON.stringify({
        executionId: saved.id, decisionId: decision.id, orderId: row.order_id, ownerId: row.owner_id,
        additionalDueMinor: additional, refundIds, obligationId: obligation?.id ?? null, obligationMinor: owed, environment: 'test',
      })}::text::jsonb,${decision.reason})`;
    return { ...(await executionView(tx, saved)), replayed: false };
  });
}
