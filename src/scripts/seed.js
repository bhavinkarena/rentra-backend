import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import * as s from '@/services/db/schema/index.js';
import { hashPassword } from '@/services/auth/admin-crypto.js';

/**
 * Development seed data.
 *
 * Grounded in real research of the Surat-belt farmhouse market (farmhouserent.in,
 * suratfarmhouse.com, farmhousehub.in, BookMyFarm — Sept 2026): real localities,
 * real price bands, real amenity vocabulary, real deposit ratios and the
 * 12hr/24hr slot convention every local competitor uses.
 *
 * The listings themselves are INVENTED. No description, photo or property
 * identity is copied from any competitor — the plan's own moderation rules
 * call for reverse-image checks against exactly that.
 */

const client = postgres(process.env.DATABASE_URL, {
  prepare: false, max: 1, onnotice: () => {},
});

/* ---------------------------- seed photography ---------------------------- */
let PHOTO_POOL = { pool: [], room: [], lawn: [] };
try {
  const mapData = await readFile(new URL('./cloudinary-seed-map.json', import.meta.url), 'utf-8');
  PHOTO_POOL = JSON.parse(mapData);
} catch {
  console.warn('[seed] cloudinary-seed-map.json not found — run `node scripts/upload-seed-to-cloudinary.mjs` first');
}

/**
 * Build a listing's gallery: the hero shot leads with whatever the property
 * is actually sold on (pool, or the lawn if there is none), then interiors,
 * then grounds. Deterministic per index so re-seeding is stable.
 *
 * Alt text is real and specific — it is read by screen readers AND is one of
 * the few image-SEO signals that still carries weight.
 */
function galleryFor(spec, idx, areaName) {
  const pick = (arr, n, offset) =>
    arr.length ? Array.from({ length: n }, (_, i) => arr[(offset + i) % arr.length]) : [];

  const area = areaName;
  const hero = spec.pool
    ? pick(PHOTO_POOL.pool, 2, idx * 2)
    : pick(PHOTO_POOL.lawn, 2, idx * 2);
  const rooms = pick(PHOTO_POOL.room, spec.bedrooms >= 3 ? 3 : 2, idx * 3);
  const grounds = spec.pool
    ? pick(PHOTO_POOL.lawn, 1, idx)
    : pick(PHOTO_POOL.pool, 0, idx);

  const urls = [...hero, ...rooms, ...grounds];
  return urls.map((url, i) => ({
    url,
    alt: i === 0
      ? `${spec.title} in ${area}, Surat — ${spec.pool ? `private ${spec.pool} swimming pool` : spec.highlight.toLowerCase()}`
      : url.includes('/room-')
        ? `Bedroom at ${spec.title}, ${area}`
        : url.includes('/pool-')
          ? `Swimming pool at ${spec.title}, ${area}`
          : `Garden and lawn at ${spec.title}, ${area}`,
  }));
}

/** Short, permanent, URL-safe public id. 8 chars of base36 ≈ 2.8e12 space. */
const publicCode = () =>
  Array.from({ length: 8 }, () =>
    '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('');
const db = drizzle(client, { schema: s });

console.log('[seed] clearing');
await client`TRUNCATE TABLE
  review, payout, booking, availability, rentable_price, unit, rentable,
  client_staff, "user", person, area, city, category, redirect
  RESTART IDENTITY CASCADE`;

/* ------------------------------- taxonomy ------------------------------- */
console.log('[seed] city + areas');
const [surat] = await db.insert(s.city)
  .values({ slug: 'surat', name: 'Surat', state: 'Gujarat' }).returning();

// Real localities in the Surat 40km weekend belt, with real coordinates.
const AREAS = [
  ['kamrej',   'Kamrej',   72.9667, 21.2667],
  ['olpad',    'Olpad',    72.7526, 21.3372],
  ['kadodara', 'Kadodara', 72.9800, 21.1200],
  ['bardoli',  'Bardoli',  73.1119, 21.1225],
  ['dumas',    'Dumas',    72.7167, 21.0833],
  ['sayan',    'Sayan',    72.9500, 21.2333],
  ['sevni',    'Sevni',    72.9800, 21.2800],
  ['digas',    'Digas',    72.9500, 21.1500],
  ['ghaludi',  'Ghaludi',  73.0500, 21.0500],
  ['mandvi',   'Mandvi',   73.2989, 21.2547],
  ['kim',      'Kim',      72.9667, 21.3167],
  ['hazira',   'Hazira',   72.6500, 21.1167],
];
const areaRows = await db.insert(s.area).values(
  AREAS.map(([slug, name, x, y]) => ({
    cityId: surat.id, slug, name, centre: { x, y },
  })),
).returning();
const byArea = Object.fromEntries(areaRows.map((a) => [a.slug, a]));

const [farmhouse] = await db.insert(s.category).values({
  slug: 'farmhouse', name: 'Farmhouse', form: 'fixed', defaultRentalUnit: 'slot',
}).returning();

/* ------------------------------- identity ------------------------------- */
console.log('[seed] the dummy client + guests');

const [clientPerson] = await db.insert(s.person).values({
  kycRef: 'kyc_seed_client_0001',
  verifiedName: 'Demo Client',
  verifiedAt: new Date(),
}).returning();

// THE dummy client that owns every seeded listing.
const [demoClient] = await db.insert(s.users).values({
  phone: '9000000001',
  role: 'client',
  name: 'Demo Client',
  email: 'client@gmail.com',
  accountStatus: 'active',
  clientType: 'owner',
  personId: clientPerson.id,
  kycStatus: 'verified',
  payoutUpiId: 'client@upi',
  respondsWithinMins: 84,
  responseRate: 0.94,
}).returning();

// Same human, second account. Possible only because uniqueness is
// (phone, role) and not phone alone — and KYC is reused via person_id.
await db.insert(s.users).values({
  phone: '9000000001', role: 'customer', name: 'Demo Client',
  email: 'client@gmail.com', personId: clientPerson.id, kycStatus: 'verified',
  accountStatus: 'active',
});

const guests = await db.insert(s.users).values([
  { phone: '9898980001', role: 'customer', name: 'Rahul S.',  kycStatus: 'verified', accountStatus: 'active' },
  { phone: '9898980002', role: 'customer', name: 'Priya M.',  kycStatus: 'verified', accountStatus: 'active' },
  { phone: '9898980003', role: 'customer', name: 'Jignesh T.', kycStatus: 'verified', accountStatus: 'active' },
  { phone: '9898980004', role: 'customer', name: 'Ankita D.', kycStatus: 'verified', accountStatus: 'active' },
  { phone: '9898980005', role: 'customer', name: 'Mehul V.',  kycStatus: 'none', accountStatus: 'active' },
]).returning();

// Ensure default admin user is seeded so db:seed never leaves an adminless DB
console.log('[seed] default admin user (admin@gmail.com / Admin@123)');
const adminEmail = 'admin@gmail.com';
const adminHash = hashPassword('Admin@123');
const [existingAdmin] = await client`SELECT id FROM admin_user WHERE email = ${adminEmail}`;
if (existingAdmin) {
  await client`UPDATE admin_user SET password_hash = ${adminHash}, is_active = true, failed_attempts = 0, locked_until = NULL WHERE id = ${existingAdmin.id}`;
} else {
  await client`INSERT INTO admin_user (email, name, password_hash) VALUES (${adminEmail}, 'Super Admin', ${adminHash})`;
}


// The caretaker who actually runs the properties — a child of the Client.
await db.insert(s.clientStaff).values({
  clientId: demoClient.id, phone: '9700000011', name: 'Ramesh (caretaker)',
  permissions: { checkIn: true, capturePhotos: true, markReturn: true, confirmCash: true },
});

/* ------------------------------- listings ------------------------------- */
/**
 * Prices are [weekday, weekend] in whole rupees, per slot.
 * Slot naming maps onto the local convention:
 *   day      = the 12-hour daytime slot  (market: "12 Hours")
 *   night    = the 12-hour overnight slot
 *   full_day = the 24-hour slot          (market: "24 Hours")
 * Deposits sit at roughly 40-50% of the 24hr weekend rate, as observed.
 */
const LISTINGS = [
  {
    slug: 'riverside-farm-with-private-pool', title: 'Riverside Farm with private pool',
    area: 'kamrej', bedrooms: 3, capacity: 32, highlight: 'Private pool',
    farmSize: 2.5, farmUnit: 'vigha', pool: '15x25', deposit: 4000, tier: 'moderate',
    verified: true, lng: 72.9701, lat: 21.2688,
    prices: { day: [6000, 12000], night: [7500, 13000], full_day: [8500, 14500] },
    amenities: ['Swimming pool 15x25', 'AC bedrooms', 'Modular kitchen', 'Common area',
      'Living room', 'Parking for 8 cars', 'Power backup (generator)', 'RO drinking water',
      'Bonfire allowed', 'Caretaker on site'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Pool use is at the hiring party’s own risk — no lifeguard on site',
      'Music off by 11 PM as per local noise rules',
      'Vegetarian cooking only in the kitchen'],
    reviews: [[5, 'Exactly as shown in the photos. Pool was clean and the caretaker was helpful.'],
      [5, 'Booked for a family day picnic. Kitchen was well stocked, parking was easy.'],
      [4, 'Great farm. Water pressure in the second bathroom was weak.'],
      [5, 'Second time here. Owner responds fast on chat.']],
  },
  {
    slug: 'mango-grove-farmhouse-bardoli', title: 'Mango Grove Farmhouse',
    area: 'bardoli', bedrooms: 2, capacity: 25, highlight: 'Mango orchard',
    farmSize: 4, farmUnit: 'vigha', pool: null, deposit: 3000, tier: 'flexible',
    verified: true, lng: 73.1150, lat: 21.1240,
    prices: { day: [4500, 7500], night: [5500, 8500], full_day: [6500, 9500] },
    amenities: ['Mango orchard', 'Open lawn', 'Common area', 'Kitchen', 'Parking for 5 cars',
      'Bonfire allowed', 'RO drinking water', 'Cricket pitch'],
    rules: ['No alcohol on the premises', 'Check-out by 10 AM',
      'Maximum occupancy strictly enforced'],
    reviews: [[5, 'Lovely quiet orchard. Perfect for a small family gathering.'],
      [4, 'Good value for a day picnic. No pool, which was clearly mentioned upfront.']],
  },
  {
    slug: 'palm-court-lawn-and-villa-olpad', title: 'Palm Court Lawn & Villa',
    area: 'olpad', bedrooms: 3, capacity: 120, highlight: 'Banquet lawn',
    farmSize: 6, farmUnit: 'vigha', pool: null, deposit: 8000, tier: 'strict',
    verified: false, lng: 72.7560, lat: 21.3390,
    prices: { day: [15000, 22000], night: [17000, 24000], full_day: [24000, 34000] },
    amenities: ['Banquet lawn', 'Stage', 'DJ / music system allowed', 'Green room',
      'Parking for 40 cars', 'Power backup (generator)', 'Barbecue setup'],
    rules: ['Local body permission required for events over 150 guests',
      'Music off by midnight', 'No decorations or nails on walls without prior permission'],
    reviews: [],
  },
  {
    slug: 'sunset-farm-and-pool-kadodara', title: 'Sunset Farm & Pool',
    area: 'kadodara', bedrooms: 4, capacity: 45, highlight: 'Private pool',
    farmSize: 3, farmUnit: 'vigha', pool: '20x30', deposit: 6000, tier: 'moderate',
    verified: true, lng: 72.9830, lat: 21.1215,
    prices: { day: [8000, 13000], night: [9500, 15000], full_day: [12000, 17000] },
    amenities: ['Swimming pool 20x30', 'AC bedrooms', 'Two kitchens', 'Living room',
      'Indoor games (carrom, table tennis)', 'Parking for 12 cars',
      'Power backup (generator)', 'Geyser', 'Caretaker on site', 'CCTV at entrance'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Music off by 11 PM as per local noise rules', 'Max 45 guests strictly',
      'Pets not allowed'],
    reviews: [[5, 'Big farm, four proper bedrooms. Worked well for 30 of us.'],
      [5, 'Pool was spotless. Caretaker helped with the bonfire.'],
      [5, 'Booked the 24-hour slot. Worth it over the day slot.'],
      [4, 'Excellent, though the approach road is rough for the last 500m.'],
      [5, 'Third booking. Consistently clean.']],
  },
  {
    slug: 'daisy-villa-kamrej', title: 'Daisy Villa with rain dance',
    area: 'kamrej', bedrooms: 3, capacity: 35, highlight: 'Rain dance',
    farmSize: 2, farmUnit: 'vigha', pool: '18x30', deposit: 7000, tier: 'strict',
    verified: true, lng: 72.9640, lat: 21.2705,
    prices: { day: [9000, 18000], night: [10500, 19000], full_day: [11000, 20000] },
    amenities: ['Swimming pool 18x30', 'Rain dance', 'AC bedrooms', 'Modular kitchen',
      'DJ / music system allowed', 'Parking for 10 cars', 'Power backup (generator)',
      'Barbecue setup', 'Kids play area'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Rain dance available on prior request only',
      'Pool use is at the hiring party’s own risk — no lifeguard on site'],
    reviews: [[5, 'Kids loved the rain dance. Booked for a birthday.'],
      [4, 'Premium pricing on weekends but the property justifies it.'],
      [5, 'Clean, spacious, and the DJ setup was allowed without fuss.']],
  },
  {
    slug: 'aashirwad-farm-dumas', title: 'Aashirwad Farm near Dumas beach',
    area: 'dumas', bedrooms: 4, capacity: 40, highlight: 'Near beach',
    farmSize: 3.5, farmUnit: 'vigha', pool: '15x25', deposit: 6500, tier: 'moderate',
    verified: true, lng: 72.7190, lat: 21.0850,
    prices: { day: [10000, 13000], night: [12000, 15000], full_day: [14000, 17000] },
    amenities: ['Swimming pool 15x25', 'AC bedrooms', 'Modular kitchen', 'Living room',
      'Parking for 15 cars', 'Power backup (generator)', 'RO drinking water',
      'Bonfire allowed', '10 minutes from Dumas beach'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Music off by 11 PM as per local noise rules',
      'Vegetarian cooking only in the kitchen'],
    reviews: [[5, 'Close to the beach, which made the trip easy with kids.'],
      [4, 'Spacious. Humid because of the coast, but the ACs coped.']],
  },
  {
    slug: 'bajrang-farm-kadodara', title: 'Bajrang Farm with cricket pitch',
    area: 'kadodara', bedrooms: 3, capacity: 38, highlight: 'Cricket pitch',
    farmSize: 5, farmUnit: 'vigha', pool: '12x20', deposit: 6000, tier: 'moderate',
    verified: true, lng: 72.9770, lat: 21.1230,
    prices: { day: [10000, 16000], night: [11000, 17000], full_day: [12000, 18000] },
    amenities: ['Cricket pitch', 'Swimming pool 12x20', 'Open lawn', 'AC bedrooms',
      'Kitchen', 'Parking for 12 cars', 'Bonfire allowed', 'Floodlights for night cricket'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Floodlights off by 11 PM', 'Stag groups considered on request'],
    reviews: [[5, 'Came for a corporate offsite. Cricket pitch with lights was the highlight.'],
      [5, 'Big open space, well maintained.'],
      [4, 'Pool is small relative to the group size.']],
  },
  {
    slug: 'olivia-green-dumas', title: 'Olivia Green budget farm',
    area: 'dumas', bedrooms: 2, capacity: 22, highlight: 'Budget friendly',
    farmSize: 1.5, farmUnit: 'vigha', pool: null, deposit: 2500, tier: 'flexible',
    verified: true, lng: 72.7140, lat: 21.0810,
    prices: { day: [4500, 7500], night: [5000, 8000], full_day: [5500, 8500] },
    amenities: ['Open lawn', 'Common area', 'Kitchen', 'Parking for 4 cars',
      'RO drinking water', 'Bonfire allowed'],
    rules: ['Maximum occupancy strictly enforced', 'No loud music after 10 PM'],
    reviews: [[4, 'Honest pricing, nothing fancy. Good for a small group.'],
      [4, 'Simple and clean. No pool as listed.'],
      [5, 'Cheapest verified farm we could find nearby.']],
  },
  {
    slug: 'fantastica-farm-kamrej', title: 'Fantastica Farm',
    area: 'kamrej', bedrooms: 2, capacity: 28, highlight: 'Private pool',
    farmSize: 2, farmUnit: 'vigha', pool: '15x25', deposit: 4500, tier: 'moderate',
    verified: true, lng: 72.9680, lat: 21.2710,
    prices: { day: [7500, 10000], night: [8500, 11000], full_day: [9000, 11500] },
    amenities: ['Swimming pool 15x25', 'AC bedrooms', 'Kitchen', 'Common area',
      'Parking for 6 cars', 'Power backup (generator)', 'Geyser'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Pool use is at the hiring party’s own risk — no lifeguard on site'],
    reviews: [[4, 'Good mid-range option. Pool was warm in the afternoon.'],
      [5, 'Owner was flexible with our late check-in.']],
  },
  {
    slug: 'stone-villa-olpad', title: 'Stone Villa on the Tapi bank',
    area: 'olpad', bedrooms: 3, capacity: 30, highlight: 'Riverfront',
    farmSize: 4.5, farmUnit: 'vigha', pool: '18x28', deposit: 6500, tier: 'strict',
    verified: false, lng: 72.7490, lat: 21.3350,
    prices: { day: [5500, 9000], night: [11000, 15000], full_day: [13000, 17000] },
    amenities: ['Riverfront access', 'Swimming pool 18x28', 'AC bedrooms',
      'Modular kitchen', 'Living room', 'Parking for 10 cars', 'Barbecue setup'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Children must be supervised near the river',
      'No decorations or nails on walls without prior permission'],
    reviews: [],
  },
  {
    slug: 'nilkanth-farm-kamrej', title: 'Nilkanth Farm',
    area: 'kamrej', bedrooms: 1, capacity: 15, highlight: 'Couples & small groups',
    farmSize: 1, farmUnit: 'vigha', pool: '12x18', deposit: 2500, tier: 'flexible',
    verified: true, lng: 72.9720, lat: 21.2630,
    prices: { day: [5500, 7000], night: [7500, 12000], full_day: [9500, 15000] },
    amenities: ['Swimming pool 12x18', 'AC bedroom', 'Kitchenette', 'Private garden',
      'Parking for 3 cars', 'RO drinking water'],
    rules: ['Couples must carry valid ID', 'Maximum 15 guests',
      'No loud music after 10 PM'],
    reviews: [[5, 'Small and private, exactly what we wanted for a couples trip.'],
      [4, 'Well kept. Pool is compact but clean.']],
  },
  {
    slug: 'green-valley-kadodara', title: 'Green Valley Farm',
    area: 'kadodara', bedrooms: 2, capacity: 30, highlight: 'Large lawn',
    farmSize: 3, farmUnit: 'vigha', pool: '15x25', deposit: 5000, tier: 'moderate',
    verified: true, lng: 72.9810, lat: 21.1180,
    prices: { day: [6500, 9000], night: [7500, 10000], full_day: [9000, 12000] },
    amenities: ['Swimming pool 15x25', 'Large open lawn', 'AC bedrooms', 'Kitchen',
      'Parking for 10 cars', 'Power backup (generator)', 'Bonfire allowed',
      'Kids play area'],
    rules: ['Valid Aadhaar or ID proof required for all guests',
      'Music off by 11 PM as per local noise rules', 'Pets not allowed'],
    reviews: [[4, 'Handy for anyone commuting from the city. Big lawn.'],
      [5, 'Booked the day slot for an office picnic. Went smoothly.'],
      [4, 'Good, though traffic on the way in was heavy.']],
  },
];

console.log(`[seed] ${LISTINGS.length} listings`);
const inserted = [];

for (const l of LISTINGS) {
  // Seed visits are simulations, so public review aggregates stay empty.
  const [row] = await db.insert(s.rentable).values({
    clientId: demoClient.id,
    slug: l.slug,
    publicCode: publicCode(),
    title: l.title,
    description:
      `${l.title} in ${byArea[l.area].name}, ${l.farmSize} ${l.farmUnit} of land, `
      + `sleeping up to ${l.capacity} guests across ${l.bedrooms} `
      + `${l.bedrooms === 1 ? 'bedroom' : 'bedrooms'}. `
      + `${l.pool ? `Private ${l.pool} swimming pool. ` : 'No swimming pool. '}`
      + `Book the 12-hour day slot, the overnight slot, or the full 24 hours. `
      + `${l.verified ? 'Physically visited and photographed by the Rentra team.' : 'Verification visit pending.'}`,
    status: 'live',
    form: 'fixed', fulfilment: 'visit_site', rentalUnit: 'slot',
    categoryId: farmhouse.id, cityId: surat.id, areaId: byArea[l.area].id,
    totalUnits: 1,
    capacity: l.capacity, bedrooms: l.bedrooms, highlight: l.highlight,
    amenities: l.amenities, houseRules: l.rules,
    photos: galleryFor(l, inserted.length, byArea[l.area].name),
    location: { x: l.lng, y: l.lat },
    exactAddress: `Survey No. ${100 + inserted.length}/${l.bedrooms}, `
      + `${byArea[l.area].name}, Surat — released on confirmation`,
    farmSize: l.farmSize, farmSizeUnit: l.farmUnit, poolSize: l.pool,
    checkInFrom: '9 AM to 7 PM', checkOutBy: '8 AM to 6 PM',
    depositAmount: l.deposit, cancellationTier: l.tier,
    ratingAvg: null, reviewCount: 0,
    verifiedAt: l.verified ? new Date() : null,
    availabilityConfirmedAt: new Date(),
    bookingConfig: {
      inventoryReady: true,
      timeZone: 'Asia/Kolkata',
      leadTimeMinutes: 120,
      bookingHorizonDays: 90,
      slots: {
        day: {
          enabled: true,
          startTime: '09:00',
          endTime: '21:00',
          endDayOffset: 0,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          capacity: l.capacity,
          includedGuests: l.capacity,
          extraGuestChargeMinor: 0,
        },
        night: {
          enabled: true,
          startTime: '21:00',
          endTime: '08:00',
          endDayOffset: 1,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          capacity: l.capacity,
          includedGuests: l.capacity,
          extraGuestChargeMinor: 0,
        },
        full_day: {
          enabled: true,
          startTime: '09:00',
          endTime: '08:00',
          endDayOffset: 1,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          capacity: l.capacity,
          includedGuests: l.capacity,
          extraGuestChargeMinor: 0,
        },
      },
    },
  }).returning();

  await db.insert(s.rentablePrice).values(
    Object.entries(l.prices).map(([slot, [weekday, weekend]]) => ({
      rentableId: row.id, slot, weekday, weekend,
    })),
  );

  inserted.push({ row, spec: l });
}

/* ---------------------------- availability ---------------------------- */
console.log('[seed] availability — 90 days x day/night per listing');
const today = new Date();
const availRows = [];
for (const { row } of inserted) {
  for (let i = 0; i < 90; i += 1) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const day = d.toISOString().slice(0, 10);
    // Every date starts open; only real bookings and owner blocks close one.
    for (const slot of ['day', 'night']) {
      availRows.push({
        rentableId: row.id, day, slot,
        unitsAvailable: 1,
        blockedByClient: false,
      });
    }
  }
}
for (let i = 0; i < availRows.length; i += 1000) {
  await db.insert(s.availability).values(availRows.slice(i, i + 1000));
}

/* --------------------- bookings, payouts, reviews --------------------- */
console.log('[seed] simulated bookings + legacy payout fixtures (no reviews)');
let refSeq = 0;
const nextRef = () => `RNT${(++refSeq).toString().padStart(5, '0')}`;

for (const [idx, { row, spec }] of inserted.entries()) {
  for (let rIdx = 0; rIdx < spec.reviews.length; rIdx += 1) {
    const past = new Date(today);
    past.setDate(past.getDate() - (14 + rIdx * 11 + idx));
    const guest = guests[(idx + rIdx) % guests.length];

    const slot = rIdx % 2 === 0 ? 'night' : 'day';
    const rent = spec.prices[slot][0];
    const fee = Math.round(rent * 0.08);
    const advance = Math.round(rent * 0.25 + fee);

    const [bk] = await db.insert(s.booking).values({
      reference: nextRef(), rentableId: row.id, customerId: guest.id,
      day: past.toISOString().slice(0, 10), slot,
      guests: Math.max(2, Math.round(spec.capacity * 0.6)),
      amountRent: rent, amountFee: fee, amountDeposit: spec.deposit,
      amountAdvancePaid: advance,
      visitProvenance: 'seed', paymentMode: 'simulated', collectedMinor: 0,
      balanceMode: rIdx % 3 === 0 ? 'cash_on_arrival' : 'online_before',
      balanceSettledAt: past, state: 'completed',
      checkInCode: String(1000 + ((idx * 7 + rIdx * 13) % 8999)),
      contactPhone: guest.phone, confirmedAt: past,
    }).returning();

    // TDS u/s 194-O at 0.1% of gross. Confirm the rate with a CA.
    const tds = Math.round(rent * 0.001);
    await db.insert(s.payout).values({
      bookingId: bk.id, clientId: demoClient.id,
      gross: rent, commission: fee, tds194o: tds, gstTcs: 0,
      net: rent - fee - tds, status: 'paid',
      utr: `NEFT${(900000 + idx * 100 + rIdx).toString()}`, settledAt: past,
    });

    // Simulation bookings never create public customer reviews.
  }
}

/* -------------------------------- report -------------------------------- */
const counts = await client`
  select 'city' t, count(*) n from city
  union all select 'area', count(*) from area
  union all select 'user', count(*) from "user"
  union all select 'client_staff', count(*) from client_staff
  union all select 'rentable', count(*) from rentable
  union all select 'rentable_price', count(*) from rentable_price
  union all select 'availability', count(*) from availability
  union all select 'booking', count(*) from booking
  union all select 'payout', count(*) from payout
  union all select 'review', count(*) from review
  order by t`;

console.log('\n[seed] done');
for (const c of counts) console.log(`  ${c.t.padEnd(16)} ${c.n}`);
console.log('\n  client login: client@gmail.com / phone 9000000001 (role=client)');

await client.end();
