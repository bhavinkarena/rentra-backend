import 'server-only';
import { withListingSnapshot } from './inventory.js';
import { calendarSnapshot } from './owner-calendar.js';

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
    SELECT id, title, capacity, booking_config, booking_config_version, rental_unit::text AS rental_unit
    FROM rentable WHERE id=${rentableId} AND client_id=${ownerId}`;
  if (!listing) return null;

  return withListingSnapshot(database, rentableId, async (tx, current) => {
    if (current.client_id !== ownerId) return null;
    const rows = await tx`
      SELECT r.id, r.blocked_start_at, r.blocked_end_at, r.reason, r.resource_id, rs.name AS resource_name
      FROM inventory_reservation r LEFT JOIN rentable_resource rs ON rs.id = r.resource_id
      WHERE r.rentable_id=${rentableId} AND r.source='owner_block' AND r.state='committed' AND r.blocked_end_at>now()
      ORDER BY r.blocked_start_at LIMIT 100`;
    const resources = listing.rental_unit === 'hour'
      ? await tx`SELECT id, name, capacity, is_active AS "isActive" FROM rentable_resource WHERE rentable_id=${rentableId} ORDER BY sort_order, name, id`
      : [];
    const format = (time) => new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
    }).format(new Date(time));
    const { id, title, capacity, booking_config, booking_config_version } = current;
    return {
      // Stored in paise; the calendar form keeps its whole-rupee default.
      listing: { id, title, capacity, extra_guest_charge: Number(current.extra_guest_charge_minor) / 100, booking_config, booking_config_version,
        rental_unit: listing.rental_unit, calendar_version: (await calendarSnapshot(tx, current)).version },
      resources,
      blocks: rows.map(row => ({ id:row.id, reason:row.reason, label:`${format(row.blocked_start_at)} – ${format(row.blocked_end_at)}`,
        resource: row.resource_id ? { id: row.resource_id, name: row.resource_name } : null })),
    };
  });
}
