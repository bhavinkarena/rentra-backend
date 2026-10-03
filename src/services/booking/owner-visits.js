import { propertyToday } from '../domain/booking-dates.js';
import { visitLabel } from '../domain/booking-record.js';
import { visitOperation } from '../domain/booking-operations.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';

// The Today dashboard and Bookings > Today share visit rows, including overnight visits.
export const ownerVisitDay = (tx, date) => tx`b.state IN ('confirmed','handed_over','returned','disputed') AND
  ((b.starts_at < (${date}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
    AND b.ends_at > ${date}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    OR (NOT b.hours_known AND b.local_day=${date}::date))`;

export async function ownerDayVisits(database, ownerId, { date = propertyToday(), event = 'all', limit = 20, offset = 0, filters = {} } = {}) {
  const day = ownerVisitDay(database, date);
  const start = database`${date}::date::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const end = database`(${date}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const eventWhere = event === 'arriving' ? database`b.hours_known AND b.starts_at >= ${start} AND b.starts_at < ${end}`
    : event === 'leaving' ? database`b.hours_known AND b.ends_at >= ${start} AND b.ends_at < ${end}`
    : event === 'on_site' ? database`b.hours_known AND b.starts_at < ${start} AND b.ends_at >= ${end}` : database`true`;
  const where = database`r.client_id=${ownerId} AND u.account_status='active' AND o.state NOT IN ('held','expired') AND ${day} AND ${eventWhere}
    AND (${filters.property || ''}='' OR r.id::text=${filters.property || ''})
    AND (${filters.resource || ''}='' OR b.resource_id::text=${filters.resource || ''})
    AND (${filters.vertical || ''}='' OR c.vertical_code=${filters.vertical || ''})
    AND (${filters.q || ''}='' OR position(lower(${filters.q || ''}) in lower(o.reference))>0
      OR position(lower(${filters.q || ''}) in lower(coalesce(o.listing_snapshot->>'title','')))>0
      OR position(lower(${filters.q || ''}) in lower(b.reference))>0 OR position(lower(${filters.q||''}) in lower(coalesce(o.listing_snapshot->'contact'->>'name','')))>0 OR position(${filters.q||''} in coalesce(o.listing_snapshot->'contact'->>'phone',''))>0)`;
  const joins = database`FROM booking b JOIN booking_order o ON o.id=b.order_id JOIN rentable r ON r.id=b.rentable_id
    JOIN "user" u ON u.id=r.client_id JOIN category c ON c.id=r.category_id`;
  const [counts] = await database`SELECT count(*)::int total ${joins} WHERE ${where}`;
  const rows = await database`SELECT b.*, r.booking_config,r.title, r.photos, c.vertical_code, o.listing_snapshot,
    o.reference order_reference,o.state order_state,o.amount_rent_minor order_rent,o.amount_fee_minor order_fee,o.amount_deposit_minor order_deposit,
    (SELECT jsonb_agg(jsonb_build_object('environment',p.environment,'state',p.state)) FROM payment_order p WHERE p.booking_order_id=o.id) payments,rs.name resource_name,clock_timestamp() as_of ${joins} LEFT JOIN rentable_resource rs ON rs.id=b.resource_id
    WHERE ${where} ORDER BY ${event === 'leaving' ? database`b.ends_at` : database`b.starts_at`} ASC NULLS LAST,b.id
    LIMIT ${Math.min(50, limit)} OFFSET ${offset}`;
  return { total: counts.total, items: rows.map(row => ({
    id: row.order_id, visitId: row.id, reference: row.order_reference, title: row.title,
    propertyId: row.rentable_id, vertical: row.vertical_code, state: row.order_state,
    visitState: row.state, guests: row.guests, firstVisit: (row.local_day instanceof Date ? row.local_day.toISOString() : String(row.local_day)).slice(0,10),
    startsAt: row.hours_known ? new Date(row.starts_at).toISOString() : null,
    endsAt: row.hours_known ? new Date(row.ends_at).toISOString() : null,
    firstVisitStartsAt: row.hours_known ? new Date(row.starts_at).toISOString() : null,
    firstVisitLabel: visitLabel(row), firstVisitSlot: row.slot, resourceName: row.resource_name,
    contact: { name: row.listing_snapshot?.contact?.name?.trim().split(/\s+/)[0] ?? null, phone: row.listing_snapshot?.contact?.phone ?? null }, operation: visitOperation(row,row.as_of,row.booking_config?.earlyArrivalMinutes??120),
    rentMinor: Number(row.order_rent), feeMinor: Number(row.order_fee), depositMinor: Number(row.order_deposit),
    photo: normalizePublicPhotos(row.photos,{cloudName:process.env.CLOUDINARY_CLOUD_NAME})[0] ?? null,
    visitCount: 1, visitStates: [row.state], payments: row.payments ?? [],
  })) };
}
