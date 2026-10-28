import 'server-only';

/**
 * Story 2.14 (FR-6): what pausing a property touches, read-only.
 *
 * Stop-new-only keeps every confirmed stay and every unpaid hold until the
 * owner declines it or it expires; it only stops new admissions, approvals
 * and payment confirmations. Cancelling upcoming stays is a separate choice
 * (Story 2.15): stays whose check-in is still in the future.
 */
const LIMIT = 20;

const day = (value) => String(value instanceof Date ? value.toISOString() : value).slice(0, 10);

export async function pauseImpact(database, rentableId) {
  const [confirmed, [counts], holds] = await Promise.all([
    database`SELECT b.order_id, b.reference, b.local_day, b.slot::text AS slot, b.state::text AS state, b.starts_at
      FROM booking b WHERE b.rentable_id=${rentableId} AND b.state IN ('confirmed','handed_over') AND b.ends_at > now()
      ORDER BY b.starts_at LIMIT ${LIMIT}`,
    database`SELECT count(*)::int AS stays,
        count(*) FILTER (WHERE b.state='confirmed' AND b.starts_at > now())::int AS cancellable
      FROM booking b WHERE b.rentable_id=${rentableId} AND b.state IN ('confirmed','handed_over') AND b.ends_at > now()`,
    // Unpaid orders still holding dates. A request with no owner answer is waiting on the owner;
    // an instant or approved hold is waiting on the guest's payment.
    database`SELECT o.id, o.reference, o.hold_expires_at,
        (SELECT min(b.starts_at) FROM booking b WHERE b.order_id=o.id) AS starts_at,
        EXISTS(SELECT 1 FROM booking_lifecycle_event e WHERE e.order_id=o.id AND e.kind='approval_requested')
          AND NOT EXISTS(SELECT 1 FROM booking_lifecycle_event e WHERE e.order_id=o.id
            AND e.kind IN ('owner_approved','owner_declined')) AS awaiting_owner
      FROM booking_order o WHERE o.rentable_id=${rentableId} AND o.state='held' AND o.hold_expires_at > now()
      ORDER BY o.hold_expires_at`,
  ]);
  const hold = (row) => ({
    orderId: row.id,
    reference: row.reference,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    holdExpiresAt: new Date(row.hold_expires_at).toISOString(),
  });
  return {
    confirmedStays: {
      total: counts.stays,
      // Story 2.15 scope: stays whose check-in is still ahead (in-progress stays are excluded).
      cancellableUpcoming: counts.cancellable,
      items: confirmed.map((row) => ({
        orderId: row.order_id,
        reference: row.reference,
        day: day(row.local_day),
        slot: row.slot,
        state: row.state,
        startsAt: new Date(row.starts_at).toISOString(),
      })),
    },
    pendingRequests: holds.filter((row) => row.awaiting_owner).map(hold),
    awaitingPayment: holds.filter((row) => !row.awaiting_owner).map(hold),
  };
}
