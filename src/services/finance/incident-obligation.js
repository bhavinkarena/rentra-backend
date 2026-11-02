import 'server-only';
import { payoutStates } from './payout-state.js';

// Story 4.5 (Test only): an owner-funded incident award's extra owner share. Recorded as
// awaiting_payout; due only once a payout for one of the order's visits has succeeded. Never
// deducted from a payout. No notices or overdue restriction (deferred).
// State 'cancelled' is reserved (CHECK keeps it); no cancel path exists in Story 4.5.

/**
 * Moves awaiting_payout obligations of these orders to due when a visit payout has succeeded. Audited.
 * 2.20 lock order: owner "user" rows (by id) before obligation rows. The payout dispatch caller holds
 * no listing mutex; execute holds it but takes the same owner-then-obligation order, so they cannot cross.
 */
export async function promoteIncidentObligations(tx, orderIds, actor = { type: 'system', id: null }) {
  if (!orderIds.length) return [];
  await tx`SELECT 1 FROM "user" WHERE id IN (SELECT owner_id FROM incident_owner_obligation
    WHERE order_id = ANY(${orderIds}::uuid[]) AND state='awaiting_payout') ORDER BY id FOR UPDATE`;
  const rows = await tx`SELECT id,order_id FROM incident_owner_obligation
    WHERE order_id = ANY(${orderIds}::uuid[]) AND state='awaiting_payout' ORDER BY id FOR UPDATE`;
  if (!rows.length) return [];
  const visits = await tx`SELECT id,order_id FROM booking WHERE order_id = ANY(${rows.map((r) => r.order_id)}::uuid[])`;
  const states = await payoutStates(tx, visits.map((v) => v.id));
  const paidOrders = new Set(visits.filter((v) => states.get(v.id)?.state === 'paid').map((v) => v.order_id));
  const promoted = rows.filter((r) => paidOrders.has(r.order_id)).map((r) => r.id);
  if (!promoted.length) return [];
  await tx`UPDATE incident_owner_obligation SET state='due',updated_at=now() WHERE id = ANY(${promoted}::uuid[])`;
  for (const id of promoted)
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
      VALUES (${actor.type},${actor.id},'incident_owner_obligation',${id},'incident_obligation_due',
        '{"state":"awaiting_payout"}'::jsonb,'{"state":"due"}'::jsonb,'Owner payout for the order succeeded (Test)')`;
  return promoted;
}

export const obligationView = (o) => o && {
  id: o.id,
  decisionId: o.decision_id,
  ownerId: o.owner_id,
  orderId: o.order_id,
  amountMinor: String(o.amount_minor),
  reassignedFeeMinor: String(o.components.reassigned_fee_minor),
  ownerFeeShareMinor: String(o.components.owner_fee_share_minor),
  state: o.state,
  environment: 'test',
  createdAt: new Date(o.created_at).toISOString(),
};
