import 'server-only';
import { z } from 'zod';
import { venueResourcesSchema } from '../schemas/zod/listing.js';
import { bookingModel } from '../domain/verticals.js';
import { conflict, notFound, unprocessable } from '../../utils/apiError.js';
import { withListingInventory } from './inventory.js';
import { ownerEditEffect } from '../domain/listing-lifecycle.js';

/**
 * Courts, lanes and stations of a time-booked venue (entertainment plan, Phase 4).
 * Upsert by id; a court missing from the list, or sent with isActive=false, is
 * deactivated — never deleted, because bookings reference it. A court with a
 * future held or confirmed booking cannot be deactivated or lose that
 * booking's activity (RESOURCE_HAS_BOOKINGS).
 */
export async function saveVenueResources(database, ownerId, { rentableId, expectedVersion, resources }) {
  z.string().uuid().parse(rentableId);
  const parsed = venueResourcesSchema.safeParse({ resources });
  if (!parsed.success) throw unprocessable(parsed.error.flatten().fieldErrors);
  const input = parsed.data.resources;
  return withListingInventory(database, rentableId, async (tx, listing) => {
    const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND (account_status='active' OR (account_status='pending_application' AND ${listing.status}='draft')) FOR SHARE`;
    if (!owner || listing.client_id !== ownerId) throw notFound();
    if (bookingModel(listing) !== 'hourly') throw conflict('UNSUPPORTED_INVENTORY', 'Courts apply to time-booked venues only.');
    if (!Number.isInteger(expectedVersion) || expectedVersion !== listing.content_version) {
      throw conflict('LISTING_CHANGED', 'The venue changed. Reload the latest version and try again.');
    }
    const activities = await tx`SELECT c.id,c.slug FROM category c
      WHERE c.is_active AND c.default_rental_unit::text='hour'
        AND c.vertical_code=(SELECT vertical_code FROM category WHERE id=${listing.category_id})`;
    const activityId = new Map(activities.map((row) => [row.slug, row.id]));
    const unknown = [...new Set(input.flatMap((row) => row.activities))].filter((slug) => !activityId.has(slug));
    if (unknown.length) throw unprocessable({ resources: [`Unknown activity: ${unknown.join(', ')}`] });
    const existing = await tx`SELECT r.id, r.is_active, r.name, r.capacity, r.is_indoor, r.details,
        COALESCE(json_agg(a.category_id) FILTER (WHERE a.category_id IS NOT NULL), '[]'::json) AS activities
      FROM rentable_resource r LEFT JOIN rentable_resource_activity a ON a.resource_id=r.id
      WHERE r.rentable_id=${rentableId} GROUP BY r.id`;
    const known = new Map(existing.map((row) => [row.id, row]));
    for (const row of input) if (row.id && !known.has(row.id)) throw notFound('RESOURCE_NOT_FOUND', 'That court is not part of this venue.');

    // Future bookings that a deactivation or an activity removal would strand.
    const booked = await tx`SELECT b.resource_id, b.slot_snapshot->'activity'->>'id' AS activity_id, count(*)::int AS n
      FROM booking b JOIN inventory_reservation r ON r.booking_id=b.id AND r.state IN ('held','committed')
      WHERE b.rentable_id=${rentableId} AND b.resource_id IS NOT NULL AND b.ends_at > clock_timestamp()
      GROUP BY b.resource_id, b.slot_snapshot->'activity'->>'id'`;
    const stranded = [];
    for (const row of booked) {
      const next = input.find((item) => item.id === row.resource_id);
      const keepsActivity = next?.activities.some((slug) => activityId.get(slug) === row.activity_id);
      if (!next || !next.isActive || !keepsActivity) stranded.push(row.resource_id);
    }
    if (stranded.length) {
      const ids = [...new Set(stranded)];
      const names = ids.map((id) => known.get(id)?.name ?? 'A court').join(', ');
      throw conflict('RESOURCE_HAS_BOOKINGS', `${names}: upcoming bookings keep ${ids.length === 1 ? 'this court' : 'these courts'} active with the booked activities. Cancel or finish those bookings first.`);
    }

    const saved = [];
    for (const row of input) {
      const values = { name: row.name, capacity: row.capacity, isIndoor: row.isIndoor, details: row.details, sortOrder: row.sortOrder, isActive: row.isActive };
      const [resource] = row.id
        ? await tx`UPDATE rentable_resource SET name=${values.name},capacity=${values.capacity},is_indoor=${values.isIndoor},
            details=${JSON.stringify(values.details)}::text::jsonb,sort_order=${values.sortOrder},is_active=${values.isActive},updated_at=now()
            WHERE id=${row.id} AND rentable_id=${rentableId} RETURNING id`
        : await tx`INSERT INTO rentable_resource(rentable_id,name,capacity,is_indoor,details,sort_order,is_active)
            VALUES (${rentableId},${values.name},${values.capacity},${values.isIndoor},${JSON.stringify(values.details)}::text::jsonb,${values.sortOrder},${values.isActive})
            RETURNING id`;
      const wanted = row.activities.map((slug) => activityId.get(slug));
      await tx`DELETE FROM rentable_resource_activity WHERE resource_id=${resource.id} AND NOT (category_id = ANY(${wanted}::uuid[]))`;
      for (const categoryId of wanted) {
        await tx`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) VALUES (${resource.id},${rentableId},${categoryId})
          ON CONFLICT DO NOTHING`;
      }
      saved.push(resource.id);
    }
    const missing = existing.filter((row) => !saved.includes(row.id) && row.is_active).map((row) => row.id);
    if (missing.length) await tx`UPDATE rentable_resource SET is_active=false,updated_at=now() WHERE id IN ${tx(missing)}`;

    const [{ primary_offered: primaryOffered, max_capacity: maxCapacity }] = await tx`SELECT
      EXISTS (SELECT 1 FROM rentable_resource_activity a JOIN rentable_resource r ON r.id=a.resource_id AND r.is_active
        WHERE a.rentable_id=${rentableId} AND a.category_id=${listing.category_id}) AS primary_offered,
      (SELECT max(capacity) FROM rentable_resource WHERE rentable_id=${rentableId} AND is_active) AS max_capacity`;
    if (!primaryOffered) throw unprocessable({ resources: ['At least one active court must offer the venue’s main activity.'] });
    // Denormalised like rating_avg: generic capacity filters keep working for venues.
    await tx`UPDATE rentable SET capacity=${maxCapacity ?? 1},updated_at=now() WHERE id=${rentableId}`;
    // Courts are trust content, like photos and capacity: a change on a live venue goes back to review.
    // Reordering alone is not a change of facts.
    const facts = (rows) => JSON.stringify(rows.filter((r) => r.isActive).map((r) => [r.name, r.capacity, r.isIndoor ?? null, r.details ?? {}, [...r.activities].sort()])
      .sort((a, b) => a[0].localeCompare(b[0])));
    const byId = new Map(activities.map((row) => [row.id, row.slug]));
    const beforeFacts = facts(existing.map((r) => ({ name: r.name, capacity: r.capacity, isIndoor: r.is_indoor, details: r.details, isActive: r.is_active, activities: r.activities.map((id) => byId.get(id) ?? id) })));
    const effect = ownerEditEffect({ status: listing.status, priorStatus: listing.prior_status }, beforeFacts !== facts(input));
    if (effect.sentBack) {
      await tx`UPDATE rentable SET status=${effect.patch.status ?? listing.status}, prior_status=${effect.patch.priorStatus ?? listing.prior_status}, updated_at=now() WHERE id=${rentableId}`;
    }
    const [after] = await tx`SELECT content_version FROM rentable WHERE id=${rentableId}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after")
      VALUES ('client',${ownerId},'rentable',${rentableId},'venue_resources_changed',${JSON.stringify({ resources: input, deactivated: missing })}::text::jsonb)`;
    return { ok: true, contentVersion: after.content_version, resourceIds: saved, sentBack: effect.sentBack };
  });
}
