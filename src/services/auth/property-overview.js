import 'server-only';

import { z } from 'zod';
import { listingInventory } from '../admin/verification.js';
import { listingPath } from '../domain/listing-url.js';

/**
 * The owner's property operations overview (CP09): saleable inventory,
 * upcoming visits and a client-safe activity history, scoped by owner in the
 * query itself. Another owner's id returns null, never their property.
 */

const UPCOMING = ['confirmed', 'handed_over'];

/**
 * Admin events the owner may see, with the only detail they may see. Reasons
 * are included only where the admin form says the reason is shown to the
 * client; verification findings, notes and assignment stay internal.
 */
const ADMIN_EVENTS = {
  listing_review_decided: (row) => ({ outcome: row.after?.outcome ?? null, reason: row.reason }),
  verification_scheduled: (row) => ({ mode: row.after?.mode ?? null }),
  verification_rescheduled: () => ({}),
  verification_cancelled: () => ({}),
  verification_recorded: (row) => ({ outcome: row.after?.outcome ?? null }),
  listing_published: () => ({}),
  listing_hidden: (row) => ({ reason: row.reason }),
  listing_restored: (row) => ({ status: row.after?.status ?? null }),
  listing_corrected: (row) => ({ fields: Object.keys(row.after ?? {}), reason: row.reason }),
};

function activityEntry(row) {
  const base = { id: row.id, action: row.action, at: row.at };
  if (row.actor_type === 'admin') {
    const detail = ADMIN_EVENTS[row.action];
    return detail ? { ...base, actor: 'rentra', ...detail(row) } : null;
  }
  if (row.actor_type === 'client') {
    const status = row.after?.status ?? null;
    return { ...base, actor: 'you', ...(status ? { status } : {}) };
  }
  return { ...base, actor: 'system' };
}

const dayOf = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);

export async function ownerPropertyOverview(database, ownerId, id) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await database`SELECT r.*, u.account_status FROM rentable r JOIN "user" u ON u.id=r.client_id
    WHERE r.id=${id} AND r.client_id=${ownerId}`;
  if (!row) return null;

  const inventory = await listingInventory(database, id, row);
  const [next] = await database`SELECT min(day)::text AS day FROM availability
    WHERE rentable_id=${id} AND day >= (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND units_available > 0 AND blocked_by_client = false`;
  const visits = await database`SELECT b.id, b.reference, b.order_id, o.reference AS order_reference,
      b.local_day, b.day, b.slot, b.guests, b.state, b.starts_at, b.ends_at, b.hours_known
    FROM booking b LEFT JOIN booking_order o ON o.id=b.order_id
    WHERE b.rentable_id=${id} AND b.state IN ${database(UPCOMING)} AND b.ends_at > now()
    ORDER BY b.starts_at LIMIT 10`;
  const [{ upcoming }] = await database`SELECT count(*)::int AS upcoming FROM booking
    WHERE rentable_id=${id} AND state IN ${database(UPCOMING)} AND ends_at > now()`;
  const audit = await database`SELECT id, actor_type, action, after, reason, at FROM audit_log
    WHERE entity='rentable' AND entity_id=${id}::text ORDER BY at DESC, id DESC LIMIT 60`;

  const publiclyVisible = row.status === 'live' && row.account_status === 'active';
  return {
    inventory: { ...inventory, nextOpenDate: next?.day ?? null },
    publicPath: publiclyVisible ? listingPath(row.slug, row.public_code) : null,
    upcomingVisits: {
      total: upcoming,
      items: visits.map((v) => ({
        id: v.id,
        reference: v.reference,
        orderId: v.order_id,
        orderReference: v.order_reference,
        date: dayOf(v.local_day ?? v.day),
        slot: v.slot,
        guests: v.guests,
        state: v.state,
        startsAt: v.hours_known ? v.starts_at : null,
        endsAt: v.hours_known ? v.ends_at : null,
      })),
    },
    activity: audit.map(activityEntry).filter(Boolean).slice(0, 30),
  };
}
