import 'server-only';

// Story 2.16: one owner-facing payout state per visit. Read-only; "paid" only
// from a succeeded fixture or a paid payout row. No row means not_started.
const fixtureStates = { reserved: 'scheduled', processing: 'processing', unknown: 'needs_check', succeeded: 'paid' };
const payoutStatuses = { pending: 'scheduled', processing: 'processing', paid: 'paid', failed: 'failed', frozen: 'on_hold' };
export const NOT_STARTED = { state: 'not_started', amountMinor: null, environment: null };

export async function payoutStates(tx, bookingIds) {
  const states = new Map();
  if (!bookingIds.length) return states;
  // Real payout rows win over test fixtures for the same visit; newest row first.
  const rows = await tx`SELECT * FROM (
      SELECT DISTINCT ON (p.booking_id) p.booking_id,'payout' kind,p.status::text state,CASE WHEN p.funding_allocation_id IS NOT NULL AND p.actual_net_minor>0 THEN p.actual_net_minor::text END amount_minor,
        coalesce(t.environment::text,'legacy_unknown') environment
      FROM payout p LEFT JOIN payment_allocation a ON a.id=p.funding_allocation_id LEFT JOIN payment_transaction t ON t.id=a.transaction_id
      WHERE p.booking_id = ANY(${bookingIds}::uuid[]) ORDER BY p.booking_id,p.created_at DESC,p.id DESC) payouts
    UNION ALL SELECT * FROM (
      SELECT DISTINCT ON (a.booking_id) a.booking_id,'fixture',f.state,f.expected_minor::text,f.environment
      FROM payout_transfer_fixture f JOIN payment_allocation a ON a.id=f.source_id
      WHERE a.booking_id = ANY(${bookingIds}::uuid[]) ORDER BY a.booking_id,f.created_at DESC,f.id DESC) fixtures`;
  for (const row of rows) {
    if (states.get(row.booking_id)?.kind === 'payout') continue;
    const state = (row.kind === 'payout' ? payoutStatuses : fixtureStates)[row.state];
    if (state) states.set(row.booking_id, { kind: row.kind, state, amountMinor: row.amount_minor == null ? null : Number(row.amount_minor), environment: row.environment });
  }
  for (const [id, { kind: _kind, ...rest }] of states) states.set(id, rest);
  return states;
}
