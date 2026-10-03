import { offlineBookings } from '../booking/owner-experience.js';
import { z } from 'zod';
import { forbidden } from '../../utils/apiError.js';
import { clientTasks } from './client-inbox.js';
import { ownerDayVisits, ownerVisitDay } from '../booking/owner-visits.js';
import { propertyToday, addLocalDays } from '../domain/booking-dates.js';
import { visitLabel } from '../domain/booking-record.js';
import { financeStatement } from '../finance/statements.js';
import { getListingForEdit } from '../db/listing-queries.js';
import { listingCompletion } from '../domain/listing-completion.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';

export const todaySection = z.enum([
  'needsYou',
  'visits',
  'week',
  'earnings',
  'properties',
  'analytics',
]);

export function bookedRent(items) {
  const seen = new Set();
  return items
    .reduce((total, item) => {
      if (item.component !== 'rent' || seen.has(item.bookingId)) return total;
      seen.add(item.bookingId);
      return total + BigInt(item.quoteRentMinor ?? 0);
    }, 0n)
    .toString();
}

async function needsYou(database, ownerId) {
  const [base, dates, reviews, disputes, support, incidents, autoOpen] = await Promise.all([
    clientTasks(database, ownerId),
    database`SELECT r.id,r.title,max(a.day)::text last_day FROM rentable r JOIN availability a ON a.rentable_id=r.id
      WHERE r.client_id=${ownerId} AND r.status='live' AND r.rental_unit::text<>'hour' AND coalesce(r.booking_config->>'autoOpen','false')<>'true' AND a.units_available>0
        AND a.day>=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date
      GROUP BY r.id HAVING max(a.day)<=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+14`,
    database`SELECT v.id,r.title FROM public_customer_review v JOIN rentable r ON r.id=v.rentable_id
      WHERE r.client_id=${ownerId} AND v.owner_reply IS NULL ORDER BY v.id LIMIT 20`,
    database`SELECT id,subject FROM dispute_case WHERE owner_id=${ownerId} AND state='open' AND requested_party='owner' ORDER BY response_due NULLS LAST,id LIMIT 20`,
    database`SELECT id,subject FROM support_request WHERE client_id=${ownerId} AND state='waiting_customer' ORDER BY updated_at,id LIMIT 20`,
    database`SELECT i.id,b.order_id,r.title FROM visit_incident i JOIN booking b ON b.id=i.booking_id JOIN rentable r ON r.id=b.rentable_id WHERE r.client_id=${ownerId} AND i.state='open' ORDER BY i.created_at DESC LIMIT 20`,
    // CAL-02: properties that predate auto-open have never recorded a choice; offer it once.
    database`SELECT id,title FROM rentable WHERE client_id=${ownerId} AND status='live' AND rental_unit::text<>'hour'
      AND (booking_config->>'inventoryReady')='true' AND NOT (booking_config ? 'autoOpen') ORDER BY title,id LIMIT 20`,
  ]);
  return {
    tasks: [
      ...base.tasks.filter(
        (t) => t.key !== 'visits_today' && !(t.key === 'updates_unread' && base.actionUnread > 0),
      ),
      ...autoOpen.map((r) => ({
        key: `auto_open_offer:${r.id}`,
        kind: 'action',
        count: 1,
        label: `Keep ${r.title} open automatically?`,
        href: `/partner/listings/${r.id}/booking-rules#auto-open`,
        action: 'Turn on',
      })),
      ...dates.map((r) => ({
        key: `dates_running_out:${r.id}`,
        kind: 'action',
        count: 1,
        label: `${r.title}: open dates end on ${r.last_day}.`,
        href: `/partner/listings/${r.id}/calendar`,
        action: 'Open more dates',
      })),
      ...reviews.map((r) => ({
        key: `reviews_unreplied:${r.id}`,
        kind: 'action',
        count: 1,
        label: `Reply to a guest review of ${r.title}.`,
        href: `/partner/reviews/${r.id}`,
        action: 'Reply',
      })),
      ...disputes.map((r) => ({
        key: `dispute_response_requested:${r.id}`,
        kind: 'action',
        count: 1,
        label: `Rentra needs your response: ${r.subject}.`,
        href: `/partner/disputes/${r.id}`,
        action: 'Respond',
      })),
      ...incidents.map((r) => ({
        key: `visit_incident:${r.id}`,
        kind: 'action',
        count: 1,
        label: `An incident was reported at ${r.title}.`,
        href: `/partner/bookings/${r.order_id}`,
        action: 'Read report',
      })),
      ...support.map((r) => ({
        key: `support_awaiting_owner:${r.id}`,
        kind: 'action',
        count: 1,
        label: `Reply to Rentra about ${r.subject}.`,
        href: `/partner/support/${r.id}`,
        action: 'Reply',
      })),
    ],
  };
}

async function visits(database, ownerId) {
  const today = propertyToday();
  const [all, arrivals, departures, onSite, [next]] = await Promise.all([
    ownerDayVisits(database, ownerId, { limit: 0 }),
    ownerDayVisits(database, ownerId, { event: 'arriving', limit: 5 }),
    ownerDayVisits(database, ownerId, { event: 'leaving', limit: 5 }),
    ownerDayVisits(database, ownerId, { event: 'on_site', limit: 5 }),
    database`SELECT b.*,r.title,rs.name resource_name FROM booking b JOIN booking_order o ON o.id=b.order_id
      JOIN rentable r ON r.id=b.rentable_id LEFT JOIN rentable_resource rs ON rs.id=b.resource_id
      WHERE r.client_id=${ownerId} AND o.state NOT IN ('held','expired') AND b.state='confirmed' AND b.hours_known
        AND b.starts_at>=(${today}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata' ORDER BY b.starts_at,b.id LIMIT 1`,
  ]);
  return {
    date: today,
    offline: await offlineBookings(database, ownerId),
    total: all.total,
    arrivals: arrivals.items,
    arrivalCount: arrivals.total,
    departures: departures.items,
    departureCount: departures.total,
    onSite: onSite.items,
    onSiteCount: onSite.total,
    next: next
      ? {
          title: next.title,
          startsAt: new Date(next.starts_at).toISOString(),
          label: visitLabel(next),
          href: `/partner/bookings/${next.order_id}#visit-${next.id}`,
        }
      : null,
  };
}

async function week(database, ownerId) {
  const today = propertyToday(),
    dates = Array.from({ length: 7 }, (_, i) => addLocalDays(today, i));
  return database`WITH visits AS (SELECT b.*,r.title FROM booking b JOIN booking_order o ON o.id=b.order_id
    JOIN rentable r ON r.id=b.rentable_id WHERE r.client_id=${ownerId} AND o.state NOT IN ('held','expired'))
    SELECT d.value AS date,count(b.id)::int count,coalesce(array_agg(DISTINCT b.title) FILTER(WHERE b.id IS NOT NULL),'{}') properties
    FROM jsonb_array_elements_text(${JSON.stringify(dates)}::jsonb) d(value) LEFT JOIN visits b ON ${ownerVisitDay(database, database`d.value::date`)} GROUP BY d.value ORDER BY d.value`;
}

async function earnings(database, ownerId) {
  const statement = await financeStatement(
    database,
    { kind: 'owner', id: ownerId },
    { period: propertyToday().slice(0, 7) },
  );
  return {
    bookedRentMinor: bookedRent(statement.items),
    status: statement.settlementNotice,
    environment: statement.filters.environment,
    period: statement.filters.period,
    basis: statement.basis,
  };
}

async function properties(database, ownerId) {
  const rows = await database`SELECT r.id,r.title,r.status,r.photos,
    (SELECT row_to_json(v) FROM (SELECT b.*,rs.name resource_name FROM booking b JOIN booking_order o ON o.id=b.order_id LEFT JOIN rentable_resource rs ON rs.id=b.resource_id
      WHERE b.rentable_id=r.id AND o.state NOT IN ('held','expired') AND b.state IN ('confirmed','handed_over') AND b.ends_at>clock_timestamp()
      ORDER BY b.starts_at,b.id LIMIT 1) v) next
    FROM rentable r WHERE r.client_id=${ownerId} ORDER BY r.updated_at DESC,r.id LIMIT 6`;
  // ponytail: reuse editor completeness for six cards; batch the editor reads if portfolios require more cards.
  return Promise.all(
    rows.map(async (row) => {
      const edit = await getListingForEdit(row.id, ownerId);
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        photo:
          normalizePublicPhotos(row.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME })[0] ??
          null,
        strength: edit ? listingCompletion(edit.listing, edit).percent : null,
        next: row.next
          ? {
              startsAt: row.next.hours_known ? new Date(row.next.starts_at).toISOString() : null,
              label: visitLabel(row.next),
            }
          : null,
      };
    }),
  );
}

async function analytics(database, ownerId) {
  const today = propertyToday();
  const [daily, monthly, statuses, categories] = await Promise.all([
    database`WITH days AS (SELECT generate_series(${today}::date-89,${today}::date,'1 day')::date AS visit_day),
      bookings AS (SELECT b.local_day AS visit_day,b.state,b.amount_rent_minor FROM booking b JOIN booking_order o ON o.id=b.order_id
        WHERE o.listing_snapshot->>'ownerId'=${ownerId}::text AND o.state NOT IN ('draft','held','expired'))
      SELECT d.visit_day::text date,count(b.visit_day)::int visits,
        coalesce(sum(b.amount_rent_minor) FILTER(WHERE b.state<>'cancelled'),0)::text "rentMinor",
        count(b.visit_day) FILTER(WHERE b.state='cancelled')::int cancelled
      FROM days d LEFT JOIN bookings b ON b.visit_day=d.visit_day GROUP BY d.visit_day ORDER BY d.visit_day`,
    database`WITH months AS (SELECT generate_series(date_trunc('month',${today}::date)-interval '11 months',date_trunc('month',${today}::date),'1 month')::date AS month_start)
      SELECT m.month_start::text date,count(b.id)::int visits,
        coalesce(sum(b.amount_rent_minor) FILTER(WHERE b.state<>'cancelled'),0)::text "rentMinor"
      FROM months m LEFT JOIN (booking b JOIN booking_order o ON o.id=b.order_id
        AND o.listing_snapshot->>'ownerId'=${ownerId}::text AND o.state NOT IN ('draft','held','expired'))
        ON b.local_day>=m.month_start AND b.local_day<(m.month_start+interval '1 month') AND b.local_day<=${today}::date
      GROUP BY m.month_start ORDER BY m.month_start`,
    database`SELECT b.state::text label,count(*)::int value FROM booking b JOIN booking_order o ON o.id=b.order_id
      WHERE o.listing_snapshot->>'ownerId'=${ownerId}::text AND o.state NOT IN ('draft','held','expired')
        AND b.local_day BETWEEN ${today}::date-89 AND ${today}::date GROUP BY b.state ORDER BY value DESC`,
    database`SELECT coalesce(c.vertical_code,'Other') label,count(*)::int value FROM rentable r LEFT JOIN category c ON c.id=r.category_id
      WHERE r.client_id=${ownerId} GROUP BY c.vertical_code ORDER BY value DESC`,
  ]);
  return { today, daily, monthly, statuses, categories };
}

const readers = { needsYou, visits, week, earnings, properties, analytics };
export async function ownerToday(database, ownerId, section) {
  const [owner] =
    await database`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active'`;
  if (!owner) throw forbidden();
  if (section) return readers[todaySection.parse(section)](database, ownerId);
  const result = {};
  await Promise.all(
    Object.entries(readers).map(async ([key, read]) => {
      try {
        result[key] = await read(database, ownerId);
      } catch {
        result[key] = { error: 'This section could not load.' };
      }
    }),
  );
  return {
    ...result,
    needsYou: result.needsYou.tasks ?? result.needsYou,
    arrivals: result.visits.arrivals ?? [],
    departures: result.visits.departures ?? [],
  };
}
