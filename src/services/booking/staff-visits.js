import 'server-only';

import { z } from 'zod';
import { visitEvidenceRecords } from './visit-evidence.js';

/**
 * What a caretaker may see (CP16): visits on currently assigned properties of
 * the owner who invited them. No money (rent, fees, deposits, payments,
 * refunds), no customer identity and no other property. Assignment is joined
 * in every query, so a reassignment applies to the very next request.
 */

const uuid = z.string().uuid();
const TABS = ['today', 'upcoming', 'action_needed', 'past'];
const instant = (value) => (value ? new Date(value).toISOString() : null);
const dayOf = (row) => {
  const value = row.local_day ?? row.day;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
};

/** The caretaker's own assigned properties, owner-checked. */
const assigned = (database, staff) =>
  database`EXISTS (SELECT 1 FROM staff_property sp JOIN rentable ar ON ar.id=sp.rentable_id
    WHERE sp.staff_id=${staff.id} AND sp.rentable_id=b.rentable_id AND ar.client_id=${staff.ownerId})`;

const visitDTO = (row) => ({
  id: row.id,
  reference: row.reference,
  orderId: row.order_id,
  propertyTitle: row.title,
  date: dayOf(row),
  slot: row.slot,
  guests: row.guests,
  state: row.state,
  startsAt: row.hours_known ? instant(row.starts_at) : null,
  endsAt: row.hours_known ? instant(row.ends_at) : null,
  version: row.lifecycle_version,
  provenance: row.visit_provenance,
});

export async function listStaffVisits(database, staff, input = {}) {
  const tab = TABS.includes(input?.tab) ? input.tab : 'today';
  const now = database`clock_timestamp()`;
  const dayStart = database`(date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
  const conditions = {
    today: database`b.state IN ('confirmed','handed_over','returned','disputed') AND b.starts_at < ${dayStart} + interval '1 day' AND b.ends_at > ${dayStart}`,
    upcoming: database`b.state IN ('confirmed','handed_over') AND b.ends_at > ${now}`,
    action_needed: database`(b.state='returned' OR (b.state='confirmed' AND b.starts_at <= ${now}) OR (b.state='handed_over' AND b.ends_at <= ${now}))`,
    past: database`b.state IN ('returned','completed','disputed') AND b.ends_at <= ${now}`,
  };
  const scope = database`b.order_id IS NOT NULL AND ${assigned(database, staff)}`;
  const [counts] = await database`SELECT
      count(*) FILTER (WHERE ${conditions.today})::int AS today,
      count(*) FILTER (WHERE ${conditions.upcoming})::int AS upcoming,
      count(*) FILTER (WHERE ${conditions.action_needed})::int AS action_needed,
      count(*) FILTER (WHERE ${conditions.past})::int AS past
    FROM booking b WHERE ${scope}`;
  const rows = await database`SELECT b.*, r.title FROM booking b JOIN rentable r ON r.id=b.rentable_id
    WHERE ${scope} AND ${conditions[tab]}
    ORDER BY ${tab === 'past' ? database`b.starts_at DESC` : database`b.starts_at ASC`}, b.id LIMIT 50`;
  return { tab, counts, items: rows.map(visitDTO) };
}

/** One booking's visits for an assigned property; a foreign or guessed id reads as missing. */
export async function readStaffVisitRecord(database, staff, orderId) {
  if (!uuid.safeParse(orderId).success) return null;
  return database.begin(async (tx) => {
    const rows = await tx`SELECT b.*, r.title, o.reference AS order_reference, o.time_zone, o.policy_snapshot
      FROM booking b JOIN booking_order o ON o.id=b.order_id JOIN rentable r ON r.id=b.rentable_id
      WHERE b.order_id=${orderId} AND ${assigned(tx, staff)} ORDER BY b.item_position NULLS LAST, b.day, b.id`;
    if (!rows.length) return null;
    const records = await visitEvidenceRecords(tx, orderId, 'staff');
    const visits = rows.map((row) => ({
      ...visitDTO(row),
      evidence: records.evidence.get(row.id) ?? [],
      incidents: records.incidents.get(row.id) ?? [],
    }));
    const onSite = visits.some((v) => ['confirmed', 'handed_over', 'returned', 'disputed'].includes(v.state));
    const [place] = onSite
      ? await tx`SELECT exact_address FROM rentable WHERE id=${rows[0].rentable_id}`
      : [];
    const rules = rows[0].policy_snapshot?.houseRules;
    return {
      orderId,
      reference: rows[0].order_reference,
      propertyTitle: rows[0].title,
      timeZone: rows[0].time_zone || 'Asia/Kolkata',
      visits,
      // Operational contact: where to go and whom to call. The owner, never the guest's account.
      arrival: onSite
        ? { address: place?.exact_address ?? null, ownerName: staff.ownerName, ownerPhone: staff.ownerPhone }
        : null,
      houseRules: Array.isArray(rules) ? rules.filter((rule) => typeof rule === 'string') : [],
      canRecord: staff.capabilities.includes('staff.assigned-visits.evidence'),
    };
  });
}
