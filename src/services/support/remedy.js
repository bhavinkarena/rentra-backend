import 'server-only';
import { z } from 'zod';
import { SupportError } from './errors.js';
import { forbidden } from '../../utils/apiError.js';
import { facts } from '../finance/owner-recovery.js';
import { payoutStates } from '../finance/payout-state.js';
import { capturedAllocations, testSourcesOnly } from '../booking/cancellation.js';
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
  const [row] = await tx`SELECT s.id,s.version,s.category,s.order_id,s.context,o.rentable_id,r.client_id owner_id
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
