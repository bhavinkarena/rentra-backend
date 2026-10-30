import 'server-only';
import { z } from 'zod';
import { badRequest, forbidden } from '@/utils/apiError.js';
import { addLocalDays, propertyToday } from '../domain/booking-dates.js';

/**
 * Hotel analytics (hotel plan §5.9 owner MVP metrics, §6 admin). Room-night
 * figures come from booking_room nights (one row per room, a price per night),
 * so occupancy, ADR and RevPAR count rooms, not bookings. Revenue is room
 * revenue before tax. Every query is scoped before it aggregates: an owner
 * never sees another owner's rows.
 */
const range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hotelId: z.string().uuid().optional().or(z.literal('')),
  cityId: z.string().uuid().optional().or(z.literal('')),
}).passthrough();

function period(input) {
  const parsed = range.safeParse(input ?? {});
  if (!parsed.success) throw badRequest('INVALID_FILTER', 'Choose valid dates.');
  const to = parsed.data.to ?? propertyToday();
  const from = parsed.data.from ?? addLocalDays(to, -29);
  if (from > to || addLocalDays(from, 366) < to) throw badRequest('INVALID_FILTER', 'Choose up to one year, oldest date first.');
  return { from, to, hotelId: parsed.data.hotelId || null, cityId: parsed.data.cityId || null };
}

const ratio = (a, b) => (b > 0 ? a / b : 0);
const n = (value) => Number(value ?? 0);

/** Sold room-nights and their room revenue per night, for the scoped hotels. */
function soldNights(sql, scope, from, to) {
  return sql`SELECT (night->>'night')::date AS night, count(*) FILTER (WHERE (night->>'night')::date < coalesce(br.inventory_end,br.check_out))::int AS rooms, sum((night->>'rateMinor')::bigint)::text AS revenue
    FROM booking_room br JOIN rentable r ON r.id = br.rentable_id, jsonb_array_elements(br.nights) night
    WHERE br.state IN ('booked', 'stayed', 'no_show') AND (night->>'night')::date BETWEEN ${from}::date AND ${to}::date AND ${scope}
    GROUP BY 1`;
}

/** Rooms offered per night: the night's open allotment, else the room type's count; closed nights offer none. */
function offeredNights(sql, scope, from, to) {
  return sql`SELECT d::date AS night, sum(CASE WHEN rn.stop_sell THEN 0 ELSE coalesce(rn.allotment, rt.room_count) END)::int AS rooms
    FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
    CROSS JOIN room_type rt JOIN rentable r ON r.id = rt.rentable_id
    LEFT JOIN room_night rn ON rn.room_type_id = rt.id AND rn.night = d::date
    WHERE rt.is_active AND r.status = 'live' AND ${scope}
    GROUP BY 1`;
}

function daily(from, to, sold, offered) {
  const soldBy = new Map(sold.map((row) => [String(row.night instanceof Date ? row.night.toISOString().slice(0, 10) : row.night), row]));
  const offeredBy = new Map(offered.map((row) => [String(row.night instanceof Date ? row.night.toISOString().slice(0, 10) : row.night), row.rooms]));
  const days = [];
  for (let day = from; day <= to; day = addLocalDays(day, 1)) {
    const s = soldBy.get(day);
    days.push({ date: day, roomsSold: s?.rooms ?? 0, roomsOffered: offeredBy.get(day) ?? 0, revenueMinor: n(s?.revenue) });
  }
  return days;
}

function kpis(days, bookings) {
  const sold = days.reduce((sum, d) => sum + d.roomsSold, 0);
  const offered = days.reduce((sum, d) => sum + d.roomsOffered, 0);
  const revenue = days.reduce((sum, d) => sum + d.revenueMinor, 0);
  return {
    bookings: bookings.bookings, cancelled: bookings.cancelled, noShows: bookings.no_shows,
    cancellationRate: Math.round(ratio(bookings.cancelled, bookings.bookings) * 1000) / 10,
    roomNightsSold: sold, roomNightsOffered: offered, roomRevenueMinor: revenue,
    occupancy: Math.round(ratio(sold, offered) * 1000) / 10,
    adrMinor: Math.round(ratio(revenue, sold)), revparMinor: Math.round(ratio(revenue, offered)),
  };
}

function bookingCounts(sql, scope, from, to) {
  return sql`SELECT count(*)::int AS bookings, count(*) FILTER (WHERE b.state = 'cancelled')::int AS cancelled,
      count(*) FILTER (WHERE b.state = 'no_show')::int AS no_shows
    FROM booking b JOIN rentable r ON r.id = b.rentable_id
    WHERE b.slot = 'stay' AND b.order_id IS NOT NULL AND b.confirmed_at IS NOT NULL
      AND b.local_day BETWEEN ${from}::date AND ${to}::date AND ${scope}`;
}

/** Owner: one hotel or all of theirs. */
export async function getOwnerHotelAnalytics(database, ownerId, input) {
  const { from, to, hotelId } = period(input);
  return database.begin('isolation level repeatable read read only', async (sql) => {
    const [owner] = await sql`SELECT id FROM "user" WHERE id = ${ownerId} AND role = 'client' AND account_status = 'active'`;
    if (!owner) throw forbidden();
    const hotels = await sql`SELECT r.id, r.title FROM rentable r JOIN category c ON c.id = r.category_id AND c.vertical_code = 'hotel'
      WHERE r.client_id = ${ownerId} AND r.rental_unit::text = 'night' ORDER BY r.title`;
    if (hotelId && !hotels.some((h) => h.id === hotelId)) throw forbidden();
    const ids = hotelId ? [hotelId] : hotels.map((h) => h.id);
    if (!ids.length) return { period: { from, to }, hotels: [], kpis: kpis([], { bookings: 0, cancelled: 0, no_shows: 0 }), daily: [], reviews: null };
    const scope = sql`r.id IN ${sql(ids)}`;
    const [sold, offered, [counts], [scores], travellers] = await Promise.all([
      soldNights(sql, scope, from, to), offeredNights(sql, scope, from, to), bookingCounts(sql, scope, from, to),
      sql`SELECT count(*)::int AS count, round(avg(v.rating)::numeric, 2)::float8 AS rating,
          round(avg(v.cleanliness)::numeric, 1)::float8 AS cleanliness, round(avg(v.staff)::numeric, 1)::float8 AS staff,
          round(avg(v.location)::numeric, 1)::float8 AS location, round(avg(v.comfort)::numeric, 1)::float8 AS comfort,
          round(avg(v.value_for_money)::numeric, 1)::float8 AS value, round(avg(v.facilities)::numeric, 1)::float8 AS facilities
        FROM public_customer_review v JOIN rentable r ON r.id = v.rentable_id WHERE ${scope}`,
      sql`SELECT v.traveller_type AS type, count(*)::int AS count, round(avg(v.rating)::numeric, 1)::float8 AS rating
        FROM public_customer_review v JOIN rentable r ON r.id = v.rentable_id WHERE ${scope} AND v.traveller_type IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC`,
    ]);
    const days = daily(from, to, sold, offered);
    return {
      period: { from, to }, hotels, kpis: kpis(days, counts), daily: days,
      reviews: { count: scores.count, rating: scores.rating,
        subScores: { cleanliness: scores.cleanliness, staff: scores.staff, location: scores.location, comfort: scores.comfort, value: scores.value, facilities: scores.facilities },
        travellers },
    };
  });
}

/** Admin: the hotel vertical across owners, or one city. */
export async function getAdminHotelAnalytics(database, adminId, input) {
  const { from, to, cityId } = period(input);
  return database.begin('isolation level repeatable read read only', async (sql) => {
    const [admin] = await sql`SELECT permissions FROM admin_user WHERE id = ${adminId} AND is_active`;
    if (!admin || (admin.permissions != null && !admin.permissions.includes('admin.payments.read'))) throw forbidden();
    const scope = sql`EXISTS (SELECT 1 FROM category c WHERE c.id = r.category_id AND c.vertical_code = 'hotel') AND r.rental_unit::text = 'night' AND (${!cityId} OR r.city_id = ${cityId}::uuid)`;
    const [sold, offered, [counts], [money], [commission], topHotels, topCities, [supply]] = await Promise.all([
      soldNights(sql, scope, from, to), offeredNights(sql, scope, from, to), bookingCounts(sql, scope, from, to),
      sql`SELECT coalesce(sum(pa.actual_minor), 0)::text AS paid,
          coalesce(sum((SELECT coalesce(sum(ra.expected_minor), 0) FROM refund_allocation ra JOIN refund f ON f.id = ra.refund_id
            WHERE ra.payment_allocation_id = pa.id AND f.state <> 'failed')), 0)::text AS refunded
        FROM payment_allocation pa JOIN payment_transaction t ON t.id = pa.transaction_id AND t.kind = 'capture' AND t.outcome = 'succeeded'
        JOIN booking b ON b.id = pa.booking_id AND b.slot = 'stay' JOIN rentable r ON r.id = b.rentable_id
        WHERE b.local_day BETWEEN ${from}::date AND ${to}::date AND ${scope} AND pa.component IN ('rent', 'tax')`,
      sql`SELECT coalesce(sum((line->>'commissionMinor')::bigint), 0)::text AS commission, coalesce(sum((line->>'roomMinor')::bigint), 0)::text AS room
        FROM payout_run pr, jsonb_array_elements(pr.snapshot->'lines') line JOIN rentable r ON r.id = (line->>'rentableId')::uuid
        WHERE (line->>'checkIn')::date BETWEEN ${from}::date AND ${to}::date AND ${scope}`,
      sql`SELECT r.id, r.title, ci.name AS city, x.rooms AS "roomNights", x.revenue::text AS "revenueMinor", r.rating_avg AS rating
        FROM (SELECT br.rentable_id, count(*) FILTER (WHERE (night->>'night')::date < coalesce(br.inventory_end,br.check_out))::int AS rooms, sum((night->>'rateMinor')::bigint) AS revenue
          FROM booking_room br, jsonb_array_elements(br.nights) night
          WHERE br.state IN ('booked', 'stayed', 'no_show') AND (night->>'night')::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1) x
        JOIN rentable r ON r.id = x.rentable_id JOIN city ci ON ci.id = r.city_id WHERE ${scope}
        ORDER BY x.revenue DESC LIMIT 10`,
      sql`SELECT ci.id, ci.name, count(DISTINCT r.id) FILTER (WHERE r.status = 'live')::int AS "liveHotels", coalesce(sum(x.rooms), 0)::int AS "roomNights"
        FROM rentable r JOIN city ci ON ci.id = r.city_id
        LEFT JOIN (SELECT br.rentable_id, count(*) FILTER (WHERE (night->>'night')::date < coalesce(br.inventory_end,br.check_out))::int AS rooms FROM booking_room br, jsonb_array_elements(br.nights) night
          WHERE br.state IN ('booked', 'stayed', 'no_show') AND (night->>'night')::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1) x ON x.rentable_id = r.id
        WHERE ${scope} GROUP BY ci.id, ci.name ORDER BY 4 DESC, 3 DESC LIMIT 10`,
      sql`SELECT count(*) FILTER (WHERE r.status = 'live')::int AS live, count(*) FILTER (WHERE r.status IN ('pending_review', 'pending_verification'))::int AS pending,
          coalesce((SELECT sum(rt.room_count) FROM room_type rt JOIN rentable r ON r.id = rt.rentable_id WHERE rt.is_active AND r.status = 'live' AND ${scope}), 0)::int AS rooms,
          count(*) FILTER (WHERE r.status = 'live' AND r.updated_at >= ${from}::date)::int AS "liveSince"
        FROM rentable r WHERE ${scope}`,
    ]);
    // §12.3 weekly KPIs (Phase 10): funnel from quote to paid, booking quality, supply freshness, payouts on time.
    const [funnel] = await sql`SELECT
        (SELECT count(*)::int FROM booking_quote q WHERE q.selection->>'kind' = 'stay' AND q.created_at::date BETWEEN ${from}::date AND ${to}::date) AS quotes,
        (SELECT count(*)::int FROM booking_order o WHERE o.policy_snapshot->>'kind' = 'stay' AND o.created_at::date BETWEEN ${from}::date AND ${to}::date) AS holds,
        (SELECT count(*)::int FROM booking_order o WHERE o.policy_snapshot->>'kind' = 'stay' AND o.confirmed_at::date BETWEEN ${from}::date AND ${to}::date) AS paid,
        (SELECT count(*)::int FROM booking b WHERE b.slot = 'stay' AND b.state = 'cancelled' AND b.cancelled_by_kind = 'customer' AND b.cancelled_at::date BETWEEN ${from}::date AND ${to}::date) AS guest_cancelled,
        (SELECT count(*)::int FROM booking b WHERE b.slot = 'stay' AND b.state = 'cancelled' AND b.cancelled_by_kind IN ('client', 'admin') AND b.cancelled_at::date BETWEEN ${from}::date AND ${to}::date) AS hotel_cancelled,
        (SELECT count(*)::int FROM booking_case c JOIN booking_case_visit cv ON cv.case_id = c.id JOIN booking b ON b.id = cv.booking_id
          WHERE b.slot = 'stay' AND c.created_at::date BETWEEN ${from}::date AND ${to}::date) AS cases,
        (SELECT count(DISTINCT t.rentable_id)::int FROM room_type t JOIN rentable r ON r.id = t.rentable_id AND r.status = 'live'
          WHERE EXISTS (SELECT 1 FROM room_night n WHERE n.room_type_id = t.id AND n.updated_at > now() - interval '7 days')
             OR EXISTS (SELECT 1 FROM rate_plan p WHERE p.room_type_id = t.id AND p.updated_at > now() - interval '7 days')
             OR EXISTS (SELECT 1 FROM audit_log al WHERE al.entity = 'rentable' AND al.entity_id = t.rentable_id::text
               AND al.action LIKE 'hotel_%' AND al.at > now() - interval '7 days')) AS fresh_hotels,
        (SELECT count(*)::int FROM payout_run pr WHERE pr.payout_date BETWEEN ${from}::date AND ${to}::date) AS runs,
        (SELECT count(*)::int FROM payout_run pr WHERE pr.payout_date BETWEEN ${from}::date AND ${to}::date AND pr.status = 'completed'
          AND EXISTS (SELECT 1 FROM payout p WHERE p.payout_run_id = pr.id AND p.settled_at::date <= pr.payout_date + 1)) AS runs_on_time`;
    const days = daily(from, to, sold, offered);
    const roomPaid = n(commission.room);
    return {
      period: { from, to },
      kpis: { ...kpis(days, counts), paidMinor: n(money.paid), refundedMinor: n(money.refunded),
        commissionMinor: n(commission.commission), takeRate: Math.round(ratio(n(commission.commission), roomPaid) * 1000) / 10 },
      daily: days,
      topHotels: topHotels.map((row) => ({ ...row, revenueMinor: n(row.revenueMinor), rating: row.rating == null ? null : Number(row.rating) })),
      topCities, supply,
      weekly: {
        quotes: funnel.quotes, holds: funnel.holds, paid: funnel.paid,
        quoteToPaid: Math.round(ratio(funnel.paid, funnel.quotes) * 1000) / 10,
        holdToPaid: Math.round(ratio(funnel.paid, funnel.holds) * 1000) / 10,
        guestCancelled: funnel.guest_cancelled, hotelCancelled: funnel.hotel_cancelled,
        casesPer100: Math.round(ratio(funnel.cases * 100, Math.max(1, counts.bookings)) * 10) / 10,
        freshHotels: funnel.fresh_hotels, liveHotels: supply.live,
        payoutsOnTime: funnel.runs ? Math.round(ratio(funnel.runs_on_time, funnel.runs) * 1000) / 10 : null,
        refundRate: Math.round(ratio(n(money.refunded), n(money.paid)) * 1000) / 10,
      },
    };
  });
}
