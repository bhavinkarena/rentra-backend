/**
 * 50 live demo venues for the Entertainment vertical (entertainment plan), the
 * counterpart of seed-gujarat-partners.js for farmhouses.
 *
 *   npm run seed:entertainment            # activities and venue amenities first
 *   npm run seed:venues                   # this script
 *
 * One demo owner per city, 5 venues each across that city's areas: box cricket,
 * pickleball, badminton, sports turf, bowling, gaming, trampoline and go-karting.
 * Every venue is live and bookable: courts with activities, weekly opening hours,
 * weekday/weekend hourly bands with an evening peak, venue rules, amenities, an
 * accepted ownership document and (for most) a passed physical verification.
 * Photos come from cloudinary-entertainment-map.json (upload-entertainment-photos.js).
 *
 * Idempotent: venues are matched by slug and replaced. It never changes the
 * vertical's launch status; set Entertainment to Partners/Public in the admin
 * catalogue when you want owners or guests to see it.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { eq, inArray, and } from 'drizzle-orm';
import * as s from '@/services/db/schema/index.js';
import { seedDatabaseUrl } from './seed-guard.js';
import { hourlyBookingConfigSchema } from '@/services/schemas/zod/booking-config.js';

const client = postgres(seedDatabaseUrl('seed-entertainment-venues'), {
  prepare: false,
  max: 2,
  onnotice: () => {},
});
const db = drizzle(client, { schema: s });
const sql = client;

const PHOTOS = JSON.parse(
  await readFile(new URL('./cloudinary-entertainment-map.json', import.meta.url), 'utf8'),
);

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
const hhmm = (minute) =>
  `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * Per activity: names, courts, what each court is booked for, players, surface,
 * indoor or outdoor, hours, hourly bands (rupees) and the photo pool.
 */
const KINDS = {
  'box-cricket': {
    names: [
      'Boundary Box',
      'Sixer Arena',
      'Power Play Nets',
      'Yorker Yard',
      'Pitch Perfect',
      'Cover Drive Club',
      'Straight Bat Arena',
      'Night Owl Cricket',
      'Champions Box',
      'Hit Wicket Hub',
    ],
    unit: 'Box',
    courts: [2, 3],
    players: 14,
    indoor: false,
    surface: 'Artificial turf',
    size: '40 × 80 ft',
    activities: (i) => (i === 0 ? ['box-cricket', 'turf'] : ['box-cricket']),
    open: 360,
    close: 1500,
    rates: { weekday: [800, 1200], weekend: [1000, 1500] },
    photos: ['cricket', 'football'],
    highlight: 'Floodlit till 1 AM',
    blurb:
      'Fully netted box-cricket cages with floodlights, stumps and balls on the house. Book a box for your gully team or a corporate league night.',
    amenities: [
      'floodlights',
      'parking',
      'ro_water',
      'washrooms',
      'equipment_rental',
      'scoreboard',
      'spectator_seating',
      'cctv',
    ],
    rules: { footwear: 'no_studs', foodAllowed: 'seating_only' },
  },
  pickleball: {
    names: [
      'Dink Club',
      'Kitchen Line Courts',
      'Paddle House',
      'Rally Point',
      'Pickle Park',
      'Smash & Dink',
      'Third Shot Courts',
      'Net Play Club',
    ],
    unit: 'Court',
    courts: [3, 5],
    players: 4,
    indoor: null,
    surface: 'Synthetic',
    size: 'Standard 20 × 44 ft',
    activities: () => ['pickleball'],
    open: 360,
    close: 1380,
    rates: { weekday: [500, 700], weekend: [600, 850] },
    photos: ['pickleball'],
    highlight: 'Paddles & balls on rent',
    blurb:
      'Tournament-size pickleball courts with cushioned surface, paddles on rent and coaching for beginners every morning.',
    amenities: [
      'parking',
      'ro_water',
      'washrooms',
      'equipment_rental',
      'coaching',
      'changing_rooms',
      'wifi',
    ],
    rules: { footwear: 'non_marking', foodAllowed: 'no' },
  },
  badminton: {
    names: [
      'Shuttle Hub',
      'Feather Court',
      'Drop Shot Arena',
      'Smash Point',
      'Clear Court',
      'Rally Badminton',
      'Birdie House',
    ],
    unit: 'Court',
    courts: [3, 5],
    players: 4,
    indoor: true,
    surface: 'Wooden',
    size: 'BWF standard',
    activities: () => ['badminton'],
    open: 300,
    close: 1380,
    rates: { weekday: [400, 600], weekend: [500, 700] },
    photos: ['badminton'],
    highlight: 'Wooden courts · AC hall',
    blurb:
      'Air-conditioned indoor hall with wooden BWF-standard courts, anti-glare lighting and shuttle rental.',
    amenities: [
      'air_conditioned',
      'parking',
      'ro_water',
      'washrooms',
      'changing_rooms',
      'lockers',
      'equipment_rental',
      'coaching',
    ],
    rules: { footwear: 'non_marking', foodAllowed: 'no' },
  },
  turf: {
    names: [
      'Goal Rush Turf',
      'Kickoff Arena',
      'Green Pitch',
      'Striker Turf',
      'Five-a-side Hub',
      'Night League Turf',
      'Corner Kick Arena',
    ],
    unit: 'Turf',
    courts: [1, 2],
    players: 14,
    indoor: false,
    surface: 'Artificial turf',
    size: '100 × 60 ft',
    activities: () => ['turf', 'box-cricket'],
    open: 360,
    close: 1500,
    rates: { weekday: [1200, 1800], weekend: [1500, 2200] },
    photos: ['football'],
    highlight: 'FIFA-grade turf',
    blurb:
      'FIFA-grade artificial turf for 5-a-side and 7-a-side football, also bookable for box cricket. Floodlit every night.',
    amenities: [
      'floodlights',
      'parking',
      'ro_water',
      'washrooms',
      'changing_rooms',
      'spectator_seating',
      'cafeteria',
      'cctv',
    ],
    rules: { footwear: 'studs_ok', foodAllowed: 'seating_only' },
  },
  bowling: {
    names: ['Strike Zone', 'Pin Palace', 'Lucky Lanes', 'Spare Room Bowling'],
    unit: 'Lane',
    courts: [6, 8],
    players: 6,
    indoor: true,
    surface: 'Synthetic',
    size: 'Regulation lane',
    activities: () => ['bowling'],
    open: 660,
    close: 1380,
    rates: { weekday: [900, 1200], weekend: [1100, 1500] },
    photos: ['bowling'],
    highlight: 'Glow bowling on weekends',
    blurb:
      'Ten-pin bowling with automatic scoring, bumpers for kids and cosmic glow bowling on weekend nights.',
    amenities: ['air_conditioned', 'parking', 'cafeteria', 'washrooms', 'lockers', 'wifi', 'cctv'],
    rules: { footwear: 'any', foodAllowed: 'no' },
  },
  'gaming-zone': {
    names: ['Pixel Lounge', 'Level Up Arena', 'Respawn Room', 'Game Grid', 'Arcade Nation'],
    unit: 'Station',
    courts: [8, 12],
    players: 2,
    indoor: true,
    surface: 'Other',
    size: 'PC + console',
    activities: () => ['gaming-zone'],
    open: 660,
    close: 1440,
    rates: { weekday: [150, 250], weekend: [200, 300] },
    photos: ['gaming'],
    highlight: 'RTX gaming rigs',
    blurb:
      'High-refresh gaming PCs and PS5 stations with racing seats, headsets and fast fibre. Squad tournaments every Sunday.',
    amenities: ['air_conditioned', 'wifi', 'cafeteria', 'washrooms', 'generator', 'cctv'],
    rules: { footwear: 'any', foodAllowed: 'seating_only' },
  },
  'trampoline-park': {
    names: ['Bounce Planet', 'Sky Jump', 'Air Zone', 'Jump Street'],
    unit: 'Arena',
    courts: [1, 1],
    players: 30,
    indoor: true,
    surface: 'Other',
    size: '8,000 sq ft',
    activities: () => ['trampoline-park'],
    open: 600,
    close: 1320,
    rates: { weekday: [2500, 3500], weekend: [3000, 4200] },
    photos: ['trampoline'],
    highlight: 'Private hire for parties',
    blurb:
      'Private hire of the whole trampoline arena: foam pit, dodgeball court and ninja course, with trained jump marshals.',
    amenities: [
      'air_conditioned',
      'parking',
      'washrooms',
      'lockers',
      'cafeteria',
      'first_aid',
      'cctv',
    ],
    rules: {
      footwear: 'any',
      minAge: 4,
      foodAllowed: 'seating_only',
      notes: 'Grip socks required on the trampolines (on sale at the counter).',
    },
  },
  'go-karting': {
    names: ['Apex Karting', 'Grid Line Karts', 'Pit Stop Racing', 'Turbo Track', 'Chicane Karting'],
    unit: 'Track',
    courts: [1, 1],
    players: 8,
    indoor: false,
    surface: 'Concrete',
    size: '650 m circuit',
    activities: () => ['go-karting'],
    open: 600,
    close: 1320,
    rates: { weekday: [3000, 4000], weekend: [3600, 4800] },
    photos: ['kart'],
    highlight: 'Timed laps & podium',
    blurb:
      'A 650 m floodlit karting circuit with timed laps, safety gear included and a podium for the winners.',
    amenities: [
      'floodlights',
      'parking',
      'cafeteria',
      'washrooms',
      'first_aid',
      'spectator_seating',
      'cctv',
    ],
    rules: {
      footwear: 'any',
      minAge: 12,
      foodAllowed: 'seating_only',
      notes: 'Closed shoes and the provided helmet are compulsory on track.',
    },
  },
};

/** 50 venues: [activity, name index]. */
const PLAN = [
  ...KINDS['box-cricket'].names.map((_, i) => ['box-cricket', i]),
  ...KINDS.pickleball.names.map((_, i) => ['pickleball', i]),
  ...KINDS.badminton.names.map((_, i) => ['badminton', i]),
  ...KINDS.turf.names.map((_, i) => ['turf', i]),
  ...KINDS.bowling.names.map((_, i) => ['bowling', i]),
  ...KINDS['gaming-zone'].names.map((_, i) => ['gaming-zone', i]),
  ...KINDS['trampoline-park'].names.map((_, i) => ['trampoline-park', i]),
  ...KINDS['go-karting'].names.map((_, i) => ['go-karting', i]),
];

const TIERS = ['flexible', 'moderate', 'moderate', 'strict'];

function config(kind, index) {
  const lateWeekend = kind.close >= 1380 ? Math.min(kind.close + 60, 1560) : kind.close;
  const day = (close) => [
    { open: hhmm(kind.open), close: hhmm(close), closesNextDay: close >= 1440 },
  ];
  return {
    model: 'hourly',
    timeZone: 'Asia/Kolkata',
    leadTimeMinutes: 60,
    bookingHorizonDays: 60,
    stepMinutes: 60,
    minDurationMinutes: 60,
    maxDurationMinutes: kind.unit === 'Arena' || kind.unit === 'Track' ? 120 : 180,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: index % 4 === 0 ? 15 : 0,
    weeklyHours: {
      mon: day(kind.close),
      tue: day(kind.close),
      wed: day(kind.close),
      thu: day(kind.close),
      fri: day(lateWeekend),
      sat: day(lateWeekend),
      sun: day(kind.close),
    },
    inventoryReady: true,
  };
}

/** Off-peak until 6 PM, peak after; the band set covers the latest close of the week. */
function bands(kind, latestClose, bump) {
  const peakFrom = Math.max(kind.open, 1080);
  const out = [];
  for (const dayKind of ['weekday', 'weekend']) {
    const [offPeak, peak] = kind.rates[dayKind].map((r) => (r + bump) * 100);
    if (kind.open < peakFrom) out.push({ dayKind, start: kind.open, end: peakFrom, rate: offPeak });
    out.push({ dayKind, start: peakFrom, end: latestClose, rate: peak });
  }
  return out;
}

async function seed() {
  const [vertical] = await sql`SELECT code FROM vertical WHERE code='entertainment'`;
  if (!vertical) throw new Error('Run db:migrate first: no entertainment vertical.');
  const categories = Object.fromEntries(
    (await sql`SELECT id, slug FROM category WHERE vertical_code='entertainment'`).map((c) => [
      c.slug,
      c.id,
    ]),
  );
  for (const slug of Object.keys(KINDS))
    if (!categories[slug])
      throw new Error(`Run npm run seed:entertainment first: category ${slug} is missing.`);
  const amenities = Object.fromEntries(
    (
      await sql`SELECT a.id, a.slug FROM amenity a JOIN amenity_vertical av ON av.amenity_id=a.id AND av.vertical_code='entertainment' WHERE a.is_active`
    ).map((a) => [a.slug, a.id]),
  );
  const cities =
    await sql`SELECT c.id, c.slug, c.name, json_agg(json_build_object('id',a.id,'slug',a.slug,'name',a.name) ORDER BY a.sort_order, a.name) AS areas
    FROM city c JOIN area a ON a.city_id=c.id AND a.is_active WHERE c.is_active GROUP BY c.id ORDER BY c.sort_order, c.name`;
  if (!cities.length) throw new Error('No active cities with areas. Run the farmhouse seed first.');

  // One demo owner per city.
  const owners = {};
  for (const [i, city] of cities.entries()) {
    const email = `play.${city.slug}@rentra-demo.test`;
    let [owner] = await db
      .select()
      .from(s.users)
      .where(and(eq(s.users.email, email), eq(s.users.role, 'client')))
      .limit(1);
    if (!owner)
      [owner] = await db
        .insert(s.users)
        .values({
          phone: `98250${String(70000 + i).slice(-5)}`,
          role: 'client',
          name: `${city.name} Play Partners`,
          email,
          accountStatus: 'active',
          clientType: 'owner',
          kycStatus: 'verified',
          respondsWithinMins: 30,
          responseRate: 0.96,
          emailVerifiedAt: new Date(),
          phoneVerifiedAt: new Date(),
        })
        .returning();
    owners[city.id] = owner;
  }

  // Replace earlier runs.
  const slugs = PLAN.map(([activity, n], i) =>
    slugify(`${KINDS[activity].names[n]} ${cities[i % cities.length].name}`),
  );
  const old = await db
    .select({ id: s.rentable.id })
    .from(s.rentable)
    .where(inArray(s.rentable.slug, slugs));
  if (old.length) {
    const ids = old.map((r) => r.id);
    const booked =
      await sql`SELECT count(*)::int AS n FROM booking WHERE rentable_id IN ${sql(ids)}`;
    if (booked[0].n)
      throw new Error(`${booked[0].n} bookings exist on demo venues; refusing to replace them.`);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM verification_visit WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM document WHERE owner_type='rentable' AND owner_id IN ${tx(ids)}`;
      await tx`DELETE FROM rentable_amenity WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM rentable_rate WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM inventory_reservation WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM rentable_resource_activity WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM rentable_resource WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM listing_submission WHERE rentable_id IN ${tx(ids)}`;
      await tx`DELETE FROM rentable WHERE id IN ${tx(ids)}`;
    });
    console.log(`[seed-venues] replaced ${ids.length} earlier demo venues`);
  }

  let made = 0;
  for (const [i, [activity, n]] of PLAN.entries()) {
    const kind = KINDS[activity];
    const city = cities[i % cities.length];
    const area = city.areas[Math.floor(i / cities.length) % city.areas.length];
    const owner = owners[city.id];
    const name = kind.names[n];
    const title = name;
    const cfg = config(kind, i);
    // The same rules the owner's hours form and the quote use.
    const { inventoryReady: _ready, ...rules } = cfg;
    const check = hourlyBookingConfigSchema.safeParse(rules);
    if (!check.success)
      throw new Error(`${name}: invalid hours ${JSON.stringify(check.error.issues)}`);
    const latestClose = Math.max(
      ...Object.values(cfg.weeklyHours)
        .flat()
        .map(
          (w) =>
            Number(w.close.slice(0, 2)) * 60 +
            Number(w.close.slice(3)) +
            (w.closesNextDay ? 1440 : 0),
        ),
    );
    const courtCount = kind.courts[0] + (i % (kind.courts[1] - kind.courts[0] + 1));
    const pool = kind.photos.flatMap((key) => PHOTOS[key] ?? []);
    const photos = Array.from({ length: Math.min(6, pool.length) }, (_, k) => ({
      url: pool[(i * 2 + k) % pool.length],
      alt: `${name} — photo ${k + 1}`,
    }));
    // Near the area centre (a few hundred metres off), so the map pin lands in the right area.
    const [centre] =
      await sql`SELECT ST_X(centre)::float8 AS x, ST_Y(centre)::float8 AS y FROM area WHERE id=${area.id}`;
    const jitter = () => (Math.random() - 0.5) * 0.02;
    const point =
      centre?.x != null
        ? { x: centre.x + jitter(), y: centre.y + jitter() }
        : { x: 72.83 + jitter(), y: 21.17 + jitter() };
    const [row] = await db
      .insert(s.rentable)
      .values({
        clientId: owner.id,
        slug: slugify(`${name} ${city.name}`),
        publicCode: code(),
        title,
        description: `${kind.blurb} ${name} is in ${area.name}, ${city.name}. Book ${kind.unit.toLowerCase()}s by the hour online; pay securely and get the exact address on confirmation.`,
        status: 'live',
        form: 'fixed',
        fulfilment: 'visit_site',
        rentalUnit: 'hour',
        categoryId: categories[activity],
        cityId: city.id,
        areaId: area.id,
        totalUnits: 1,
        capacity: kind.players,
        highlight: kind.highlight,
        houseRules: {
          minAge: null,
          smokingAllowed: false,
          alcoholAllowed: false,
          notes: i % 3 === 0 ? 'Arrive 10 minutes early for check-in.' : null,
          ...kind.rules,
        },
        photos,
        location: point,
        exactAddress: `Plot ${12 + i}, Sports Complex Road, ${area.name}, ${city.name} — released on confirmation`,
        depositMinor: 0,
        cancellationTier: TIERS[i % TIERS.length],
        ratingAvg: null,
        reviewCount: 0,
        verifiedAt: new Date(),
        availabilityConfirmedAt: new Date(),
        bookingConfig: cfg,
      })
      .returning();

    for (let c = 0; c < courtCount; c += 1) {
      const indoor = kind.indoor ?? c % 2 === 0;
      const courtName = `${kind.unit} ${c + 1}`;
      const details = JSON.stringify(
        kind.surface === 'Other' ? { size: kind.size } : { surface: kind.surface, size: kind.size },
      );
      const [court] =
        await sql`INSERT INTO rentable_resource(rentable_id,name,capacity,is_indoor,details,sort_order)
        VALUES (${row.id},${courtName},${kind.players},${indoor},${details}::jsonb,${(c + 1) * 10}) RETURNING id`;
      for (const slug of kind.activities(c))
        await sql`INSERT INTO rentable_resource_activity(resource_id,rentable_id,category_id) VALUES (${court.id},${row.id},${categories[slug]})`;
    }
    const offered = [
      ...new Set(Array.from({ length: courtCount }, (_, c) => kind.activities(c)).flat()),
    ];
    for (const slug of offered) {
      const bump = slug === activity ? (i % 3) * 100 : 0;
      for (const b of bands(kind, latestClose, bump))
        await sql`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
          VALUES (${row.id},${categories[slug]},${b.dayKind},${b.start},${b.end},${b.rate})`;
    }
    const chosen = kind.amenities.filter((slug) => amenities[slug]);
    for (const slug of chosen)
      await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${row.id},${amenities[slug]}) ON CONFLICT DO NOTHING`;

    await db.insert(s.documents).values({
      ownerType: 'rentable',
      ownerId: row.id,
      docType: 'shop_establishment',
      side: 'single',
      storageKey: `rentra/ownership/seed/${row.slug}`,
      mimeType: 'image/jpeg',
      nameOnDocument: owner.name,
      nameMatch: 'exact',
      issuedAt: new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10),
      status: 'accepted',
      reviewNote: 'Demo venue registration on file.',
      uploadedBy: owner.id,
    });
    if (i % 5 !== 4)
      await db.insert(s.verificationVisit).values({
        rentableId: row.id,
        mode: 'physical',
        outcome: 'passed',
        completedAt: new Date(Date.now() - 7 * 864e5),
        report: { notes: 'Demo: courts, lighting and safety checked.' },
      });
    made += 1;
    console.log(
      `  ✓ [${made}/50] ${title} (${city.name}) · ${courtCount} ${kind.unit.toLowerCase()}s -> /listing/${row.slug}-${row.publicCode}`,
    );
  }
  console.log(
    `[seed-venues] ${made} live demo venues. Set Entertainment to Public in Admin → Catalogues → Verticals to show them to guests.`,
  );
}

try {
  await seed();
} finally {
  await client.end();
}
