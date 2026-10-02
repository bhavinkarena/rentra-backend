import 'server-only';
import { visitLabel } from '../domain/booking-record.js';
import { operatingWindows } from '../domain/hourly.js';
import { addLocalDays, propertyToday } from '../domain/booking-dates.js';

import { z } from 'zod';
import { listingInventory } from '../admin/verification.js';
import { listingPath } from '../domain/listing-url.js';
import { propertyStrength } from '../domain/listing-strength.js';

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

/** Venues open by weekly hours: the first day from today with any opening window. */
function nextWeeklyOpenDay(config) {
  if (config?.model !== 'hourly') return null;
  const today = propertyToday();
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addLocalDays(today, offset);
    if (operatingWindows(config, day).length) return day;
  }
  return null;
}

const dayOf = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);

export async function ownerPropertyOverview(database, ownerId, id) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await database`SELECT r.*, u.account_status FROM rentable r JOIN "user" u ON u.id=r.client_id
    WHERE r.id=${id} AND r.client_id=${ownerId}`;
  if (!row) return null;

  const inventory = await listingInventory(database, id, row);
  const [next] = row.rental_unit === 'hour'
    ? [{ day: nextWeeklyOpenDay(row.booking_config) }]
    : await database`SELECT min(day)::text AS day FROM availability
    WHERE rentable_id=${id} AND day >= (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND units_available > 0`;
  const visits = await database`SELECT b.id, b.reference, b.order_id, o.reference AS order_reference,
      b.local_day, b.slot, b.guests, b.state, b.starts_at, b.ends_at, b.hours_known, b.time_zone, b.slot_snapshot
    FROM booking b LEFT JOIN booking_order o ON o.id=b.order_id
    WHERE b.rentable_id=${id} AND b.state IN ${database(UPCOMING)} AND b.ends_at > now()
    ORDER BY b.starts_at LIMIT 10`;
  const [{ upcoming }] = await database`SELECT count(*)::int AS upcoming FROM booking
    WHERE rentable_id=${id} AND state IN ${database(UPCOMING)} AND ends_at > now()`;
  const audit = await database`SELECT id, actor_type, action, after, reason, at FROM audit_log
    WHERE entity='rentable' AND entity_id=${id}::text ORDER BY at DESC, id DESC LIMIT 60`;

  const publiclyVisible = row.status === 'live' && row.account_status === 'active';
  // PROP-01: when each stage of Draft → In review → Verification → Live last happened.
  const [stages] = await database`SELECT
      (SELECT max(submitted_at) FROM listing_submission WHERE rentable_id=${id}) AS submitted,
      (SELECT max(reviewed_at) FROM listing_review WHERE rentable_id=${id} AND outcome='approved_for_visit') AS approved,
      (SELECT scheduled_at FROM verification_visit WHERE rentable_id=${id} ORDER BY created_at DESC LIMIT 1) AS visit,
      (SELECT count(*)::int FROM booking WHERE rentable_id=${id} AND state IN ('confirmed','handed_over','completed')
        AND date_trunc('month', local_day) = date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)) AS month_bookings`;
  const facts = await strengthFacts(database, id);
  return {
    timeline: {
      draft: row.created_at,
      submitted: stages.submitted,
      approved: stages.approved,
      visit: stages.visit,
      live: row.published_at,
    },
    stats: {
      bookingsThisMonth: stages.month_bookings,
      rating: row.review_count ? Number(row.rating_avg) : null,
      reviewCount: row.review_count,
    },
    strength: propertyStrength(facts, { venue: row.rental_unit === 'hour' }),
    pausedUntil: row.paused_until ? dayOf(row.paused_until) : null,
    inventory: { ...inventory, nextOpenDate: next?.day ?? null },
    publicPath: publiclyVisible ? listingPath(row.slug, row.public_code) : null,
    upcomingVisits: {
      total: upcoming,
      items: visits.map((v) => ({
        id: v.id,
        reference: v.reference,
        orderId: v.order_id,
        orderReference: v.order_reference,
        date: dayOf(v.local_day),
        slot: v.slot,
        label: visitLabel(v),
        guests: v.guests,
        state: v.state,
        startsAt: v.hours_known ? v.starts_at : null,
        endsAt: v.hours_known ? v.ends_at : null,
      })),
    },
    activity: audit.map(activityEntry).filter(Boolean).slice(0, 30),
  };
}

/** One query for every fact the strength score needs. */
export async function strengthFacts(database, id) {
  const [row] = await database`SELECT
      coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(r.photos)='array' THEN r.photos END),0)::int AS photo_count,
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.photos)='array' THEN r.photos ELSE '[]'::jsonb END) p
        WHERE p->>'tag' IN ('Pool','Lawn','Court','Floodlights')) AS feature_photo,
      coalesce(trim(r.highlight),'')<>'' AS highlight,
      EXISTS (SELECT 1 FROM staff_property sp JOIN client_staff s ON s.id=sp.staff_id
        WHERE sp.rentable_id=r.id AND s.is_active AND s.revoked_at IS NULL) AS caretaker,
      CASE WHEN r.rental_unit::text='hour' THEN
        EXISTS (SELECT 1 FROM rentable_rate rr WHERE rr.rentable_id=r.id AND rr.day_kind='weekday')
        AND EXISTS (SELECT 1 FROM rentable_rate rr WHERE rr.rentable_id=r.id AND rr.day_kind='weekend')
      ELSE EXISTS (SELECT 1 FROM rentable_price p WHERE p.rentable_id=r.id)
        AND NOT EXISTS (SELECT 1 FROM rentable_price p WHERE p.rentable_id=r.id AND (p.weekday_minor=0 OR p.weekend_minor=0)) END AS both_day_prices,
      CASE WHEN r.rental_unit::text='hour' THEN coalesce((r.booking_config->>'bookingHorizonDays')::int,0)
      ELSE (SELECT count(DISTINCT a.day)::int FROM availability a WHERE a.rentable_id=r.id
        AND a.day >= (now() AT TIME ZONE 'Asia/Kolkata')::date AND a.units_available>0) END AS open_days,
      (SELECT count(*)::int FROM public_customer_review v WHERE v.rentable_id=r.id AND v.owner_reply IS NULL) AS unreplied
    FROM rentable r WHERE r.id=${id}`;
  if (!row) return null;
  return {
    photoCount: row.photo_count,
    featurePhoto: row.feature_photo,
    highlight: row.highlight,
    caretaker: row.caretaker,
    bothDayPrices: row.both_day_prices,
    openDays: row.open_days,
    unrepliedReviews: row.unreplied,
  };
}
