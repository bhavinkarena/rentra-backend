import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedHotel } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/**
 * Hotel plan, Phase 9 security review (§8.9 AuthZ): every hotel owner, staff and
 * admin service refuses another tenant. Owner B never reads or changes owner A's hotel.
 */
test(
  'Phase 9: hotel cross-tenant access is refused',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    t.after(() => fixture.drop());
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { hotelAriGrid, changeHotelAri } = await import('@/services/booking/hotel-ari.js');
    const { saveHotelRooms, saveHotelProfile } = await import('@/services/booking/hotel-setup.js');
    const payouts = await import('@/services/finance/hotel-payouts.js');
    const { getOwnerHotelAnalytics, getAdminHotelAnalytics } =
      await import('@/services/analytics/hotel-analytics.js');
    const { listBetaGuests, betaGuestCommand } =
      await import('@/services/catalogues/beta-guests.js');
    const { listLandmarks, landmarkCommand } = await import('@/services/catalogues/landmarks.js');

    const a = await seedHotel(sql);
    const b = await seedHotel(sql);
    const [{ version }] =
      await sql`SELECT content_version AS version FROM rentable WHERE id=${a.hotel}`;
    const ownerB = { kind: 'owner', id: b.owner };
    const refused = (promise) =>
      assert.rejects(
        promise,
        (error) =>
          [401, 403, 404].includes(error.statusCode ?? error.status) ||
          ['FORBIDDEN', 'NOT_FOUND', 'ROLE_FORBIDDEN', 'LISTING_NOT_FOUND'].includes(error.code) ||
          /not found|forbidden/i.test(error.message),
      );
    // Staff of owner B, even a manager, has no access to A.
    const [staff] =
      await sql`INSERT INTO client_staff(client_id,phone,name,permissions) VALUES (${b.owner},'9811100001','Front','{"hotelRole":"manager"}') RETURNING id`;
    await sql`INSERT INTO staff_property(staff_id,rentable_id) VALUES (${staff.id},${b.hotel})`;
    const staffB = { kind: 'staff', id: staff.id };
    const today = propertyToday();

    await t.test('rates and rooms grid and changes', async () => {
      await refused(hotelAriGrid(sql, ownerB, a.hotel, { from: today }));
      await refused(hotelAriGrid(sql, staffB, a.hotel, { from: today }));
      const change = {
        from: today,
        to: addLocalDays(today, 1),
        roomTypeIds: [a.deluxe],
        op: 'price',
        value: 3200,
        preview: true,
      };
      await refused(changeHotelAri(sql, ownerB, a.hotel, change));
      await refused(changeHotelAri(sql, staffB, a.hotel, change));
    });

    await t.test("wizard saves on another owner's hotel", async () => {
      const room = {
        name: 'Deluxe',
        beds: [{ type: 'king', count: 1 }],
        extraPlaces: [{ type: 'extra_bed', count: 1 }],
        sizeSqm: 24,
        view: 'city',
        maxAdults: 3,
        maxChildren: 2,
        maxOccupancy: 4,
        baseOccupancy: 2,
        roomCount: 5,
        extraAdult: 700,
        extraChild: 400,
        amenities: ['ac'],
        sortOrder: 10,
        isActive: true,
      };
      await refused(
        saveHotelRooms(sql, b.owner, {
          rentableId: a.hotel,
          expectedVersion: version,
          rooms: [room],
        }),
      );
      const rules = {
        couples: 'yes',
        localId: 'yes',
        idTypes: ['aadhaar'],
        pets: 'no',
        smoking: 'no',
        parties: 'no',
        extraRules: '',
      };
      await refused(
        saveHotelProfile(sql, b.owner, {
          rentableId: a.hotel,
          expectedVersion: version,
          part: 'rules',
          values: rules,
        }),
      );
      const [before] =
        await sql`SELECT count(*)::int n FROM room_type WHERE rentable_id=${a.hotel}`;
      assert.equal(before.n, 2, 'nothing changed on hotel A');
    });

    await t.test('finance and analytics', async () => {
      await refused(getOwnerHotelAnalytics(sql, b.owner, { hotelId: a.hotel }));
      await refused(payouts.previewPayoutRun(sql, b.owner, {}));
      await refused(payouts.listPayoutRuns(sql, b.owner));
      await refused(getAdminHotelAnalytics(sql, b.owner, {}));
      const earnings = await payouts.getOwnerHotelEarnings(sql, b.owner, {});
      assert.ok(earnings.nextPayout.lines.every((line) => line.ownerId === b.owner));
    });

    await t.test('admin catalogues refuse non-admins', async () => {
      await refused(listBetaGuests(sql, ownerB, 'hotel'));
      await refused(
        betaGuestCommand(sql, ownerB, 'hotel', { action: 'invite', phones: '9898989898' }),
      );
      await refused(listLandmarks(sql, ownerB));
      await refused(
        landmarkCommand(sql, ownerB, 'new', {
          cityId: a.city,
          slug: 'x-y',
          name: 'X Y',
          kind: 'mall',
          latitude: 21,
          longitude: 72,
          reason: 'Testing access only.',
        }),
      );
    });
  },
);
