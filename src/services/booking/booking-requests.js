import 'server-only';
import { z } from 'zod';
import { withListingInventory, expireInventoryHolds, InventoryError } from './inventory.js';
import { checkoutHoldDeadline, checkoutStatus, lifecycle } from './checkout.js';
import { releaseHotelRooms } from './hotel-stays.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';

/**
 * Request to book (owner side). A request is a held order whose 'approval_requested'
 * event has no answer yet; holds past their deadline count as expired.
 */
export async function listBookingRequests(database, ownerId) {
  const rows = await database`SELECT o.id, o.reference, o.hold_expires_at, o.amount_rent_minor::text rent_minor, o.created_at,
      r.id rentable_id, r.title, u.name customer_name,
      min(b.starts_at) starts_at, max(b.ends_at) ends_at, max(b.guests) guests, count(b.id)::int visits,
      (array_agg(b.slot::text ORDER BY b.starts_at))[1] slot
    FROM booking_order o JOIN rentable r ON r.id=o.rentable_id JOIN "user" u ON u.id=o.customer_id
    JOIN booking b ON b.order_id=o.id
    WHERE r.client_id=${ownerId} AND o.state='held' AND o.hold_expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM booking_lifecycle_event WHERE order_id=o.id AND kind='approval_requested')
      AND NOT EXISTS(SELECT 1 FROM booking_lifecycle_event WHERE order_id=o.id AND kind IN ('owner_approved','owner_declined'))
    GROUP BY o.id, r.id, u.name ORDER BY o.hold_expires_at LIMIT 50`;
  return rows.map((row) => ({
    orderId: row.id, reference: row.reference, propertyId: row.rentable_id, propertyTitle: row.title,
    customerName: row.customer_name || 'Guest', guests: row.guests, visits: row.visits, slot: row.slot,
    startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(),
    rentMinor: row.rent_minor, requestedAt: new Date(row.created_at).toISOString(),
    respondBy: new Date(row.hold_expires_at).toISOString(),
  }));
}

/** Accept: the guest gets a payment window. Decline: the dates go back on sale. */
export async function decideBookingRequest(database, ownerId, { orderId, approve }) {
  z.string().uuid().parse(orderId);
  z.boolean().parse(approve);
  const [scope] = await database`SELECT rentable_id FROM booking_order WHERE id=${orderId}`;
  if (!scope) throw new InventoryError('BOOKING_REQUEST_NOT_FOUND', 'Booking request unavailable.');
  return withListingInventory(database, scope.rentable_id, async (tx, listing) => {
    const [owner] = await tx`SELECT 1 FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`;
    if (!owner || listing.client_id !== ownerId) throw new InventoryError('BOOKING_REQUEST_NOT_FOUND', 'Booking request unavailable.');
    await expireInventoryHolds(tx, listing.id);
    const current = await checkoutStatus(tx, orderId);
    if (current.state !== 'held' || current.approval !== 'pending') {
      throw new InventoryError('REQUEST_CLOSED', 'This request was already answered or has expired.');
    }
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    if (approve) {
      const [visit] = await tx`SELECT min(starts_at) starts_at FROM booking WHERE order_id=${orderId}`;
      let payBy;
      try {
        payBy = checkoutHoldDeadline(now, visit.starts_at, BOOKING_POLICY.payHoursAfterApproval * 60).toISOString();
      } catch {
        throw new InventoryError('REQUEST_CLOSED', 'This visit has already started.');
      }
      await tx`UPDATE booking_order SET hold_expires_at=${payBy},updated_at=clock_timestamp() WHERE id=${orderId}`;
      await tx`UPDATE inventory_reservation r SET hold_expires_at=${payBy} FROM booking b
        WHERE r.booking_id=b.id AND b.order_id=${orderId} AND r.state='held'`;
      await lifecycle(tx, orderId, 'owner_approved', { payBy });
    } else {
      await tx`UPDATE booking_order SET state='expired',updated_at=clock_timestamp() WHERE id=${orderId} AND state='held'`;
      await tx`UPDATE inventory_reservation r SET state='expired',released_at=clock_timestamp()
        FROM booking b WHERE r.booking_id=b.id AND b.order_id=${orderId} AND r.state='held'`;
      const bookings = await tx`UPDATE booking SET state='cancelled',cancelled_at=clock_timestamp(),cancelled_by_kind='client',
        cancellation_reason='Owner declined the request',lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp()
        WHERE order_id=${orderId} AND state='requested' RETURNING id,slot::text slot`;
      for (const booking of bookings) if (booking.slot === 'stay') await releaseHotelRooms(tx, booking.id);
      await lifecycle(tx, orderId, 'owner_declined', {});
    }
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action)
      VALUES('client',${ownerId},'booking_order',${orderId},${approve ? 'booking_request_approved' : 'booking_request_declined'})`;
    return checkoutStatus(tx, orderId);
  });
}

/** Owner choice per property: instant book (default) or confirm each request first. */
export async function setInstantBook(database, ownerId, { rentableId, enabled }) {
  z.string().uuid().parse(rentableId);
  z.boolean().parse(enabled);
  const [row] = await database`UPDATE rentable SET instant_book=${enabled},updated_at=now()
    WHERE id=${rentableId} AND client_id=${ownerId} RETURNING id`;
  if (!row) throw new InventoryError('BOOKING_REQUEST_NOT_FOUND', 'Property unavailable.');
  await database`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after")
    VALUES('client',${ownerId},'rentable',${rentableId},'instant_book_changed',${JSON.stringify({ instantBook: enabled })}::text::jsonb)`;
  return { instantBook: enabled };
}
