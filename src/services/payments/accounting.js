import 'server-only';

/** Internal, actor-scoped DAL. Money totals are decimal minor-unit strings so
 * aggregates cannot silently lose precision. Never sum booking caches or legacy payouts.
 * No booking status, authorization or simulated fact is evidence of collected funds.
 */
export async function ownerFinancialSummary(database, ownerId) {
  const [row] = await database`
    SELECT u.id AS owner_id,
      coalesce(sum(c.actual_minor),0)::text AS captured_minor,
      coalesce(sum(c.refunded_minor),0)::text AS refunded_minor,
      coalesce(sum(c.actual_minor-c.refunded_minor) FILTER (WHERE c.component='fee'),0)::text AS net_captured_fee_minor,
      coalesce(sum(c.actual_minor-c.refund_reserved_minor-c.payout_reserved_minor)
        FILTER (WHERE c.component='rent' AND c.booking_state='completed'),0)::text AS available_rent_minor
    FROM "user" u LEFT JOIN captured_payment_allocation c ON c.client_id=u.id
    WHERE u.id=${ownerId} AND u.role='client' AND u.account_status='active' GROUP BY u.id`;
  return row ?? null;
}

export async function ownerPayoutSources(database, ownerId) {
  const rows = await database`
    SELECT c.id AS allocation_id, c.booking_id,
      (c.actual_minor-c.refund_reserved_minor-c.payout_reserved_minor)::text AS available_minor
    FROM captured_payment_allocation c JOIN "user" u ON u.id=c.client_id
    WHERE u.id=${ownerId} AND u.role='client' AND u.account_status='active'
      AND c.component='rent' AND c.booking_state='completed'
      AND c.actual_minor-c.refund_reserved_minor-c.payout_reserved_minor > 0
    ORDER BY c.booking_id,c.id LIMIT 50`;
  return Array.from(rows);
}
