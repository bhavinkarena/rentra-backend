import 'server-only';
import { z } from 'zod';
import { normalizePublicPhotos } from '../domain/listing-content.js';
import { houseRuleLines } from '../domain/venue-rules.js';

/**
 * BOOK-08: what a confirmed guest needs at the gate. The owner edits it on the property;
 * the customer outbox sends it at T-24h and on the arrival morning (IST).
 */
const text = z.string().trim().max(300).default('');
const guideInput = z.object({
  landmark: text,
  parking: text,
  gatePhotoKey: z.string().trim().max(500).default(''),
  caretakerVisible: z.boolean().default(false),
});
const photosOf = (row) =>
  normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME });

const ownedProperty = (tx, ownerId, id) => tx`SELECT r.id,r.title,r.photos,r.arrival_guide FROM rentable r JOIN "user" u ON u.id=r.client_id
  WHERE r.id=${id} AND r.client_id=${ownerId} AND u.role='client' AND u.account_status='active'`;

export async function readArrivalGuide(database, ownerId, id) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await ownedProperty(database, ownerId, id);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    guide: guideInput.parse(row.arrival_guide ?? {}),
    photos: photosOf(row).map(({ url, alt }) => ({ url, alt })),
  };
}

export async function saveArrivalGuide(database, ownerId, id, input) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const guide = guideInput.parse(input ?? {});
  return database.begin(async (tx) => {
    const [row] = await tx`${ownedProperty(tx, ownerId, id)} FOR UPDATE OF r`;
    if (!row) return null;
    // Only one of this property's own public photos can be the gate photo.
    if (guide.gatePhotoKey && !photosOf(row).some((p) => p.url === guide.gatePhotoKey))
      throw Object.assign(new Error('Choose one of this property’s photos'), { code: 'INVALID_ARRIVAL_GUIDE' });
    await tx`UPDATE rentable SET arrival_guide=${JSON.stringify(guide)}::text::jsonb,updated_at=now() WHERE id=${id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('client',${ownerId},'rentable',${id},'arrival_guide_changed')`;
    return guide;
  });
}

/** The SMS text for one visit; null when the owner has not written a guide. */
export async function arrivalGuideMessage(tx, bookingId) {
  const [row] = await tx`SELECT r.id,r.photos,r.arrival_guide,ST_X(r.location) longitude,ST_Y(r.location) latitude,o.policy_snapshot
    FROM booking b JOIN rentable r ON r.id=b.rentable_id JOIN booking_order o ON o.id=b.order_id WHERE b.id=${bookingId}`;
  const parsed = guideInput.safeParse(row?.arrival_guide ?? {});
  if (!parsed.success) return null;
  const guide = parsed.data;
  if (!guide.landmark && !guide.parking && !guide.gatePhotoKey && !guide.caretakerVisible) return null;
  const [caretaker] = guide.caretakerVisible
    ? await tx`SELECT s.name,s.phone FROM client_staff s JOIN staff_property sp ON sp.staff_id=s.id
        WHERE sp.rentable_id=${row.id} AND s.is_active AND s.accepted_at IS NOT NULL AND s.revoked_at IS NULL ORDER BY s.accepted_at,s.id LIMIT 1`
    : [];
  const gate = photosOf(row).find((p) => p.url === guide.gatePhotoKey)?.url;
  return [
    row.latitude != null && `Map: https://maps.google.com/?q=${row.latitude},${row.longitude}`,
    guide.landmark && `Landmark: ${guide.landmark}`,
    guide.parking && `Parking: ${guide.parking}`,
    gate && `Gate photo: ${gate}`,
    caretaker && `Caretaker: ${caretaker.name || 'On site'} ${caretaker.phone}`,
    houseRuleLines(row.policy_snapshot?.houseRules).length &&
      `Rules: ${houseRuleLines(row.policy_snapshot?.houseRules).join('; ').slice(0, 200)}`,
  ]
    .filter(Boolean)
    .join('. ');
}

/**
 * Queue the T-24h and arrival-morning (07:00 IST) guides for confirmed visits. The outbox
 * unique key (event_key, customer, channel) dedupes; a guide queued in the last 6 hours
 * stands in for the other one, so a late booking gets one message, not two.
 */
export async function queueArrivalGuides(database) {
  const rows = await database`INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
    SELECT o.id,b.id,o.customer_id,k.prefix||b.id,'arrival_guide',clock_timestamp()
    FROM booking b JOIN booking_order o ON o.id=b.order_id JOIN rentable r ON r.id=b.rentable_id
    CROSS JOIN LATERAL (VALUES ('arrival24:',b.starts_at-interval '24 hours'),
      ('arrivalam:',(b.local_day::timestamp+time '07:00') AT TIME ZONE 'Asia/Kolkata')) k(prefix,due)
    WHERE b.state='confirmed' AND b.hours_known AND b.starts_at>clock_timestamp() AND k.due<=clock_timestamp() AND k.due<b.starts_at
      AND r.arrival_guide<>'{}'::jsonb
      AND NOT EXISTS(SELECT 1 FROM notification_outbox n WHERE n.booking_id=b.id AND n.template='arrival_guide' AND n.created_at>clock_timestamp()-interval '6 hours')
      -- When the morning one is already due, the T-24h one is superseded.
      AND NOT (k.prefix='arrival24:' AND (b.local_day::timestamp+time '07:00') AT TIME ZONE 'Asia/Kolkata'<=clock_timestamp())
    ON CONFLICT DO NOTHING RETURNING id`;
  return rows.length;
}
