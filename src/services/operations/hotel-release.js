import { propertyToday, addLocalDays } from '../domain/booking-dates.js';

/**
 * Hotels launch readiness (hotel plan §11.4, Phase 9). Read-only, one snapshot.
 * `beta` checks what a closed beta needs (Hotels in partners, at least one
 * bookable hotel, money and inventory integrity). `public` adds the launch
 * checklist items the database can prove; people items (agreements signed,
 * support rota, CA sign-off) stay on the paper checklist.
 * The admin launch switch refuses `public` unless this passes.
 */
export const HOTEL_LAUNCH = Object.freeze({
  minHotels: Number(process.env.HOTEL_LAUNCH_MIN_HOTELS ?? 40),
  minPhotos: 8,
  horizonDays: 90,
});

export async function inspectHotelRelease(database, stage = 'beta') {
  if (!['beta', 'public'].includes(stage)) throw new Error('Choose beta or public');
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const checks = [];
    const check = (name, pass, detail = null) => checks.push({ name, pass: Boolean(pass), detail });
    const today = propertyToday();
    const [vertical] = await tx`SELECT status FROM vertical WHERE code = 'hotel'`;
    check('hotel vertical exists', vertical);
    if (!vertical) return { stage, checks, ready: false };
    check('hotels open to partners', ['partners', 'public'].includes(vertical.status), { status: vertical.status });

    const hotels = await tx`
      SELECT r.id, r.title,
        jsonb_array_length(coalesce(r.photos, '[]'::jsonb)) AS photos,
        EXISTS (SELECT 1 FROM room_type t JOIN rate_plan p ON p.room_type_id = t.id AND p.is_active WHERE t.rentable_id = r.id AND t.is_active) AS rooms,
        EXISTS (SELECT 1 FROM commission_rule cr WHERE cr.vertical_code = 'hotel'
          AND (cr.rentable_id = r.id OR (cr.rentable_id IS NULL AND (cr.city_id = r.city_id OR cr.city_id IS NULL)))
          AND ${today}::date BETWEEN cr.valid_from AND coalesce(cr.valid_to, 'infinity'::date)) AS commission,
        EXISTS (SELECT 1 FROM payout_destination d WHERE d.client_id = r.client_id AND d.state = 'verified') AS payout,
        coalesce((hp.policies->>'gstAnswered')::boolean, false) AS gst,
        -- Nights in the next 90 with no room type open (stop-sold or allotment 0 on every type).
        (SELECT count(*) FROM generate_series(${today}::date, ${addLocalDays(today, HOTEL_LAUNCH.horizonDays - 1)}::date, interval '1 day') d
          WHERE NOT EXISTS (SELECT 1 FROM room_type t LEFT JOIN room_night n ON n.room_type_id = t.id AND n.night = d::date
            WHERE t.rentable_id = r.id AND t.is_active AND NOT coalesce(n.stop_sell, false) AND coalesce(n.allotment, t.room_count) > 0))::int AS closed_nights
      FROM rentable r JOIN category c ON c.id = r.category_id AND c.vertical_code = 'hotel'
      LEFT JOIN hotel_profile hp ON hp.rentable_id = r.id
      WHERE r.status = 'live' AND r.rental_unit::text = 'night' ORDER BY r.title`;
    const failing = (test) => hotels.filter((h) => !test(h)).map((h) => h.title);
    check('bookable hotels live', stage === 'public' ? hotels.length >= HOTEL_LAUNCH.minHotels : hotels.length >= 1,
      { live: hotels.length, required: stage === 'public' ? HOTEL_LAUNCH.minHotels : 1 });
    check('every live hotel has rooms and rates', !failing((h) => h.rooms).length, failing((h) => h.rooms));
    check('every live hotel has a commission rule today', !failing((h) => h.commission).length, failing((h) => h.commission));
    check('every live hotel has a verified payout method', !failing((h) => h.payout).length, failing((h) => h.payout));
    check('every live hotel answered GST', !failing((h) => h.gst).length, failing((h) => h.gst));
    const [{ slabs }] = await tx`SELECT count(*)::int AS slabs FROM tax_slab WHERE vertical_code = 'hotel'
      AND effective_from <= ${today}::date AND (effective_to IS NULL OR effective_to >= ${today}::date)`;
    check('tax slabs cover today', slabs > 0, { slabs });

    // Integrity: the beta and launch acceptance (zero overbookings, zero payment mismatches).
    const [{ over }] = await tx`SELECT count(*)::int AS over FROM room_night WHERE sold + held > allotment`;
    check('no overbooked room-night', over === 0, { over });
    const [{ mismatched }] = await tx`SELECT count(*)::int AS mismatched FROM booking_order o
      JOIN payment_order p ON p.booking_order_id = o.id
      WHERE o.state = 'confirmed' AND o.policy_snapshot->>'kind' = 'stay' AND NOT (o.policy_snapshot ? 'apartment')
        AND p.expected_minor <> (SELECT coalesce(sum(t.captured_minor), 0) FROM payment_transaction t JOIN payment_attempt a ON a.id = t.attempt_id
          WHERE a.payment_order_id = p.id AND t.kind = 'capture' AND t.outcome = 'succeeded')`;
    check('every confirmed stay is paid exactly', mismatched === 0, { mismatched });
    const [{ stuck }] = await tx`SELECT count(*)::int AS stuck FROM booking_room br JOIN booking b ON b.id = br.booking_id
      JOIN booking_order o ON o.id = b.order_id WHERE br.state = 'held' AND o.hold_expires_at < now() - interval '1 hour'`;
    check('no expired room hold older than an hour', stuck === 0, { stuck });
    const [{ refunds }] = await tx`SELECT count(*)::int AS refunds FROM refund f JOIN refund_allocation ra ON ra.refund_id = f.id
      JOIN booking b ON b.id = ra.booking_id AND b.slot = 'stay' AND b.slot_snapshot->'apartment' IS NULL WHERE f.state = 'unknown' AND f.created_at < now() - interval '1 day'`;
    check('no stay refund stuck for a day', refunds === 0, { refunds });

    if (stage === 'public') {
      check('live hotels have 8+ photos', !failing((h) => h.photos >= HOTEL_LAUNCH.minPhotos).length, failing((h) => h.photos >= HOTEL_LAUNCH.minPhotos));
      check('live hotels open on most of the next 90 nights', !failing((h) => h.closed_nights <= 30).length, failing((h) => h.closed_nights <= 30));
      const [gateway] = await tx`SELECT environment, enabled FROM payment_gateway_config ORDER BY version DESC LIMIT 1`;
      check('live payments enabled', gateway?.environment === 'live' && gateway.enabled, gateway ?? null);
      const policies = await tx`SELECT DISTINCT kind FROM content_publication WHERE kind IN ('terms', 'cancellation', 'privacy')`;
      check('booking policies published', policies.length === 3, policies.map((p) => p.kind));
    }
    return { stage, checks, ready: checks.every((c) => c.pass) };
  });
}
