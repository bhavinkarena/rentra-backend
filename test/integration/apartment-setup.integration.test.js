import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedHotel } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { parseDiscoveryQuery } from '../../src/services/domain/discovery.js';
import { pointHex } from '../../src/services/domain/geo.js';

/** Story 3.10: an owner sets up and submits a whole apartment; guests never see it before Story 3.11. */
test(
  'Story 3.10: whole-apartment setup, review and guest gate',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    t.after(() => fixture.drop());
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { saveApartment, apartmentForEdit } =
      await import('@/services/booking/apartment-setup.js');
    const { submitProperty, readPropertyReview } = await import('@/services/admin/listings.js');
    const { getListingByCode } = await import('@/services/db/queries.js');
    const { searchDiscovery, clearDiscoveryRegistryCache, getDiscoveryRegistry } =
      await import('@/services/db/discovery.js');
    const { savedPlaceCards } = await import('@/services/customer/saved.js');
    const { previewBookingQuote } = await import('@/services/booking/quotes.js');
    const { listingCompletion } = await import('@/services/domain/listing-completion.js');

    const rejects = (promise, code) =>
      assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
      });
    const field = (promise, pattern) =>
      assert.rejects(promise, (error) => {
        assert.equal(error.statusCode, 422);
        assert.match(Object.values(error.fields).flat().join(' '), pattern);
        return true;
      });

    const hotel = await seedHotel(sql);
    await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
    // The category migrate.js seeds after 0088 commits; seeding twice is harmless.
    const { seedApartmentCategory } = await import('../../src/scripts/apartment-category.js');
    await seedApartmentCategory(sql);
    await seedApartmentCategory(sql);
    const categories =
      await sql`SELECT id, default_rental_unit::text AS unit, vertical_code FROM category WHERE slug='whole-apartment'`;
    assert.deepEqual(
      categories.map((c) => [c.unit, c.vertical_code]),
      [['unit_night', 'hotel']],
    );
    const [category] = categories;
    const photos = Array.from({ length: 8 }, (_, i) => ({
      url: `/seed/apt-${i}.jpg`,
      alt: `Photo ${i + 1}`,
    }));
    const [apt] =
      await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,rental_unit,status,exact_address,photos,
      location,check_in_from,check_out_by,house_rules,cancellation_tier,deposit_minor)
    VALUES (${hotel.owner},'skyline-apt','Skyline two-bedroom apartment','A bright two-bedroom apartment with a balcony over the river.',${category.id},${hotel.city},${hotel.area},
      'apt00001','unit_night','draft','4 River View, Adajan',${JSON.stringify(photos)}::text::jsonb,
      ${pointHex({ latitude: 21.19, longitude: 72.83 })},NULL,NULL,'{"cancellationConfirmed":true}'::jsonb,'moderate',0) RETURNING id, rental_unit::text AS unit`;
    assert.equal(apt.unit, 'unit_night');
    const version = async () =>
      (await sql`SELECT content_version FROM rentable WHERE id=${apt.id}`)[0].content_version;
    const save = async (part, values, extra = {}) =>
      saveApartment(sql, hotel.owner, {
        rentableId: apt.id,
        expectedVersion: await version(),
        part,
        values,
        ...extra,
      });
    const unit = {
      bedrooms: 2,
      bathrooms: 2,
      beds: [
        { type: 'double', count: 1 },
        { type: 'single', count: 2 },
      ],
      maxAdults: 4,
      maxChildren: 2,
      maxOccupants: 5,
    };
    const stay = {
      minNights: 1,
      maxNights: 30,
      arrivalRules: {
        weekdays: { sat: 2 },
        ranges: [{ from: '2026-12-24', to: '2027-01-01', minNights: 3 }],
      },
      checkInTime: '14:00',
      checkOutTime: '11:00',
      turnoverNights: 1,
    };

    await t.test('validation: sleeping places, nights, times', async () => {
      await field(
        save('unit', {
          ...unit,
          beds: [{ type: 'double', count: 1 }],
          maxAdults: 3,
          maxOccupants: 3,
        }),
        /beds sleep 2/,
      );
      await field(save('unit', { ...unit, maxOccupants: 3 }), /occupants cannot be fewer/);
      await field(
        save('stay', { ...stay, minNights: 5, maxNights: 3 }),
        /Minimum nights cannot be more/,
      );
      await field(save('stay', { ...stay, maxNights: 91 }), /from 1 to 90/);
      await field(
        save('stay', { ...stay, arrivalRules: { weekdays: { sat: 40 } } }),
        /from 1 to 30/,
      );
      await field(save('stay', { ...stay, checkOutTime: '15:00' }), /before check-in/);
      await field(
        save('price', { weekday: 3000, weekend: 3500, cleaningFee: 50001 }),
        /Cleaning fee/,
      );
    });

    await t.test(
      'saves each part with a version and an audit; stale saves are refused',
      async () => {
        const first = await save('unit', unit);
        assert.equal(first.changed, true);
        assert.equal(first.apartmentVersion, 2);
        const kept = await version();
        const again = await save('unit', unit);
        assert.equal(again.changed, false);
        assert.equal(again.contentVersion, kept, 'an unchanged save keeps the content version');
        assert.equal(again.apartmentVersion, 2);
        const saturday = await save('stay', {
          ...stay,
          minNights: 1,
          maxNights: 30,
          arrivalRules: { weekdays: { sat: 2 } },
        });
        assert.equal(saturday.changed, true);
        await save('stay', stay);
        const price = await save('price', { weekday: 3000, weekend: 3600, cleaningFee: 0 });
        assert.equal(price.ok, true);
        await rejects(
          saveApartment(sql, hotel.owner, {
            rentableId: apt.id,
            expectedVersion: 1,
            part: 'price',
            values: { weekday: 1, weekend: 1 },
          }),
          'LISTING_CHANGED',
        );
        const { apartment } = await apartmentForEdit(sql, apt.id);
        assert.equal(apartment.cleaningFee, 0);
        assert.equal(apartment.weekday, 3000);
        assert.equal(apartment.turnoverNights, 1);
        assert.deepEqual(apartment.arrivalRules, stay.arrivalRules);
        const [listing] =
          await sql`SELECT capacity, bedrooms, check_in_from, check_out_by FROM rentable WHERE id=${apt.id}`;
        assert.deepEqual(
          [listing.capacity, listing.bedrooms, listing.check_in_from, listing.check_out_by],
          [5, 2, '14:00', '11:00'],
        );
        const audits =
          await sql`SELECT action FROM audit_log WHERE entity_id=${apt.id} ORDER BY id`;
        assert.deepEqual([...new Set(audits.map((a) => a.action))].sort(), [
          'apartment_price_changed',
          'apartment_stay_changed',
          'apartment_unit_changed',
        ]);
      },
    );

    await t.test('slot calendars refuse apartments', async () => {
      const { saveBookingConfiguration } = await import('@/services/booking/owner-settings.js');
      const [row] = await sql`SELECT booking_config_version FROM rentable WHERE id=${apt.id}`;
      await rejects(
        saveBookingConfiguration(sql, hotel.owner, {
          rentableId: apt.id,
          expectedVersion: row.booking_config_version,
          configuration: {},
        }),
        'UNSUPPORTED_INVENTORY',
      );
    });

    await t.test('other owners and hotels are refused', async () => {
      const [other] =
        await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${`other-${randomUUID()}@fixture.invalid`},'client','active','Other') RETURNING id`;
      await rejects(
        saveApartment(sql, other.id, {
          rentableId: apt.id,
          expectedVersion: await version(),
          part: 'unit',
          values: unit,
        }),
        'NOT_FOUND',
      );
      const [h] = await sql`SELECT content_version FROM rentable WHERE id=${hotel.hotel}`;
      await rejects(
        saveApartment(sql, hotel.owner, {
          rentableId: hotel.hotel,
          expectedVersion: h.content_version,
          part: 'unit',
          values: unit,
        }),
        'UNSUPPORTED_INVENTORY',
      );
    });

    await t.test('completion, submit and admin read', async () => {
      const [row] = await sql`SELECT * FROM rentable WHERE id=${apt.id}`;
      const camel = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]),
      );
      const completion = listingCompletion(
        { ...camel, depositAmount: 0 },
        {
          ...(await apartmentForEdit(sql, apt.id)),
          photos: row.photos,
          amenities: [1, 2, 3],
          documents: [],
        },
      );
      assert.deepEqual(
        completion.remaining.map((s) => s.id),
        ['ownership'],
      );
      assert.deepEqual(
        completion.sections.map((s) => s.id),
        [
          'type',
          'location',
          'space',
          'amenities',
          'photos',
          'story',
          'pricing',
          'availability',
          'rules',
          'ownership',
        ],
      );
      for (const slug of ['wifi', 'ac', 'kitchen']) {
        const [a] =
          await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES (${`${slug}-apt`},'practical',${slug}) RETURNING id`;
        await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${a.id},'hotel')`;
        await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${apt.id},${a.id})`;
      }
      await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status) VALUES ('rentable',${apt.id},'property_tax','fixture/apt-tax','uploaded')`;
      const submitted = await submitProperty(sql, { id: apt.id, clientId: hotel.owner });
      const [snapshot] =
        await sql`SELECT snapshot FROM listing_submission WHERE id=${submitted.submissionId}`;
      assert.equal(snapshot.snapshot.apartment.maxOccupants, 5);
      const review = await readPropertyReview(sql, apt.id);
      assert.equal(review.current.snapshot.apartment.cleaningFee, 0);
      assert.ok(review.checklist.some((c) => c.key === 'unitMatches'));
    });

    // Story 3.11 lifted the 3.10 guest gate: an approved apartment is a guest-facing stay (see apartment-booking).
    await t.test('an approved apartment is on guest surfaces and refuses slot quotes', async () => {
      await sql`UPDATE rentable SET status='live' WHERE id=${apt.id}`;
      clearDiscoveryRegistryCache(sql);
      const registry = await getDiscoveryRegistry(sql);
      assert.ok(registry.categories.some((c) => c.slug === 'whole-apartment'));
      const { filters } = parseDiscoveryQuery({ vertical: 'hotel', city: 'surat' });
      const result = await searchDiscovery(filters, null, sql);
      assert.ok(
        result.items.some((item) => item.id === hotel.hotel),
        'hotels unchanged',
      );
      assert.ok(await getListingByCode('apt00001'));
      const [card] = await savedPlaceCards(sql, [{ rentableId: apt.id, selection: null }]);
      assert.equal(card.available, true);
      const day = addLocalDays(propertyToday(), 5);
      await rejects(
        previewBookingQuote(sql, { rentableId: apt.id, dates: [day], slot: 'day', guests: 2 }),
        'LISTING_UNAVAILABLE',
      );
    });
  },
);
