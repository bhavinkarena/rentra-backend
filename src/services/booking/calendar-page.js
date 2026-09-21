import 'server-only';

/**
 * The owner's booking-calendar screen, assembled.
 *
 * Scoped by `client_id` in the query itself rather than checked afterwards:
 * another Client's listing id returns no row, so there is no path where the
 * wrong owner sees a title, a capacity or a block reason.
 *
 * The block labels are formatted here rather than in the page because the
 * property's timezone is a booking rule, not a display preference — a browser
 * in another timezone must not render an owner's 9pm block as 3:30pm.
 */
export async function ownerCalendarPage(database, ownerId, rentableId) {
  const [listing] = await database`
    SELECT id, title, capacity, extra_guest_charge, booking_config, booking_config_version
    FROM rentable WHERE id=${rentableId} AND client_id=${ownerId}`;
  if (!listing) return null;

  const rows = await database`
    SELECT id, blocked_start_at, blocked_end_at, reason
    FROM inventory_reservation
    WHERE rentable_id=${rentableId} AND source='owner_block' AND state='committed'
    ORDER BY blocked_start_at`;

  const format = (time) =>
    new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }).format(new Date(time));

  return {
    listing,
    blocks: rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      label: `${format(row.blocked_start_at)} – ${format(row.blocked_end_at)}`,
    })),
  };
}
