import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { insertStayBooking, seedCustomer } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/** Hotel plan, Phase 3: an owner sets up a 30-room hotel through the wizard services and submits it. */
test(
  'Phase 3: hotel rooms, rates, policies, GST, completion and submission',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    t.after(() => fixture.drop());
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { saveHotelRooms, saveHotelRates, saveHotelProfile, hotelForEdit } =
      await import('@/services/booking/hotel-setup.js');
    const { submitProperty } = await import('@/services/admin/listings.js');
    const { listingCompletion } = await import('@/services/domain/listing-completion.js');
    const { quoteHotelStay, holdHotelRooms } = await import('@/services/booking/hotel-stays.js');
    const { withListingInventory } = await import('@/services/booking/inventory.js');

    const rejects = (promise, code) =>
      assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
      });
    const [owner] =
      await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${`hotelier-${randomUUID()}@fixture.invalid`},'client','active','Hotelier') RETURNING id`;
    const [city] =
      await sql`INSERT INTO city(slug,name,state) VALUES ('surat','Surat','Gujarat') RETURNING id`;
    const [area] =
      await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},'adajan','Adajan') RETURNING id`;
    const [category] =
      await sql`INSERT INTO category(slug,name,vertical_code,default_rental_unit) VALUES ('hotel','Hotel','hotel','night') RETURNING id`;
    const photos = Array.from({ length: 8 }, (_, i) => ({
      url: `/seed/hotel-${i}.jpg`,
      alt: `Photo ${i + 1}`,
      tag: i ? 'Rooms' : 'Exterior',
    }));
    const [hotel] =
      await sql`INSERT INTO rentable(client_id,slug,title,description,category_id,city_id,area_id,public_code,rental_unit,status,exact_address,photos)
    VALUES (${owner.id},'riverside-x','Riverside Residency Adajan','A 30-room hotel on the Adajan riverfront, renovated in 2024.',${category.id},${city.id},${area.id},'htl00001','night','draft',
      '12 Riverfront Road, Adajan',${JSON.stringify(photos)}::text::jsonb) RETURNING id, content_version`;
    const [amenity] =
      await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES ('wifi','practical','Wi-Fi') RETURNING id`;
    await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${amenity.id},'hotel')`;
    for (const slug of ['parking', 'lift']) {
      const [row] =
        await sql`INSERT INTO amenity(slug,group_slug,label_en) VALUES (${slug},'practical',${slug}) RETURNING id`;
      await sql`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${row.id},'hotel')`;
      await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${hotel.id},${row.id})`;
    }
    await sql`INSERT INTO rentable_amenity(rentable_id,amenity_id) VALUES (${hotel.id},${amenity.id})`;
    // Valid EWKB in the helper's text fallback (no PostGIS locally), as listing-review-fixture does.
    const point = Buffer.alloc(25);
    point.writeUInt8(1, 0);
    point.writeUInt32LE(0x20000001, 1);
    point.writeUInt32LE(4326, 5);
    point.writeDoubleLE(72.8, 9);
    point.writeDoubleLE(21.2, 17);
    const [{ udt_name: geometryType }] =
      await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
    if (geometryType === 'geometry')
      await sql`UPDATE rentable SET location=ST_SetSRID(ST_MakePoint(72.8,21.2),4326) WHERE id=${hotel.id}`;
    else await sql`UPDATE rentable SET location=${point.toString('hex')} WHERE id=${hotel.id}`;
    const version = async () =>
      (await sql`SELECT content_version FROM rentable WHERE id=${hotel.id}`)[0].content_version;
    const room = (name, roomCount, extra = {}) => ({
      name,
      beds: [{ type: 'king', count: 1 }],
      extraPlaces: [{ type: 'extra_bed', count: 1 }],
      sizeSqm: 24,
      view: 'city',
      maxAdults: 3,
      maxChildren: 2,
      maxOccupancy: 4,
      baseOccupancy: 2,
      roomCount,
      extraAdult: 700,
      extraChild: 400,
      amenities: ['ac', 'tv'],
      sortOrder: 10,
      isActive: true,
      ...extra,
    });

    let rooms;
    await t.test('room types: validation, version guard, save', async () => {
      await rejects(
        saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: [],
        }),
        'VALIDATION_FAILED',
      );
      await rejects(
        saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: [room('Deluxe', 12, { maxAdults: 5 })],
        }),
        'VALIDATION_FAILED',
      );
      await rejects(
        saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: 1,
          rooms: [room('Deluxe', 12)],
        }),
        'LISTING_CHANGED',
      );
      const saved = await saveHotelRooms(sql, owner.id, {
        rentableId: hotel.id,
        expectedVersion: await version(),
        rooms: [
          room('Deluxe Double', 12),
          room('Standard Twin', 14, {
            beds: [{ type: 'single', count: 2 }],
            maxAdults: 2,
            maxOccupancy: 3,
            sortOrder: 20,
          }),
          room('Family Suite', 4, {
            maxAdults: 4,
            maxOccupancy: 5,
            sortOrder: 30,
            extraPlaces: [{ type: 'extra_bed', count: 2 }],
          }),
        ],
      });
      assert.equal(saved.roomTypeIds.length, 3);
      rooms = (await hotelForEdit(sql, hotel.id)).hotel.roomTypes;
      assert.deepEqual(
        rooms.map((r) => [r.name, r.roomCount, r.extraAdult]),
        [
          ['Deluxe Double', 12, 700],
          ['Standard Twin', 14, 700],
          ['Family Suite', 4, 700],
        ],
      );
      assert.equal(
        (await sql`SELECT capacity FROM rentable WHERE id=${hotel.id}`)[0].capacity,
        5,
        'capacity = largest room',
      );
    });

    await t.test('rate plans: base and derived by key, refusals', async () => {
      const [deluxe, standard, family] = rooms;
      const plans = [
        {
          key: 'd-base',
          roomTypeId: deluxe.id,
          name: 'Room only',
          weekday: 2600,
          weekend: 3000,
          cancellation: 'flexible',
          sortOrder: 0,
        },
        {
          key: 'd-bf',
          roomTypeId: deluxe.id,
          name: 'Breakfast included',
          mealPlan: 'CP',
          derivedFrom: 'd-base',
          perGuest: 250,
          cancellation: 'flexible',
          sortOrder: 1,
        },
        {
          key: 'd-nr',
          roomTypeId: deluxe.id,
          name: 'Non-refundable',
          derivedFrom: 'd-base',
          adjustPct: -10,
          cancellation: 'non_refundable',
          sortOrder: 2,
        },
        {
          key: 's-base',
          roomTypeId: standard.id,
          name: 'Room only',
          weekday: 2000,
          weekend: 2300,
          cancellation: 'moderate',
          sortOrder: 0,
        },
        {
          key: 'f-base',
          roomTypeId: family.id,
          name: 'Room only',
          weekday: 4200,
          weekend: 4800,
          cancellation: 'strict',
          sortOrder: 0,
        },
      ];
      await rejects(
        saveHotelRates(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          plans: [{ ...plans[1], derivedFrom: 's-base' }, plans[3]],
        }),
        'VALIDATION_FAILED',
      );
      await rejects(
        saveHotelRates(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          plans: [{ ...plans[0], weekday: 100 }],
        }),
        'VALIDATION_FAILED',
      );
      const saved = await saveHotelRates(sql, owner.id, {
        rentableId: hotel.id,
        expectedVersion: await version(),
        plans,
      });
      assert.equal(Object.keys(saved.ratePlanIds).length, 5);
      const edit = (await hotelForEdit(sql, hotel.id)).hotel.ratePlans;
      const breakfast = edit.find((p) => p.name === 'Breakfast included');
      assert.equal(breakfast.derivedFrom, saved.ratePlanIds['d-base']);
      assert.deepEqual([breakfast.perGuest, breakfast.cancellation], [250, 'flexible']);
      assert.deepEqual(
        edit.find((p) => p.name === 'Non-refundable') && [
          edit.find((p) => p.name === 'Non-refundable').adjustPct,
          edit.find((p) => p.name === 'Non-refundable').cancellation,
        ],
        [-10, 'non_refundable'],
      );
      await rejects(
        saveHotelRates(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          plans: edit
            .map((p) =>
              p.id === breakfast.id ? { ...p, derivedFrom: null, weekday: 3000, weekend: 3000 } : p,
            )
            .map(
              ({
                id,
                roomTypeId,
                name,
                mealPlan,
                derivedFrom,
                weekday,
                weekend,
                adjustPct,
                perGuest,
                cancellation,
                minNights,
                sortOrder,
                isActive,
              }) => ({
                id,
                roomTypeId,
                name,
                mealPlan,
                derivedFrom,
                weekday,
                weekend,
                adjustPct,
                perGuest,
                cancellation,
                minNights,
                sortOrder,
                isActive,
              }),
            ),
        }),
        'VALIDATION_FAILED',
      );
    });

    await t.test('stay, rules and GST answers', async () => {
      const save = async (part, values) =>
        saveHotelProfile(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          part,
          values,
        });
      await rejects(
        saveHotelProfile(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: 0,
          part: 'stay',
          values: {},
        }),
        'VALIDATION_FAILED',
      );
      await save('stay', {
        checkInTime: '12:00',
        checkOutTime: '11:00',
        childFreeAge: '6',
        weekendNights: ['5', '6'],
        starRating: '3',
      });
      await rejects(
        saveHotelProfile(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          part: 'rules',
          values: { couples: 'yes', localId: 'yes', idTypes: [] },
        }),
        'VALIDATION_FAILED',
      );
      await save('rules', {
        couples: 'yes',
        localId: 'yes',
        idTypes: ['aadhaar', 'passport'],
        pets: 'no',
        smoking: 'no',
        parties: 'no',
        extraRules: '',
      });
      await rejects(
        saveHotelProfile(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          part: 'gst',
          values: { gstRegistered: 'yes', gstin: 'ABC' },
        }),
        'VALIDATION_FAILED',
      );
      await save('gst', { gstRegistered: 'yes', gstin: '24abcde1234f1z5' });
      const { profile } = (await hotelForEdit(sql, hotel.id)).hotel;
      assert.deepEqual(
        [
          profile.checkInMinute,
          profile.checkOutMinute,
          profile.childFreeAge,
          profile.weekendNights,
          profile.starRating,
          profile.gstin,
        ],
        [720, 660, 6, [5, 6], 3, '24ABCDE1234F1Z5'],
      );
      assert.equal(profile.policies.couples, true);

      // Story 3.6: explicit child bands; a gap is refused by name and nothing changes.
      const bands = [
        { kind: 'infant', fromAge: 0, toAge: 1, rule: { type: 'free', amount: 0 } },
        { kind: 'child', fromAge: 2, toAge: 11, rule: { type: 'fixed', amount: 500 } },
      ];
      const stay = {
        checkInTime: '12:00',
        checkOutTime: '11:00',
        weekendNights: ['5', '6'],
        starRating: '3',
      };
      const failed = await saveHotelProfile(sql, owner.id, {
        rentableId: hotel.id,
        expectedVersion: await version(),
        part: 'stay',
        values: {
          ...stay,
          childPolicy: { adultRateFromAge: 12, bands: [bands[0], { ...bands[1], fromAge: 3 }] },
        },
      }).catch((error) => error);
      assert.equal(failed.code, 'VALIDATION_FAILED');
      assert.deepEqual(failed.fields['childPolicy.bands'], ['Age 2 is not covered']);
      await rejects(
        saveHotelProfile(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          part: 'stay',
          values: {
            ...stay,
            childPolicy: {
              adultRateFromAge: 12,
              // Story 3.7: percent is for child bands only; an infant band with percent is refused.
              bands: [{ ...bands[0], rule: { type: 'percent', amount: 25 } }, bands[1]],
            },
          },
        }),
        'VALIDATION_FAILED',
      );
      const v1 = (await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicyVersion;
      await save('stay', { ...stay, childPolicy: { adultRateFromAge: 12, bands } });
      const after = (await hotelForEdit(sql, hotel.id)).hotel.profile;
      assert.deepEqual(after.childPolicy, { adultRateFromAge: 12, bands });
      assert.equal(after.childPolicyVersion, v1 + 1);
      assert.equal(after.childFreeAge, 6, 'an omitted child age keeps the saved one');
      await save('stay', { ...stay, childPolicy: { adultRateFromAge: 12, bands } });
      assert.equal(
        (await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicyVersion,
        v1 + 1,
        'unchanged policy keeps its version',
      );
      await save('stay', { ...stay, childPolicy: null });
      assert.equal((await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicy, null);

      // Room override and cots save, read back and bump the version.
      const roomsNow = (await hotelForEdit(sql, hotel.id)).hotel.roomTypes.map(
        ({ upcomingRooms: _u, ...row }) => row,
      );
      const target = roomsNow.find((row) => row.isActive);
      await saveHotelRooms(sql, owner.id, {
        rentableId: hotel.id,
        expectedVersion: await version(),
        rooms: roomsNow.map((row) =>
          row.id === target.id
            ? {
                ...row,
                childPolicy: { adultRateFromAge: 12, bands },
                cots: { count: 1, amount: 300 },
              }
            : row,
        ),
      });
      const edited = (await hotelForEdit(sql, hotel.id)).hotel;
      const savedRoom = edited.roomTypes.find((row) => row.id === target.id);
      assert.deepEqual(savedRoom.childPolicy, { adultRateFromAge: 12, bands });
      assert.deepEqual(savedRoom.cots, { count: 1, amount: 300 });
      assert.equal(edited.profile.childPolicyVersion, v1 + 3);
      const [logged] =
        await sql`SELECT count(*)::int n FROM audit_log WHERE entity_id=${hotel.id} AND action='hotel_rooms_changed'
        AND "after"::text LIKE '%"cots": {"count": 1, "amount": 300}%'`;
      assert.equal(logged.n, 1, 'audited');

      // Re-saving the same rooms, or changing only a removed room, keeps the version.
      const same = edited.roomTypes.map(({ upcomingRooms: _u, ...row }) => row);
      await saveHotelRooms(sql, owner.id, {
        rentableId: hotel.id,
        expectedVersion: await version(),
        rooms: same,
      });
      assert.equal(
        (await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicyVersion,
        v1 + 3,
        'no real change, no new version',
      );
      // With no property policy, the fallback's extra child price is part of the terms.
      const other = same.find((row) => row.isActive && row.id !== target.id);
      if (other) {
        await saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: same.map((row) =>
            row.id === other.id ? { ...row, extraChild: row.extraChild + 1 } : row,
          ),
        });
        assert.equal((await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicyVersion, v1 + 4);
      }
      // A free-age change does not bump while a property policy is saved.
      await save('stay', { ...stay, childPolicy: { adultRateFromAge: 12, bands } });
      const withPolicy = (await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicyVersion;
      await save('stay', { ...stay, childFreeAge: '3' });
      assert.equal(
        (await hotelForEdit(sql, hotel.id)).hotel.profile.childPolicyVersion,
        withPolicy,
      );
      await save('stay', { ...stay, childFreeAge: '6', childPolicy: null });
      await saveHotelRooms(sql, owner.id, {
        rentableId: hotel.id,
        expectedVersion: await version(),
        rooms: edited.roomTypes.map(({ upcomingRooms: _u, ...row }) =>
          row.id === target.id ? { ...row, childPolicy: null, cots: { count: 0, amount: 0 } } : row,
        ),
      });
    });

    await t.test('completion: everything but proof, then submit', async () => {
      await sql`UPDATE vertical SET status='partners' WHERE code='hotel'`;
      const completion = async () => {
        const [row] = await sql`SELECT * FROM rentable WHERE id=${hotel.id}`;
        const camel = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
            v,
          ]),
        );
        return listingCompletion(camel, {
          ...(await hotelForEdit(sql, hotel.id)),
          photos: row.photos,
          amenities: [1, 2, 3],
          documents: await sql`SELECT status FROM document WHERE owner_id=${hotel.id}`,
        });
      };
      const before = await completion();
      assert.deepEqual(
        before.remaining.map((s) => s.id),
        ['ownership'],
      );
      await sql`INSERT INTO document(owner_type,owner_id,doc_type,storage_key,status) VALUES ('rentable',${hotel.id},'rent_agreement','fixture/hotel-lease','uploaded')`;
      assert.equal((await completion()).canSubmit, true);
      await sql`UPDATE vertical SET status='hidden' WHERE code='hotel'`;
      await rejects(submitProperty(sql, { id: hotel.id, clientId: owner.id }), 'VERTICAL_CLOSED');
      await sql`UPDATE vertical SET status='partners' WHERE code='hotel'`;
      const submitted = await submitProperty(sql, { id: hotel.id, clientId: owner.id });
      const [snapshot] =
        await sql`SELECT snapshot FROM listing_submission WHERE id=${submitted.submissionId}`;
      assert.equal(snapshot.snapshot.hotel.roomTypes.length, 3);
      assert.equal(snapshot.snapshot.hotel.ratePlans.length, 5);
    });

    await t.test(
      'rooms booked ahead protect their room type; live facts go back to review',
      async () => {
        await sql`UPDATE rentable SET status='live' WHERE id=${hotel.id}`;
        const checkIn = addLocalDays(propertyToday(), 12);
        const checkOut = addLocalDays(checkIn, 1);
        const [deluxe] = rooms;
        const plan = (await hotelForEdit(sql, hotel.id)).hotel.ratePlans.find(
          (p) => p.roomTypeId === deluxe.id && !p.derivedFrom,
        );
        const quote = await quoteHotelStay(sql, {
          rentableId: hotel.id,
          checkIn,
          checkOut,
          rooms: [
            { roomTypeId: deluxe.id, ratePlanId: plan.id, adults: 2 },
            { roomTypeId: deluxe.id, ratePlanId: plan.id, adults: 2 },
          ],
        });
        assert.equal(quote.lines[0].nights[0].taxBps, 500);
        const guest = await seedCustomer(sql);
        await withListingInventory(sql, hotel.id, async (tx, listing) => {
          const ids = await insertStayBooking(tx, {
            customerId: guest,
            rentableId: hotel.id,
            quote,
          });
          await holdHotelRooms(tx, listing, { bookingId: ids.bookingId, quote });
        });
        const current = (await hotelForEdit(sql, hotel.id)).hotel.roomTypes;
        assert.equal(current[0].upcomingRooms, 2);
        const payload = (patch) =>
          current.map(
            ({
              id,
              name,
              beds,
              sizeSqm,
              view,
              maxAdults,
              maxChildren,
              maxOccupancy,
              baseOccupancy,
              roomCount,
              extraAdult,
              extraChild,
              amenities,
              extraPlaces,
              sortOrder,
              isActive,
            }) => ({
              id,
              name,
              beds,
              sizeSqm,
              view,
              maxAdults,
              maxChildren,
              maxOccupancy,
              baseOccupancy,
              roomCount,
              extraAdult,
              extraChild,
              amenities,
              extraPlaces,
              sortOrder,
              isActive,
              ...(patch[id] ?? {}),
            }),
          );
        await rejects(
          saveHotelRooms(sql, owner.id, {
            rentableId: hotel.id,
            expectedVersion: await version(),
            rooms: payload({ [deluxe.id]: { isActive: false } }),
          }),
          'ROOM_HAS_BOOKINGS',
        );
        await rejects(
          saveHotelRooms(sql, owner.id, {
            rentableId: hotel.id,
            expectedVersion: await version(),
            rooms: payload({ [deluxe.id]: { roomCount: 1 } }),
          }),
          'ROOMS_BELOW_BOOKINGS',
        );
        const count = await saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: payload({ [deluxe.id]: { roomCount: 10 } }),
        });
        assert.equal(count.sentBack, false, 'selling fewer rooms is not a change of facts');
        const facts = await saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: payload({ [deluxe.id]: { roomCount: 10, maxOccupancy: 3, maxAdults: 3 } }),
        });
        assert.equal(facts.sentBack, true);
        assert.equal(
          (await sql`SELECT status FROM rentable WHERE id=${hotel.id}`)[0].status,
          'pending_review',
        );
      },
    );

    await t.test(
      'Story 3.3: sleeping places, warnings, meal inclusions and the booked snapshot',
      async () => {
        const edit = async () => (await hotelForEdit(sql, hotel.id)).hotel;
        const current = (await edit()).roomTypes;
        const [deluxe] = current;
        const strip = ({ upcomingRooms: _u, ...row }) => row;
        const payload = (patch) =>
          current.map((row) => ({ ...strip(row), ...(row.id === deluxe.id ? patch : {}) }));
        // 1 double, 3 adults, no extra place: refused with the shortfall, nothing saved.
        const before = await version();
        await assert.rejects(
          saveHotelRooms(sql, owner.id, {
            rentableId: hotel.id,
            expectedVersion: before,
            rooms: payload({
              name: 'Deluxe X',
              beds: [{ type: 'double', count: 1 }],
              extraPlaces: [],
              maxAdults: 3,
            }),
          }),
          (error) => {
            assert.equal(error.code, 'VALIDATION_FAILED');
            assert.match(
              JSON.stringify(error.details ?? error.fields ?? error),
              /Deluxe X: 1 double bed sleeps 2; add a sleeping place or lower max adults to 2/,
            );
            return true;
          },
        );
        assert.equal(await version(), before);
        assert.equal(
          (await sql`SELECT name FROM room_type WHERE id=${deluxe.id}`)[0].name,
          deluxe.name,
        );
        // Existing non-compliant room: flagged, still quotable, next save refused until fixed.
        await sql`UPDATE room_type SET beds='[{"type":"king","count":1}]', extra_places='[]', max_adults=3 WHERE id=${deluxe.id}`;
        const flagged = await edit();
        assert.deepEqual(
          flagged.capacityWarnings.map((w) => w.roomTypeId),
          [deluxe.id],
        );
        assert.match(
          flagged.capacityWarnings[0].message,
          /add a sleeping place or lower max adults to 2/,
        );
        const plan = flagged.ratePlans.find(
          (p) => p.roomTypeId === deluxe.id && !p.derivedFrom && p.isActive,
        );
        await sql`UPDATE rentable SET status='live' WHERE id=${hotel.id}`;
        const checkIn = addLocalDays(propertyToday(), 20);
        const quoteFor = (adults) =>
          quoteHotelStay(sql, {
            rentableId: hotel.id,
            checkIn,
            checkOut: addLocalDays(checkIn, 1),
            rooms: [{ roomTypeId: deluxe.id, ratePlanId: plan.id, adults }],
          });
        assert.equal((await quoteFor(2)).lines.length, 1, 'still bookable');
        // Story 3.4: the third adult has no sleeping place, so that quote is refused.
        await rejects(quoteFor(3), 'BEDDING_UNAVAILABLE');
        const fresh = flagged.roomTypes.map(strip);
        await rejects(
          saveHotelRooms(sql, owner.id, {
            rentableId: hotel.id,
            expectedVersion: await version(),
            rooms: fresh,
          }),
          'VALIDATION_FAILED',
        );
        const audits = async () =>
          (
            await sql`SELECT count(*)::int n FROM audit_log WHERE entity_id=${hotel.id} AND action='hotel_rooms_changed'`
          )[0].n;
        const auditsBefore = await audits();
        const added = await saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: fresh.map((row) =>
            row.id === deluxe.id
              ? {
                  ...row,
                  extraPlaces: [
                    { type: 'extra_bed', count: 1, charge: { mode: 'percent', amount: 10 } },
                  ],
                  extraAdultIncludesBedding: true,
                }
              : row,
          ),
        });
        const readBack = await edit();
        assert.deepEqual(readBack.capacityWarnings, []);
        // Story 3.4: bedding charge and the includes-bedding box save and read back (audit only, no review).
        const savedDeluxe = readBack.roomTypes.find((row) => row.id === deluxe.id);
        assert.deepEqual(savedDeluxe.extraPlaces, [
          { type: 'extra_bed', count: 1, charge: { mode: 'percent', amount: 10 } },
        ]);
        assert.equal(savedDeluxe.extraAdultIncludesBedding, true);
        await rejects(
          saveHotelRooms(sql, owner.id, {
            rentableId: hotel.id,
            expectedVersion: await version(),
            rooms: readBack.roomTypes.map(strip).map((row) =>
              row.id === deluxe.id
                ? {
                    ...row,
                    extraPlaces: [
                      { type: 'extra_bed', count: 1, charge: { mode: 'percent', amount: 101 } },
                    ],
                  }
                : row,
            ),
          }),
          'VALIDATION_FAILED',
        );
        // Owner decision: extra sleeping places on a live hotel do not send it back to review, but are audited.
        assert.equal(added.sentBack, false);
        assert.equal(
          (await sql`SELECT status FROM rentable WHERE id=${hotel.id}`)[0].status,
          'live',
        );
        assert.equal(await audits(), auditsBefore + 1);
        const [audit] =
          await sql`SELECT "after" FROM audit_log WHERE entity_id=${hotel.id} AND action='hotel_rooms_changed' ORDER BY "at" DESC LIMIT 1`;
        assert.deepEqual(audit.after.rooms.find((row) => row.id === deluxe.id).extraPlaces, [
          { type: 'extra_bed', count: 1, charge: { mode: 'percent', amount: 10 } },
        ]);
        // A removed (inactive) room that would break the rule does not block the save.
        const raw = (await edit()).roomTypes;
        const spare = raw.find((row) => row.id !== deluxe.id && row.isActive && !row.upcomingRooms);
        const withRemoved = raw.map(strip);
        await saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: withRemoved.map((row) =>
            row.id === spare.id
              ? { ...row, isActive: false, extraPlaces: [], maxAdults: 6, maxOccupancy: 8 }
              : row,
          ),
        });
        await sql`UPDATE rentable SET status='live' WHERE id=${hotel.id}`;

        // Booked rooms keep their promises after the owner renames and re-beds the room.
        const [booked] =
          await sql`SELECT id, room_snapshot FROM booking_room WHERE room_type_id=${deluxe.id} LIMIT 1`;
        assert.equal(booked.room_snapshot.name, 'Deluxe Double');
        assert.deepEqual(booked.room_snapshot.beds, [{ type: 'king', count: 1 }]);
        assert.deepEqual(booked.room_snapshot.extraPlaces, [{ type: 'extra_bed', count: 1 }]);
        assert.deepEqual(booked.room_snapshot.amenities, ['ac', 'tv']);
        assert.deepEqual(booked.room_snapshot.inclusions, {
          breakfast: false,
          lunch: false,
          dinner: false,
        });
        const renamed = (await edit()).roomTypes
          .map(strip)
          .map((row) =>
            row.id === deluxe.id
              ? { ...row, name: 'Premier', beds: [{ type: 'single', count: 3 }], extraPlaces: [] }
              : row,
          );
        await saveHotelRooms(sql, owner.id, {
          rentableId: hotel.id,
          expectedVersion: await version(),
          rooms: renamed,
        });
        const [shown] =
          await sql`SELECT coalesce(br.room_snapshot->>'name', t.name) AS name, br.room_snapshot->'beds' AS beds
        FROM booking_room br JOIN room_type t ON t.id=br.room_type_id WHERE br.id=${booked.id}`;
        assert.deepEqual(shown, { name: 'Deluxe Double', beds: [{ type: 'king', count: 1 }] });
        await sql`UPDATE booking_room SET room_snapshot=NULL WHERE id=${booked.id}`;
        const [old] =
          await sql`SELECT coalesce(br.room_snapshot->>'name', t.name) AS name FROM booking_room br JOIN room_type t ON t.id=br.room_type_id WHERE br.id=${booked.id}`;
        assert.equal(old.name, 'Premier', 'old rows fall back to live values');

        // Meal inclusions: CP default, MP needs its second meal, AP cannot drop dinner.
        const base = { roomTypeId: deluxe.id, weekday: 2600, weekend: 3000, sortOrder: 0 };
        const rv = async (row) =>
          saveHotelRates(sql, owner.id, {
            rentableId: hotel.id,
            expectedVersion: await version(),
            plans: [{ id: plan.id, ...base, name: 'Plan', ...row }],
          });
        await rejects(rv({ mealPlan: 'MP' }), 'VALIDATION_FAILED');
        await rejects(
          rv({ mealPlan: 'AP', inclusions: { breakfast: true, lunch: true, dinner: false } }),
          'VALIDATION_FAILED',
        );
        await rejects(
          rv({ mealPlan: 'CP', inclusions: { breakfast: false, lunch: true, dinner: false } }),
          'VALIDATION_FAILED',
        );
        await rv({ mealPlan: 'CP' });
        let saved = (await edit()).ratePlans.find((p) => p.id === plan.id);
        assert.equal(saved.inclusions, null, 'CP without override keeps the code default');
        await rv({ mealPlan: 'MP', inclusions: { breakfast: true, lunch: false, dinner: true } });
        saved = (await edit()).ratePlans.find((p) => p.id === plan.id);
        assert.deepEqual(saved.inclusions, { breakfast: true, lunch: false, dinner: true });
      },
    );
  },
);
