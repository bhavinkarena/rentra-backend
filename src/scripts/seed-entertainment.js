/**
 * Entertainment vertical catalogue (entertainment plan, Phase 3).
 *
 *   npm run seed:entertainment
 *
 * Run after `npm run db:migrate` has committed 0052-0054. The categories use
 * rental_unit 'hour', which a migration in the same release must not insert
 * (Postgres 55P04), so they live here. Idempotent: re-running updates labels,
 * icons and order. It never touches the vertical's status, so it is safe to run
 * on a database where Entertainment is still hidden.
 *
 * Existing amenity flags (is_filterable) are left alone because they are global:
 * changing them would change the farmhouse filter panel too.
 */
import postgres from 'postgres';
import { seedDatabaseUrl } from './seed-guard.js';

const sql = postgres(seedDatabaseUrl('seed-entertainment'), {
  prepare: false,
  max: 1,
  onnotice: () => {},
});

/** [slug, name, iconKey] in display order. */
const ACTIVITIES = [
  ['box-cricket', 'Box cricket', 'cricket'],
  ['pickleball', 'Pickleball', 'pickleball'],
  ['badminton', 'Badminton', 'badminton'],
  ['bowling', 'Bowling', 'bowling'],
  ['turf', 'Sports turf', 'football'],
  ['gaming-zone', 'Gaming zone', 'gaming'],
  ['trampoline-park', 'Trampoline park', 'trampoline'],
  ['go-karting', 'Go-karting', 'kart'],
];

/** Farmhouse amenities that also describe play venues. */
const SHARED = [
  'parking',
  'cctv',
  'wifi',
  'first_aid',
  'wheelchair',
  'ro_water',
  'generator',
  'floodlights',
];

/** New venue amenities: [slug, group, label, valueType, filterable]. Hindi/Gujarati labels are added by a translator. */
const VENUE_AMENITIES = [
  ['equipment_rental', 'play', 'Equipment on rent', 'charge', true],
  ['coaching', 'play', 'Coaching available', 'none', true],
  ['scoreboard', 'play', 'Scoreboard', 'none', false],
  ['spectator_seating', 'play', 'Spectator seating', 'count', false],
  ['washrooms', 'facilities', 'Washrooms', 'none', false],
  ['changing_rooms', 'facilities', 'Changing rooms', 'none', true],
  ['lockers', 'facilities', 'Lockers', 'none', false],
  ['cafeteria', 'facilities', 'Cafeteria', 'none', false],
  ['air_conditioned', 'facilities', 'Air-conditioned', 'none', true],
];

try {
  await sql.begin(async (tx) => {
    const [vertical] = await tx`SELECT code FROM vertical WHERE code = 'entertainment'`;
    if (!vertical)
      throw new Error('Run npm run db:migrate first: the entertainment vertical does not exist.');

    for (const [index, [slug, name, iconKey]] of ACTIVITIES.entries()) {
      const [row] = await tx`
        INSERT INTO category (slug, name, form, default_rental_unit, vertical_code, icon_key, sort_order)
        VALUES (${slug}, ${name}, 'fixed', 'hour', 'entertainment', ${iconKey}, ${(index + 1) * 10})
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, icon_key = EXCLUDED.icon_key,
          sort_order = EXCLUDED.sort_order, version = category.version + 1
          WHERE category.vertical_code = 'entertainment'
        RETURNING id`;
      if (!row) throw new Error(`Category slug ${slug} already belongs to another vertical.`);
    }

    const [{ max }] = await tx`SELECT coalesce(max(sort_order), 0)::int AS max FROM amenity`;
    for (const [index, [slug, group, label, valueType, filterable]] of VENUE_AMENITIES.entries()) {
      await tx`
        INSERT INTO amenity (slug, group_slug, label_en, value_type, is_filterable, sort_order)
        VALUES (${slug}, ${group}, ${label}, ${valueType}, ${filterable}, ${max + index + 1})
        ON CONFLICT (slug) DO UPDATE SET group_slug = EXCLUDED.group_slug, label_en = EXCLUDED.label_en,
          is_filterable = EXCLUDED.is_filterable, version = amenity.version + 1`;
    }

    const slugs = [...SHARED, ...VENUE_AMENITIES.map(([slug]) => slug)];
    const mapped = await tx`
      INSERT INTO amenity_vertical (amenity_id, vertical_code)
      SELECT id, 'entertainment' FROM amenity WHERE slug IN ${tx(slugs)}
      ON CONFLICT DO NOTHING RETURNING amenity_id`;
    const found = await tx`SELECT slug FROM amenity WHERE slug IN ${tx(slugs)}`;
    const missing = slugs.filter((slug) => !found.some((row) => row.slug === slug));
    if (missing.length)
      console.warn(
        `[seed-entertainment] not found (run seed-amenities first?): ${missing.join(', ')}`,
      );
    console.log(
      `[seed-entertainment] ${ACTIVITIES.length} activities, ${VENUE_AMENITIES.length} venue amenities, ${mapped.length} new amenity mappings.`,
    );
  });
} finally {
  await sql.end();
}
