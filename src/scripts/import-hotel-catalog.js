/** Real hotel references; default is a transactional dry run. See data/README.md. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { seedDatabaseUrl } from './seed-guard.js';
import { publicPhotoUrl } from '../services/domain/listing-content.js';

const LABELS = {
  swimming_pool: 'swimming pool',
  gym: 'fitness centre',
  room_service: 'room service',
  parking: 'parking',
  restaurant: 'restaurant',
  wifi: 'Wi-Fi',
  air_conditioned: 'air conditioning',
  airport_transfer: 'airport transfers',
  front_desk_24h: '24-hour front desk',
};
const OWNER_EMAIL = 'hotel-catalog-import@rentra.invalid';
export const slugifyHotel = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function validateHotelCatalog(data) {
  assert.match(data.batch, /^[a-z0-9-]+$/);
  assert.match(data.researchedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(data.provider, 'MakeMyTrip');
  assert.equal(data.cities.length, 9, 'Expected nine cities');
  const cities = new Set();
  const sources = new Set();
  const slugs = new Set();
  for (const city of data.cities) {
    assert(city.name && city.state && /^[a-z0-9-]+$/.test(city.slug));
    assert(!cities.has(city.slug), `Duplicate city: ${city.slug}`);
    cities.add(city.slug);
    assert.equal(city.hotels.length, 8, `${city.name}: expected eight hotels`);
    const names = new Set();
    for (const hotel of city.hotels) {
      assert(hotel.name?.trim().length > 2 && hotel.name.length <= 160);
      assert(hotel.area?.trim() && slugifyHotel(hotel.area));
      assert(hotel.address?.includes(city.name) && hotel.address.includes(city.state));
      assert(Number.isInteger(hotel.starRating) && hotel.starRating >= 1 && hotel.starRating <= 5);
      const source = new URL(hotel.sourceUrl);
      assert.equal(source.origin, 'https://www.makemytrip.com');
      assert.match(source.pathname, /^\/hotels\/.+-details-.+\.html$/);
      assert(!sources.has(source.href), `Duplicate source: ${source.href}`);
      sources.add(source.href);
      const name = normalize(hotel.name);
      assert(!names.has(name), `Duplicate hotel: ${hotel.name}`);
      names.add(name);
      const slug = `${slugifyHotel(hotel.name)}-${city.slug}`;
      assert(slug.length <= 200 && !slugs.has(slug));
      slugs.add(slug);
      assert(Array.isArray(hotel.amenities));
      assert.equal(new Set(hotel.amenities).size, hotel.amenities.length);
      assert(
        hotel.amenities.every((key) => Object.hasOwn(LABELS, key)),
        'Unknown amenity',
      );
      if (hotel.photos) {
        assert(Array.isArray(hotel.photos) && hotel.photos.length <= 15);
        assert(
          hotel.photos.every((photo) => publicPhotoUrl(photo)),
          'Unsupported public hotel photo',
        );
      }
    }
  }
  return { cities: cities.size, hotels: sources.size };
}

class DryRun extends Error {
  constructor(report) {
    super('Dry run rolled back');
    this.report = report;
  }
}

export async function importHotelCatalog(sql, data, { apply = false } = {}) {
  validateHotelCatalog(data);
  try {
    return await sql.begin(async (tx) => {
      // Serialise this importer so concurrent runs cannot create duplicate names.
      await tx`SELECT pg_advisory_xact_lock(hashtext('rentra-hotel-catalog-import'))`;
      const [category] =
        await tx`SELECT id FROM category WHERE slug='hotel' AND vertical_code='hotel' AND is_active`;
      assert(category, 'Active hotel category is missing; run seed:hotels first');
      const requestedAmenities = [
        ...new Set(data.cities.flatMap((c) => c.hotels.flatMap((h) => h.amenities))),
      ];
      const amenities = requestedAmenities.length
        ? await tx`SELECT a.id, a.slug FROM amenity a JOIN amenity_vertical av ON av.amenity_id=a.id
            WHERE a.slug IN ${tx(requestedAmenities)} AND a.is_active AND av.vertical_code='hotel'`
        : [];
      assert.equal(
        amenities.length,
        requestedAmenities.length,
        'Missing active hotel amenities; run seed:hotels first',
      );
      const [owner] = await tx`INSERT INTO "user" (email,role,account_status,name)
        VALUES (${OWNER_EMAIL},'client','pending_application','Unclaimed hotel catalogue references')
        ON CONFLICT (email,role) DO NOTHING RETURNING id`;
      const account =
        owner ?? (await tx`SELECT id FROM "user" WHERE email=${OWNER_EMAIL} AND role='client'`)[0];
      assert(account, 'Import account exists with an incompatible role');
      const report = {
        mode: apply ? 'applied' : 'dry-run (rolled back)',
        batch: data.batch,
        created: 0,
        skipped: 0,
        cities: [],
      };
      const importedIds = [];
      for (const city of data.cities) {
        await tx`INSERT INTO city (slug,name,state) VALUES (${city.slug},${city.name},${city.state}) ON CONFLICT (slug) DO NOTHING`;
        const [cityRow] =
          await tx`SELECT id,name,state,is_active FROM city WHERE slug=${city.slug}`;
        assert(cityRow?.is_active && cityRow.state === city.state, `City conflict: ${city.slug}`);
        const existing =
          await tx`SELECT r.id,r.title,r.slug,hp.policies->'externalCatalog'->>'sourceUrl' AS source_url
          FROM rentable r LEFT JOIN hotel_profile hp ON hp.rentable_id=r.id WHERE r.city_id=${cityRow.id}`;
        const counts = { city: city.name, created: 0, skipped: 0 };
        const areas = await tx`SELECT id,slug,name,is_active FROM area WHERE city_id=${cityRow.id}`;
        const missingAreas = [...new Set(city.hotels.map((h) => h.area))]
          .filter(
            (name) =>
              !areas.some(
                (a) => a.slug === slugifyHotel(name) || a.name.toLowerCase() === name.toLowerCase(),
              ),
          )
          .map((name) => ({ city_id: cityRow.id, slug: slugifyHotel(name), name }));
        if (missingAreas.length)
          areas.push(
            ...(await tx`INSERT INTO area ${tx(missingAreas)} RETURNING id,slug,name,is_active`),
          );
        const listings = [];
        const profiles = [];
        const amenityRows = [];
        for (const hotel of city.hotels) {
          const slug = `${slugifyHotel(hotel.name)}-${city.slug}`;
          if (
            existing.some(
              (r) =>
                r.slug === slug ||
                normalize(r.title) === normalize(hotel.name) ||
                r.source_url === hotel.sourceUrl,
            )
          ) {
            counts.skipped++;
            report.skipped++;
            continue;
          }
          const areaSlug = slugifyHotel(hotel.area);
          const area = areas.find(
            (a) => a.slug === areaSlug || a.name.toLowerCase() === hotel.area.toLowerCase(),
          );
          assert(area.is_active, `Area is archived: ${city.name}/${hotel.area}`);
          const facilities = hotel.amenities.map((key) => LABELS[key]);
          const description =
            `${hotel.name} is listed as a ${hotel.starRating}-star hotel in ${hotel.area}, ${city.name}. ` +
            `Address: ${hotel.address}. ` +
            (facilities.length
              ? `Listed facilities include ${facilities.join(', ')}; charges and access may vary. `
              : '') +
            'Confirm room options, current tariffs and stay policies with the hotel before booking.';
          const listing = {
            id: randomUUID(),
            client_id: account.id,
            slug,
            title: hotel.name,
            description,
            category_id: category.id,
            city_id: cityRow.id,
            area_id: area.id,
            public_code: randomBytes(4).toString('hex'),
            rental_unit: 'night',
            status: 'draft',
            exact_address: hotel.address,
            highlight: `${hotel.starRating}-star hotel in ${hotel.area}`,
            photos: hotel.photos ?? [],
          };
          listings.push(listing);
          const policies = {
            stayAnswered: false,
            gstAnswered: false,
            externalCatalog: {
              batch: data.batch,
              provider: data.provider,
              sourceUrl: hotel.sourceUrl,
              researchedOn: data.researchedOn,
              ownerConfirmed: false,
              inventoryConfirmed: false,
              unverifiedFields: [
                'checkIn',
                'checkOut',
                'childFreeAge',
                'weekendNights',
                'guestPolicies',
                'gst',
                'roomTypes',
                'rates',
                'inventory',
                'photos',
                'coordinates',
              ],
              notes: data.notes,
            },
          };
          // Required profile defaults are not verified hotel facts; keep the listing a draft.
          profiles.push({
            rentable_id: listing.id,
            star_rating: hotel.starRating,
            policies,
          });
          amenityRows.push(
            ...hotel.amenities.map((slug) => ({
              rentable_id: listing.id,
              amenity_id: amenities.find((a) => a.slug === slug).id,
            })),
          );
          importedIds.push(listing.id);
          counts.created++;
          report.created++;
        }
        if (listings.length) {
          await tx`INSERT INTO rentable ${tx(listings)}`;
          await tx`INSERT INTO hotel_profile ${tx(profiles)}`;
          if (amenityRows.length) await tx`INSERT INTO rentable_amenity ${tx(amenityRows)}`;
        }
        report.cities.push(counts);
      }
      assert.equal(report.created + report.skipped, 72);
      if (importedIds.length) {
        const [verified] =
          await tx`SELECT count(*)::int AS count FROM rentable r JOIN hotel_profile hp ON hp.rentable_id=r.id
          JOIN area a ON a.id=r.area_id WHERE r.id IN ${tx(importedIds)} AND r.status='draft' AND r.rental_unit='night'
          AND a.city_id=r.city_id AND hp.policies->'externalCatalog'->>'batch'=${data.batch}
          AND r.exact_address IS NOT NULL AND r.verified_at IS NULL AND r.review_count=0
          AND NOT EXISTS (SELECT 1 FROM room_type rt WHERE rt.rentable_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM rate_plan rp WHERE rp.rentable_id=r.id)`;
        assert.equal(verified.count, importedIds.length, 'Post-import integrity check failed');
      }
      if (!apply) throw new DryRun(report);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.report;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2);
  assert(
    flags.every((f) => ['--apply', '--validate'].includes(f)),
    'Use --validate, --apply, or no flag for a dry run',
  );
  assert(
    !(flags.includes('--apply') && flags.includes('--validate')),
    'Choose --validate or --apply',
  );
  const data = JSON.parse(
    await readFile(new URL('./data/india-hotel-catalog.json', import.meta.url), 'utf8'),
  );
  const totals = validateHotelCatalog(data);
  if (flags.includes('--validate')) console.log(JSON.stringify(totals, null, 2));
  else {
    const sql = postgres(seedDatabaseUrl('import-hotel-catalog'), {
      max: 1,
      prepare: false,
      connect_timeout: 15,
      onnotice: () => {},
    });
    try {
      console.log(
        JSON.stringify(
          await importHotelCatalog(sql, data, { apply: flags.includes('--apply') }),
          null,
          2,
        ),
      );
    } finally {
      await sql.end();
    }
  }
}
