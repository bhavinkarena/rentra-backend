/**
 * Hotels vertical catalogue and demo hotels (hotel plan, Phase 2).
 *
 *   npm run seed:hotels            # hotel categories and amenities
 *   npm run seed:hotels -- --demo  # plus 10 live demo hotels in Surat (local/dev data)
 *
 * Run after `npm run db:migrate` has committed 0064. Categories use rental_unit
 * 'night'. Idempotent: categories and amenities are upserted, demo hotels are
 * matched by slug and skipped when present. It never changes the vertical's
 * status: Hotels stays hidden until it is switched on in the admin catalogue.
 * Demo hotels have no photos (guests see "Photos coming soon"); never seed them
 * into production.
 */
import postgres from 'postgres';
import { seedDatabaseUrl } from './seed-guard.js';

const sql = postgres(seedDatabaseUrl('seed-hotels'), {
  prepare: false,
  max: 1,
  onnotice: () => {},
});
const demo = process.argv.includes('--demo');

/** [slug, name, iconKey] in display order. Homestays wait for owner decision Q4. */
const CATEGORIES = [
  ['hotel', 'Hotel', 'hotel'],
  ['resort', 'Resort', 'resort'],
  ['boutique-hotel', 'Boutique hotel', 'boutique'],
  ['business-hotel', 'Business hotel', 'business'],
];

/** Existing amenities that also describe hotels. */
const SHARED = [
  'parking',
  'wifi',
  'cctv',
  'generator',
  'swimming_pool',
  'wheelchair',
  'first_aid',
  'air_conditioned',
];

/** New hotel amenities: [slug, group, label, filterable]. Hindi/Gujarati labels are added by a translator. */
const HOTEL_AMENITIES = [
  ['restaurant', 'food', 'Restaurant', true],
  ['pure_veg_kitchen', 'food', 'Pure veg kitchen', true],
  ['jain_food', 'food', 'Jain food on request', true],
  ['room_service', 'services', 'Room service', false],
  ['front_desk_24h', 'services', '24-hour front desk', true],
  ['lift', 'services', 'Lift', false],
  ['laundry', 'services', 'Laundry', false],
  ['gym', 'facilities', 'Gym', true],
  ['airport_transfer', 'services', 'Airport transfer', false],
];

/** [name, area slug, category, star, [roomName, rooms, maxAdults, weekday ₹, weekend ₹][]] */
const DEMO = [
  [
    'Riverside Residency',
    'adajan',
    'hotel',
    3,
    [
      ['Deluxe Double', 12, 3, 2600, 3000],
      ['Standard Twin', 14, 2, 2000, 2300],
      ['Family Suite', 6, 4, 4200, 4800],
    ],
  ],
  [
    'Hotel Sai Palace',
    'vesu',
    'business-hotel',
    3,
    [
      ['Executive Room', 16, 2, 2100, 2100],
      ['Standard Room', 8, 2, 1700, 1800],
    ],
  ],
  [
    'Green Leaf Resort',
    'dumas',
    'resort',
    4,
    [
      ['Garden Cottage', 10, 3, 6200, 7400],
      ['Pool Villa', 4, 4, 9800, 11800],
    ],
  ],
  [
    'Hotel Textile Inn',
    'ring-road',
    'hotel',
    2,
    [
      ['Standard Double', 20, 2, 1600, 1700],
      ['Deluxe Double', 10, 3, 2000, 2200],
    ],
  ],
  [
    'The Diamond Court',
    'varachha',
    'business-hotel',
    3,
    [
      ['Superior Room', 18, 2, 2400, 2400],
      ['Suite', 4, 3, 5200, 5200],
    ],
  ],
  [
    'Tapi View Boutique',
    'athwa',
    'boutique-hotel',
    4,
    [
      ['Heritage Room', 8, 2, 4600, 5400],
      ['River Suite', 2, 3, 8200, 9600],
    ],
  ],
  ['Hotel Shreeji Comfort', 'udhna', 'hotel', 2, [['Standard Room', 15, 2, 1300, 1400]]],
  [
    'Citrus Business Hotel',
    'piplod',
    'business-hotel',
    3,
    [
      ['Studio Room', 22, 2, 2800, 2600],
      ['Corner Room', 6, 3, 3500, 3300],
    ],
  ],
  [
    'Sunrise Family Hotel',
    'pal',
    'hotel',
    2,
    [
      ['Family Room', 10, 4, 2500, 2900],
      ['Double Room', 10, 2, 1800, 2100],
    ],
  ],
  ['Dumas Beach Retreat', 'dumas', 'resort', 3, [['Sea Breeze Room', 12, 3, 3900, 4900]]],
];

const code = () =>
  Array.from(
    { length: 8 },
    () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)],
  ).join('');
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

try {
  await sql.begin(async (tx) => {
    const [vertical] = await tx`SELECT code FROM vertical WHERE code = 'hotel'`;
    if (!vertical)
      throw new Error('Run npm run db:migrate first: the hotel vertical does not exist.');

    for (const [index, [slug, name, iconKey]] of CATEGORIES.entries()) {
      const [row] = await tx`
        INSERT INTO category (slug, name, form, default_rental_unit, vertical_code, icon_key, sort_order)
        VALUES (${slug}, ${name}, 'fixed', 'night', 'hotel', ${iconKey}, ${(index + 1) * 10})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon_key = EXCLUDED.icon_key,
          sort_order = EXCLUDED.sort_order, version = category.version + 1
          WHERE category.vertical_code = 'hotel'
        RETURNING id`;
      if (!row) throw new Error(`Category slug ${slug} already belongs to another vertical.`);
    }

    const [{ max }] = await tx`SELECT coalesce(max(sort_order), 0)::int AS max FROM amenity`;
    for (const [index, [slug, group, label, filterable]] of HOTEL_AMENITIES.entries()) {
      await tx`
        INSERT INTO amenity (slug, group_slug, label_en, value_type, is_filterable, sort_order)
        VALUES (${slug}, ${group}, ${label}, 'none', ${filterable}, ${max + index + 1})
        ON CONFLICT (slug) DO UPDATE SET group_slug = EXCLUDED.group_slug, label_en = EXCLUDED.label_en,
          is_filterable = EXCLUDED.is_filterable, version = amenity.version + 1`;
    }
    const slugs = [...SHARED, ...HOTEL_AMENITIES.map(([slug]) => slug)];
    await tx`INSERT INTO amenity_vertical (amenity_id, vertical_code)
      SELECT id, 'hotel' FROM amenity WHERE slug IN ${tx(slugs)} ON CONFLICT DO NOTHING`;
    const found = await tx`SELECT slug FROM amenity WHERE slug IN ${tx(slugs)}`;
    const missing = slugs.filter((slug) => !found.some((row) => row.slug === slug));
    if (missing.length)
      console.warn(
        `[seed-hotels] not found (run seed-amenities / seed-entertainment first?): ${missing.join(', ')}`,
      );
    console.log(
      `[seed-hotels] ${CATEGORIES.length} categories, ${HOTEL_AMENITIES.length} hotel amenities.`,
    );

    if (!demo) return;
    const [city] = await tx`SELECT id FROM city WHERE slug = 'surat'`;
    if (!city) throw new Error('Seed cities and areas first (npm run db:seed): Surat is missing.');
    const [owner] = (await tx`SELECT id FROM "user" WHERE email = 'demo-hotels@rentra.invalid'`)
      .length
      ? await tx`SELECT id FROM "user" WHERE email = 'demo-hotels@rentra.invalid'`
      : await tx`INSERT INTO "user" (email, role, account_status, name)
        VALUES ('demo-hotels@rentra.invalid', 'client', 'active', 'Demo Hotels') RETURNING id`;
    let created = 0;
    for (const [name, areaSlug, categorySlug, star, rooms] of DEMO) {
      const slug = `${slugify(name)}-surat`;
      if ((await tx`SELECT 1 FROM rentable WHERE slug = ${slug}`).length) continue;
      const [area] =
        await tx`SELECT id FROM area WHERE city_id = ${city.id} AND slug = ${areaSlug}`.then(
          (rows) =>
            rows.length
              ? rows
              : tx`SELECT id FROM area WHERE city_id = ${city.id} ORDER BY name LIMIT 1`,
        );
      if (!area) throw new Error('Surat has no areas: seed areas first.');
      const [category] = await tx`SELECT id FROM category WHERE slug = ${categorySlug}`;
      const capacity = Math.max(...rooms.map(([, , adults]) => adults));
      const [hotel] =
        await tx`INSERT INTO rentable (client_id, slug, title, description, category_id, city_id, area_id, public_code, rental_unit, capacity)
        VALUES (${owner.id}, ${slug}, ${name}, ${`Demo hotel in Surat with ${rooms.length} room types.`}, ${category.id}, ${city.id}, ${area.id}, ${code()}, 'night', ${capacity})
        RETURNING id`;
      await tx`INSERT INTO hotel_profile (rentable_id, star_rating, policies)
        VALUES (${hotel.id}, ${star}, ${JSON.stringify({ couples: true, localId: star <= 3, pets: false, smoking: false })}::text::jsonb)`;
      for (const [position, [roomName, count, maxAdults, weekday, weekend]] of rooms.entries()) {
        const [room] =
          await tx`INSERT INTO room_type (rentable_id, name, max_adults, max_children, max_occupancy, base_occupancy, room_count,
            extra_adult_minor, extra_child_minor, sort_order)
          VALUES (${hotel.id}, ${roomName}, ${maxAdults}, 2, ${maxAdults + 1}, 2, ${count}, 70000, 40000, ${position})
          RETURNING id`;
        const [base] =
          await tx`INSERT INTO rate_plan (room_type_id, rentable_id, name, weekday_minor, weekend_minor, free_cancel_hours)
          VALUES (${room.id}, ${hotel.id}, 'Room only', ${weekday * 100}, ${weekend * 100}, 24) RETURNING id`;
        await tx`INSERT INTO rate_plan (room_type_id, rentable_id, name, meal_plan, derived_from, derived_per_guest_minor, free_cancel_hours, sort_order)
          VALUES (${room.id}, ${hotel.id}, 'Breakfast included', 'CP', ${base.id}, 25000, 24, 1)`;
        if (position === 0) {
          await tx`INSERT INTO rate_plan (room_type_id, rentable_id, name, derived_from, derived_pct_bps, late_charge, no_show, sort_order)
            VALUES (${room.id}, ${hotel.id}, 'Non-refundable', ${base.id}, -1000, 'full_stay', 'full_stay', 2)`;
        }
      }
      await tx`UPDATE rentable SET status = 'live' WHERE id = ${hotel.id}`;
      created += 1;
    }
    console.log(
      `[seed-hotels] ${created} demo hotels created (${DEMO.length - created} already present). Hotels vertical status unchanged.`,
    );
  });
} finally {
  await sql.end();
}
