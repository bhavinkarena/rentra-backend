/**
 * Five fully-built listings for one named owner, across three Gujarat cities.
 *
 *   npm run seed:owner-listings
 *
 * Why a separate script rather than more rows in scripts/seed.mjs: that file
 * is the baseline every developer's database is built from and it is scoped to
 * the Surat belt on purpose. This adds two cities, so it is an expansion, and
 * an expansion that can be run against a database that already has data has to
 * be idempotent in a way a from-scratch seed does not.
 *
 * Grounded in the real Gujarat farmhouse market: Sanand and Sughad are the two
 * genuine farmhouse belts around Ahmedabad, Kalavad Road is Rajkot's, and the
 * price bands follow the same 12hr/24hr slot convention every local operator
 * uses — Ahmedabad runs materially above Surat, Rajkot sits between them.
 * The properties themselves are INVENTED. Nothing is copied from a competitor.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import * as s from '@/services/db/schema/index.js';

const OWNER_EMAIL = 'kunjdetroja52@gmail.com';

const client = postgres(process.env.DATABASE_URL, {
  prepare: false, max: 1, onnotice: () => {},
});
const db = drizzle(client, { schema: s });

function publicCode() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 8 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

/* ---------------------------- seed photography ---------------------------- */
let POOL = { pool: [], room: [], lawn: [] };
try {
  const mapData = await readFile(new URL('./cloudinary-seed-map.json', import.meta.url), 'utf-8');
  POOL = JSON.parse(mapData);
} catch {
  console.warn('[seed] cloudinary-seed-map.json not found — run `node scripts/upload-seed-to-cloudinary.mjs` first');
}

/**
 * Offset by a number derived from the slug rather than by insertion order, so
 * these five do not open with the same four photos as the Surat twelve.
 */
function galleryFor(spec, seed) {
  const take = (arr, n, off) =>
    arr.length ? Array.from({ length: n }, (_, i) => arr[(off + i) % arr.length]) : [];

  const hero = spec.pool ? take(POOL.pool, 3, seed) : take(POOL.lawn, 3, seed);
  const rooms = take(POOL.room, spec.bedrooms >= 3 ? 3 : 2, seed * 2);
  const grounds = spec.pool ? take(POOL.lawn, 2, seed + 1) : take(POOL.pool, 1, seed + 1);

  return [...hero, ...rooms, ...grounds].map((url, i) => ({
    url,
    alt: i === 0
      ? `${spec.title} in ${spec.areaName}, ${spec.cityName} — ${
        spec.pool ? `private ${spec.pool} swimming pool` : spec.highlight.toLowerCase()}`
      : url.includes('/room-') ? `Bedroom at ${spec.title}, ${spec.areaName}`
        : url.includes('/pool-') ? `Swimming pool at ${spec.title}, ${spec.areaName}`
          : `Lawn and grounds at ${spec.title}, ${spec.areaName}`,
  }));
}

/* ------------------------------ geography ------------------------------ */
/** [citySlug, cityName, [ [areaSlug, areaName, lng, lat], … ] ] */
const GEOGRAPHY = [
  ['ahmedabad', 'Ahmedabad', [
    ['sanand', 'Sanand', 72.3820, 22.9880],
    ['sughad', 'Sughad', 72.6280, 23.1450],
  ]],
  ['rajkot', 'Rajkot', [
    ['kalavad-road', 'Kalavad Road', 70.7450, 22.2680],
  ]],
];

/* ------------------------------- listings ------------------------------- */
const LISTINGS = [
  {
    slug: 'nandanvan-farm-sanand', title: 'Nandanvan Farm, Sanand',
    city: 'ahmedabad', area: 'sanand',
    bedrooms: 3, capacity: 60, highlight: 'Private pool',
    farmSize: 5, farmUnit: 'vigha', pool: '18x30', deposit: 6000, tier: 'moderate',
    verified: true, lng: 72.3901, lat: 22.9812,
    prices: { day: [9000, 15000], night: [11000, 17000], full_day: [14000, 22000] },
    blurb: 'On the Sanand–Nalsarovar road, far enough out that the city noise stops '
      + 'and close enough that the drive from SG Highway is under an hour.',
    amenities: [
      ['swimming_pool', '18x30'], ['ac_bedrooms', '3'], ['modular_kitchen', null],
      ['parking', '15'], ['generator', null], ['ro_water', null], ['bonfire', null],
      ['caretaker', null], ['open_lawn', '9000 sqft'], ['kids_play', null],
      ['sound_system', null], ['cctv', null],
    ],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Pool use is at the hiring party’s own risk — no lifeguard on site',
      'Music off by 11 PM as per local noise rules',
      'No outside DJ setup without prior permission'],
    reviews: [
      [5, 'Pool was spotless and the lawn is genuinely as big as the photos show.'],
      [5, 'Did a birthday for 40 people. Parking was the easy part, which is rare.'],
      [4, 'Lovely property. The drive from Bopal took longer than we planned for.']],
  },
  {
    slug: 'shivalik-lawn-and-farm-sughad', title: 'Shivalik Lawn & Farm, Sughad',
    city: 'ahmedabad', area: 'sughad',
    bedrooms: 2, capacity: 200, highlight: 'Banquet lawn',
    farmSize: 8, farmUnit: 'vigha', pool: null, deposit: 12000, tier: 'strict',
    verified: true, lng: 72.6321, lat: 23.1478,
    prices: { day: [18000, 28000], night: [20000, 30000], full_day: [28000, 42000] },
    blurb: 'A function plot first and a farmhouse second — built for engagements, '
      + 'receptions and corporate days on the Gandhinagar side of the river.',
    amenities: [
      ['banquet_lawn', '22000 sqft'], ['stage', null], ['green_room', null],
      ['mandap_space', null], ['bulk_parking', '60'], ['dj_allowed', null],
      ['sound_system', null], ['floodlights', null], ['generator', null],
      ['barbecue', null], ['cook_available', '₹2,000 per day'], ['water_24hr', null],
      ['first_aid', null],
    ],
    rules: ['Event permission from the local body is the hiring party’s responsibility',
      'Music off by 11 PM as per local noise rules',
      'Decor may not be nailed or screwed into any structure',
      'Final headcount confirmed 48 hours before the date'],
    reviews: [
      [5, 'Used it for an engagement. Stage and green room meant we hired almost nothing.'],
      [4, 'Big, well kept, handles a crowd. Strict on the 11 PM cut-off — they told us upfront.']],
  },
  {
    slug: 'tapi-bank-farm-mandvi', title: 'Tapi Bank Farm, Mandvi',
    city: 'surat', area: 'mandvi',
    bedrooms: 2, capacity: 30, highlight: 'Riverside orchard',
    farmSize: 4, farmUnit: 'vigha', pool: null, deposit: 3500, tier: 'flexible',
    verified: true, lng: 73.3012, lat: 21.2588,
    prices: { day: [5000, 8500], night: [6000, 9500], full_day: [7500, 11000] },
    blurb: 'A working chikoo and mango orchard on the Tapi bank. Quiet, shaded, and '
      + 'the right size for one family rather than a crowd.',
    amenities: [
      ['orchard', null], ['open_lawn', '5000 sqft'], ['kitchenette', null],
      ['utensils', null], ['parking', '6'], ['bonfire', null], ['ro_water', null],
      ['fans', null], ['inverter', null], ['swing', null], ['caretaker', null],
    ],
    rules: ['No alcohol on the premises',
      'Vegetarian cooking only in the kitchen',
      'Check-out by 10 AM',
      'Fruit on the trees is not for picking — it is the season’s crop'],
    reviews: [
      [5, 'Shaded, quiet and right by the water. Exactly what was described.'],
      [4, 'Simple place, no pool, and priced honestly for that. Caretaker was helpful.'],
      [5, 'Took my parents for a day out. They want to go back.']],
  },
  {
    slug: 'satyam-farm-rain-dance-sayan', title: 'Satyam Farm with rain dance, Sayan',
    city: 'surat', area: 'sayan',
    bedrooms: 3, capacity: 45, highlight: 'Rain dance',
    farmSize: 3.5, farmUnit: 'vigha', pool: '15x25', deposit: 5000, tier: 'moderate',
    verified: true, lng: 72.9538, lat: 21.2361,
    prices: { day: [7000, 11000], night: [8000, 12500], full_day: [10000, 15000] },
    blurb: 'Pool plus a proper rain-dance setup, which is what most of the day-picnic '
      + 'bookings on this stretch are actually looking for.',
    amenities: [
      ['swimming_pool', '15x25'], ['rain_dance', null], ['kids_pool', null],
      ['ac_bedrooms', '3'], ['modular_kitchen', null], ['parking', '10'],
      ['generator', null], ['bonfire', null], ['indoor_games', null],
      ['projector_tv', null], ['ro_water', null], ['caretaker', null],
    ],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Children must be supervised at the pool and rain dance at all times',
      'Music off by 11 PM as per local noise rules',
      'Rain dance runs 10 AM to 5 PM only, on the day slot'],
    reviews: [
      [5, 'Rain dance was the whole reason we booked and it did not disappoint.'],
      [4, 'Good for a school group. Pool is smaller than it looks in the first photo.'],
      [5, 'Office picnic for 40. Smooth from booking to check-out.'],
      [4, 'Clean and well run. Kitchen could use more utensils.']],
  },
  {
    slug: 'krishna-farm-kalavad-road-rajkot', title: 'Krishna Farm, Kalavad Road',
    city: 'rajkot', area: 'kalavad-road',
    bedrooms: 3, capacity: 50, highlight: 'Pool and lawn',
    farmSize: 4.5, farmUnit: 'vigha', pool: '16x28', deposit: 5000, tier: 'moderate',
    verified: true, lng: 70.7398, lat: 22.2641,
    prices: { day: [7500, 12000], night: [8500, 13500], full_day: [11000, 17000] },
    blurb: 'On the Kalavad Road stretch where most of Rajkot’s farmhouses sit — '
      + 'twenty minutes from the city and set back far enough from the highway.',
    amenities: [
      ['swimming_pool', '16x28'], ['open_lawn', '7000 sqft'], ['ac_bedrooms', '3'],
      ['modular_kitchen', null], ['gas_connection', null], ['parking', '12'],
      ['generator', null], ['bonfire', null], ['cricket_pitch', null],
      ['gazebo', null], ['ro_water', null], ['caretaker', null], ['wifi', null],
    ],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Pool use is at the hiring party’s own risk — no lifeguard on site',
      'Music off by 11 PM as per local noise rules',
      'Pets not allowed'],
    reviews: [
      [5, 'Best farmhouse we have booked on Kalavad Road. Pitch was a bonus.'],
      [4, 'Well maintained and easy to find. Generator kicked in twice, worked fine.'],
      [5, 'Booked the full day. Worth it over the 12-hour slot.']],
  },
];

/* ============================ the work ============================ */

const [owner] = await db.select().from(s.users)
  .where(and(eq(s.users.email, OWNER_EMAIL), eq(s.users.role, 'client'))).limit(1);

if (!owner) {
  console.error(`\n  No client account for ${OWNER_EMAIL}.`);
  console.error('  Create it first — this script attaches listings, it does not invent owners.\n');
  await client.end();
  process.exit(1);
}
if (owner.accountStatus !== 'active') {
  console.error(`\n  ${OWNER_EMAIL} is "${owner.accountStatus}", not active.`);
  console.error('  A Client cannot hold live listings before Gate 1 clears.\n');
  await client.end();
  process.exit(1);
}
console.log(`[seed] owner ${owner.name ?? OWNER_EMAIL} (${owner.id})`);

/* ------------------------- cities and areas ------------------------- */
const cityBySlug = {};
const areaByKey = {};

for (const [citySlug, cityName, areas] of GEOGRAPHY) {
  let [row] = await db.select().from(s.city).where(eq(s.city.slug, citySlug)).limit(1);
  if (!row) {
    [row] = await db.insert(s.city)
      .values({ slug: citySlug, name: cityName, state: 'Gujarat', isActive: true })
      .returning();
    console.log(`[seed] city created — ${cityName}`);
  }
  cityBySlug[citySlug] = row;

  for (const [areaSlug, areaName, lng, lat] of areas) {
    let [a] = await db.select().from(s.area)
      .where(and(eq(s.area.cityId, row.id), eq(s.area.slug, areaSlug))).limit(1);
    if (!a) {
      [a] = await db.insert(s.area)
        .values({ cityId: row.id, slug: areaSlug, name: areaName, centre: { x: lng, y: lat } })
        .returning();
      console.log(`[seed]   area created — ${areaName}, ${cityName}`);
    }
    areaByKey[`${citySlug}/${areaSlug}`] = a;
  }
}

// Surat and its areas already exist; look them up rather than re-creating.
for (const citySlug of new Set(LISTINGS.map((l) => l.city))) {
  if (cityBySlug[citySlug]) continue;
  const [row] = await db.select().from(s.city).where(eq(s.city.slug, citySlug)).limit(1);
  if (!row) throw new Error(`City "${citySlug}" is not seeded — run npm run db:seed first.`);
  cityBySlug[citySlug] = row;
}
for (const l of LISTINGS) {
  const key = `${l.city}/${l.area}`;
  if (areaByKey[key]) continue;
  const [a] = await db.select().from(s.area)
    .where(and(eq(s.area.cityId, cityBySlug[l.city].id), eq(s.area.slug, l.area))).limit(1);
  if (!a) throw new Error(`Area "${key}" is not seeded — run npm run db:seed first.`);
  areaByKey[key] = a;
}

const [farmhouse] = await db.select().from(s.category)
  .where(eq(s.category.slug, 'farmhouse')).limit(1);
if (!farmhouse) throw new Error('No "farmhouse" category — run npm run db:seed first.');

const amenityRows = await db.select().from(s.amenity);
const amenityBySlug = Object.fromEntries(amenityRows.map((a) => [a.slug, a]));

/* --------------------------- make re-runnable --------------------------- */
/**
 * `booking.rentable_id` is ON DELETE RESTRICT, and `payout.booking_id` is too,
 * so the children have to come off in dependency order before the listing can
 * go. Deliberately restrict-not-cascade in the schema: a booking is a
 * financial record and must never vanish because someone deleted a listing.
 */
const slugs = LISTINGS.map((l) => l.slug);
const existing = await db.select({ id: s.rentable.id }).from(s.rentable)
  .where(inArray(s.rentable.slug, slugs));

if (existing.length) {
  const ids = existing.map((r) => r.id);
  const bookings = await db.select({ id: s.booking.id }).from(s.booking)
    .where(inArray(s.booking.rentableId, ids));
  const bookingIds = bookings.map((b) => b.id);

  if (bookingIds.length) {
    await db.delete(s.payout).where(inArray(s.payout.bookingId, bookingIds));
    await db.delete(s.review).where(inArray(s.review.bookingId, bookingIds));
    await db.delete(s.booking).where(inArray(s.booking.id, bookingIds));
  }
  // The document vault is polymorphic, so no FK cascades it.
  await db.delete(s.documents).where(and(
    eq(s.documents.ownerType, 'rentable'), inArray(s.documents.ownerId, ids),
  ));
  await db.delete(s.rentable).where(inArray(s.rentable.id, ids));
  console.log(`[seed] replaced ${existing.length} existing listing(s)`);
}

/* ------------------------------ the listings ------------------------------ */
const guests = await db.select().from(s.users).where(eq(s.users.role, 'customer')).limit(10);
const inserted = [];
const today = new Date();

for (const [idx, l] of LISTINGS.entries()) {
  const cityRow = cityBySlug[l.city];
  const areaRow = areaByKey[`${l.city}/${l.area}`];
  const spec = { ...l, cityName: cityRow.name, areaName: areaRow.name };

  // Labels for the jsonb column the public page still reads, resolved from the
  // taxonomy so the two can never disagree about what an amenity is called.
  const amenityLabels = l.amenities.map(([slug, value]) => {
    const a = amenityBySlug[slug];
    if (!a) throw new Error(`Unknown amenity "${slug}" — check the taxonomy.`);
    return value ? `${a.labelEn} ${value}` : a.labelEn;
  });

  const [row] = await db.insert(s.rentable).values({
    clientId: owner.id,
    slug: l.slug,
    publicCode: publicCode(),
    title: l.title,
    description:
      `${l.blurb} ${l.farmSize} ${l.farmUnit} of land, sleeping up to ${l.capacity} guests `
      + `across ${l.bedrooms} ${l.bedrooms === 1 ? 'bedroom' : 'bedrooms'}. `
      + `${l.pool ? `Private ${l.pool} swimming pool. ` : 'No swimming pool. '}`
      + 'Book the 12-hour day slot, the overnight slot, or the full 24 hours. '
      + `${l.verified ? 'Physically visited and photographed by the Rentra team.' : 'Verification visit pending.'}`,
    status: 'live',
    form: 'fixed', fulfilment: 'visit_site', rentalUnit: 'slot',
    categoryId: farmhouse.id, cityId: cityRow.id, areaId: areaRow.id,
    totalUnits: 1,
    capacity: l.capacity, bedrooms: l.bedrooms, highlight: l.highlight,
    amenities: amenityLabels, houseRules: l.rules,
    photos: galleryFor(spec, idx * 3 + 1),
    location: { x: l.lng, y: l.lat },
    exactAddress: `Survey No. ${210 + idx}/${l.bedrooms}, ${areaRow.name}, `
      + `${cityRow.name} — released on confirmation`,
    farmSize: l.farmSize, farmSizeUnit: l.farmUnit, poolSize: l.pool,
    checkInFrom: '9 AM to 7 PM', checkOutBy: '8 AM to 6 PM',
    depositAmount: l.deposit, cancellationTier: l.tier,
    ratingAvg: null, reviewCount: 0,
    verifiedAt: l.verified ? new Date() : null,
    availabilityConfirmedAt: new Date(),
  }).returning();

  await db.insert(s.rentablePrice).values(
    Object.entries(l.prices).map(([slot, [weekday, weekend]]) => ({
      rentableId: row.id, slot, weekday, weekend,
    })),
  );

  /**
   * BOTH amenity shapes, deliberately.
   *
   * `rentable.amenities` (jsonb labels) is what the public listing page reads
   * today; `rentable_amenity` is the fixed taxonomy that makes a tag
   * filterable and translatable. The join table was empty across the whole
   * database before this — see the build log's open gaps. Writing both means
   * these five are already correct when the page moves over.
   */
  await db.insert(s.rentableAmenity).values(
    l.amenities.map(([slug, value]) => ({
      rentableId: row.id, amenityId: amenityBySlug[slug].id, value,
    })),
  );

  /**
   * The ownership document. Without a row here `listingCompletion` reports 8
   * of 9 sections on a listing that is already live, which reads as broken to
   * the owner. The storage key is clearly marked as seed data — there is no
   * real file behind it, and the review note says so.
   */
  await db.insert(s.documents).values({
    ownerType: 'rentable', ownerId: row.id,
    docType: 'electricity_bill', side: 'single',
    storageKey: `rentra/ownership/seed/${l.slug}`,
    mimeType: 'image/jpeg',
    nameOnDocument: owner.name ?? 'Kunj Detroja',
    nameMatch: 'exact',
    issuedAt: new Date(today.getTime() - 30 * 864e5).toISOString().slice(0, 10),
    status: 'accepted',
    reviewNote: 'Seed data — no file is stored behind this key.',
    uploadedBy: owner.id,
  });

  inserted.push({ row, spec: l });
  console.log(`[seed] ${l.title} — ${areaRow.name}, ${cityRow.name}`);
}

/* ----------------------------- availability ----------------------------- */
const availRows = [];
for (const [idx, { row }] of inserted.entries()) {
  for (let i = 0; i < 90; i += 1) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    // Deterministic but uneven blocks, so the calendar looks lived-in rather
    // than machine-generated.
    const blocked = (i + idx * 5) % 11 === 0 || (i + idx * 2) % 17 === 0;
    for (const slot of ['day', 'night']) {
      availRows.push({
        rentableId: row.id, day: d.toISOString().slice(0, 10), slot,
        unitsAvailable: blocked ? 0 : 1, blockedByClient: blocked,
      });
    }
  }
}
for (let i = 0; i < availRows.length; i += 1000) {
  await db.insert(s.availability).values(availRows.slice(i, i + 1000));
}
console.log(`[seed] availability — ${availRows.length} rows (90 days x day/night)`);

/* --------------------- past bookings, payouts, reviews --------------------- */
// Seed visits remain simulations and never create customer reviews or ratings.
if (!guests.length) {
  console.warn('[seed] no customer accounts — skipping bookings, payouts and reviews');
} else {
  const [{ max } = {}] = await client`
    select max(nullif(regexp_replace(reference, '\\D', '', 'g'), '')::int) as max from booking
  `;
  let refSeq = Number(max ?? 0);
  const nextRef = () => `RNT${(++refSeq).toString().padStart(5, '0')}`;

  let bookingCount = 0;
  for (const [idx, { row, spec }] of inserted.entries()) {
    for (let rIdx = 0; rIdx < spec.reviews.length; rIdx += 1) {
      const past = new Date(today);
      past.setDate(past.getDate() - (12 + rIdx * 9 + idx * 4));
      const guest = guests[(idx + rIdx) % guests.length];

      const slot = rIdx % 2 === 0 ? 'night' : 'day';
      const rent = spec.prices[slot][0];
      const fee = Math.round(rent * 0.08);

      const [bk] = await db.insert(s.booking).values({
        reference: nextRef(), rentableId: row.id, customerId: guest.id,
        day: past.toISOString().slice(0, 10), slot,
        guests: Math.max(2, Math.round(spec.capacity * 0.5)),
        amountRent: rent, amountFee: fee, amountDeposit: spec.deposit,
        amountAdvancePaid: Math.round(rent * 0.25 + fee),
        visitProvenance: 'seed', paymentMode: 'simulated', collectedMinor: 0,
        balanceMode: rIdx % 3 === 0 ? 'cash_on_arrival' : 'online_before',
        balanceSettledAt: past, state: 'completed',
        checkInCode: String(1000 + ((idx * 11 + rIdx * 7) % 8999)),
        contactPhone: guest.phone, confirmedAt: past,
      }).returning();

      // TDS u/s 194-O at 0.1% of gross. Confirm the rate with a CA.
      const tds = Math.round(rent * 0.001);
      await db.insert(s.payout).values({
        bookingId: bk.id, clientId: owner.id,
        gross: rent, commission: fee, tds194o: tds, gstTcs: 0,
        net: rent - fee - tds, status: 'paid',
        utr: `NEFT${(950000 + idx * 100 + rIdx).toString()}`, settledAt: past,
      });

      // Simulation bookings never create public customer reviews.
      bookingCount += 1;
    }
  }
  console.log(`[seed] ${bookingCount} simulated bookings + legacy payout fixtures (no reviews)`);
}

console.log(`\n  Done. ${inserted.length} live listings for ${OWNER_EMAIL}:`);
for (const { row, spec } of inserted) {
  const area = areaByKey[`${spec.city}/${spec.area}`];
  console.log(`    ${cityBySlug[spec.city].name.padEnd(10)} ${area.name.padEnd(14)} /listing/${row.slug}-${row.publicCode}`);
}
console.log('');

await client.end();
