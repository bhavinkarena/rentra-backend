import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { insertStayBooking, seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/** Hotel plan, Phase 5: the rates and rooms calendar — bulk edits, roles and booked-room protection. */
test(
  'Phase 5: hotel rates and rooms calendar',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    t.after(() => fixture.drop());
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { hotelAriGrid, changeHotelAri } = await import('@/services/booking/hotel-ari.js');
    const { quoteHotelStay, holdHotelRooms } = await import('@/services/booking/hotel-stays.js');
    const { withListingInventory } = await import('@/services/booking/inventory.js');
    // Every save carries the data version from its preview (Story 3.5).
    const apply = async (actor, id, input) =>
      changeHotelAri(sql, actor, id, {
        ...input,
        expectedVersion: (await changeHotelAri(sql, actor, id, { ...input, preview: true }))
          .version,
      });
    const rejects = (promise, code) =>
      assert.rejects(promise, (error) => {
        assert.equal(error.code, code, `${error.code}: ${error.message}`);
        return true;
      });
    const h = await seedHotel(sql, { deluxeRooms: 6 });
    // Two more room types so a bulk edit spans 4 room types.
    for (const [name, count] of [
      ['Suite', 2],
      ['Family', 3],
    ]) {
      const [room] =
        await sql`INSERT INTO room_type(rentable_id,name,max_adults,max_occupancy,room_count) VALUES (${h.hotel},${name},2,3,${count}) RETURNING id`;
      await sql`INSERT INTO rate_plan(room_type_id,rentable_id,name,weekday_minor,weekend_minor) VALUES (${room.id},${h.hotel},'Room only',500000,550000)`;
    }
    const owner = { kind: 'owner', id: h.owner };
    const staff = async (role) => {
      const [row] =
        await sql`INSERT INTO client_staff(client_id,phone,name,permissions) VALUES (${h.owner},${`98${String(Math.random()).slice(2, 10)}`},${role},${JSON.stringify({ hotelRole: role })}::text::jsonb) RETURNING id`;
      await sql`INSERT INTO staff_property(staff_id,rentable_id) VALUES (${row.id},${h.hotel})`;
      return { kind: 'staff', id: row.id };
    };
    const frontDesk = await staff('front_desk');
    const manager = await staff('manager');
    const types = (
      await sql`SELECT id FROM room_type WHERE rentable_id=${h.hotel} AND is_active`
    ).map((r) => r.id);
    const start = addLocalDays(propertyToday(), 3);

    await t.test('grid shows defaults: all rooms open, weekday/weekend prices', async () => {
      const grid = await hotelAriGrid(sql, owner, h.hotel, { from: start, days: 14 });
      assert.equal(grid.roomTypes.length, 4);
      const deluxe = grid.roomTypes.find((r) => r.name === 'Deluxe Double');
      assert.deepEqual([deluxe.roomCount, deluxe.nights[0].open, deluxe.nights.length], [6, 6, 14]);
      const weekendNight = deluxe.nights.find(
        (n) => grid.dates.find((d) => d.date === n.date).weekend,
      );
      assert.equal(weekendNight.priceMinor, 300000);
    });

    await t.test('bulk edit: 90 nights × 4 room types in under 2 seconds', async () => {
      const input = {
        from: start,
        to: addLocalDays(start, 89),
        roomTypeIds: types,
        op: 'price',
        value: 3200,
      };
      const preview = await changeHotelAri(sql, owner, h.hotel, { ...input, preview: true });
      assert.equal(preview.cells, 360);
      let started = performance.now();
      await changeHotelAri(sql, owner, h.hotel, {
        ...input,
        previewHash: preview.previewHash,
        expectedVersion: preview.version,
      });
      const priceMs = performance.now() - started;
      started = performance.now();
      await apply(owner, h.hotel, { ...input, op: 'rooms', value: 2 });
      const roomsMs = performance.now() - started;
      assert.ok(
        priceMs < 2000 && roomsMs < 2000,
        `${Math.round(priceMs)} ms, ${Math.round(roomsMs)} ms`,
      );
      t.diagnostic(
        `price 360 cells: ${Math.round(priceMs)} ms; rooms 360 cells: ${Math.round(roomsMs)} ms`,
      );
      const [{ n }] =
        await sql`SELECT count(*)::int AS n FROM rate_override o JOIN rate_plan p ON p.id=o.rate_plan_id WHERE p.rentable_id=${h.hotel}`;
      assert.equal(n, 360);
      const grid = await hotelAriGrid(sql, owner, h.hotel, { from: start, days: 3 });
      assert.ok(
        grid.roomTypes.every((r) =>
          r.nights.every(
            (night) => night.priceMinor === 320000 && night.customPrice && night.allotment === 2,
          ),
        ),
      );
    });

    await t.test('percentage change, weekdays only, and reset', async () => {
      const saturday = (() => {
        let d = start;
        while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 6) d = addLocalDays(d, 1);
        return d;
      })();
      await apply(owner, h.hotel, {
        from: saturday,
        to: addLocalDays(saturday, 6),
        weekdays: [6],
        roomTypeIds: [h.deluxe],
        op: 'pricePct',
        value: 10,
      });
      const grid = await hotelAriGrid(sql, owner, h.hotel, { from: saturday, days: 2 });
      const deluxe = grid.roomTypes.find((r) => r.id === h.deluxe);
      assert.deepEqual(
        deluxe.nights.map((n) => n.priceMinor),
        [352000, 320000],
        'Saturday +10%, Sunday unchanged',
      );
      await apply(owner, h.hotel, {
        from: saturday,
        to: saturday,
        roomTypeIds: [h.deluxe],
        op: 'resetPrice',
      });
      const reset = await hotelAriGrid(sql, owner, h.hotel, { from: saturday, days: 1 });
      assert.equal(reset.roomTypes.find((r) => r.id === h.deluxe).nights[0].priceMinor, 300000);
      await rejects(
        apply(owner, h.hotel, {
          from: start,
          to: start,
          roomTypeIds: [h.deluxe],
          op: 'price',
          value: 100,
        }),
        'VALIDATION_FAILED',
      );
    });

    await t.test('rooms open can never drop below rooms booked', async () => {
      await apply(owner, h.hotel, {
        from: start,
        to: addLocalDays(start, 2),
        roomTypeIds: [h.deluxe],
        op: 'rooms',
        value: 6,
      });
      const guest = await seedCustomer(sql);
      const quote = await quoteHotelStay(sql, {
        rentableId: h.hotel,
        checkIn: start,
        checkOut: addLocalDays(start, 2),
        rooms: Array.from({ length: 3 }, () => ({
          roomTypeId: h.deluxe,
          ratePlanId: h.deluxeBase,
          adults: 2,
        })),
      });
      await withListingInventory(sql, h.hotel, async (tx, listing) => {
        const ids = await insertStayBooking(tx, { customerId: guest, rentableId: h.hotel, quote });
        await holdHotelRooms(tx, listing, { bookingId: ids.bookingId, quote });
      });
      await rejects(
        apply(owner, h.hotel, {
          from: start,
          to: start,
          roomTypeIds: [h.deluxe],
          op: 'rooms',
          value: 2,
        }),
        'ROOMS_BELOW_BOOKINGS',
      );
      await rejects(
        apply(owner, h.hotel, {
          from: start,
          to: start,
          roomTypeIds: [h.deluxe],
          op: 'rooms',
          value: 7,
        }),
        'VALIDATION_FAILED',
      );
      await apply(owner, h.hotel, {
        from: start,
        to: start,
        roomTypeIds: [h.deluxe],
        op: 'rooms',
        value: 3,
      });
      const grid = await hotelAriGrid(sql, owner, h.hotel, { from: start, days: 1 });
      assert.deepEqual(
        ((n) => [n.allotment, n.held, n.open])(
          grid.roomTypes.find((r) => r.id === h.deluxe).nights[0],
        ),
        [3, 3, 0],
      );
    });

    await t.test(
      'Story 3.5: versioned saves, before/after preview, derived rates, booked prices kept',
      async () => {
        const input = {
          from: start,
          to: addLocalDays(start, 1),
          roomTypeIds: [h.deluxe],
          op: 'pricePct',
          value: 10,
        };
        const booked = async () => [
          (
            await sql`SELECT amount_room_minor FROM booking_room WHERE room_type_id=${h.deluxe} ORDER BY id`
          ).map((r) => String(r.amount_room_minor)),
          (
            await sql`SELECT amount_rent_minor FROM booking_order WHERE rentable_id=${h.hotel} ORDER BY id`
          ).map((r) => String(r.amount_rent_minor)),
        ];
        const bookedBefore = await booked();
        assert.ok(bookedBefore[0].length, 'a booking exists on these nights');
        const preview = await changeHotelAri(sql, owner, h.hotel, { ...input, preview: true });
        assert.equal(preview.changeCount, 2);
        assert.deepEqual(
          preview.changes.map((c) => [c.roomTypeId, c.beforeMinor, c.afterMinor]),
          [
            [h.deluxe, 320000, 352000],
            [h.deluxe, 320000, 352000],
          ],
        );
        await rejects(changeHotelAri(sql, owner, h.hotel, input), 'VALIDATION_FAILED');
        // Another edit lands between preview and save: nothing is written.
        await apply(owner, h.hotel, { ...input, to: start, op: 'minNights', value: 2 });
        await rejects(
          changeHotelAri(sql, owner, h.hotel, {
            ...input,
            previewHash: preview.previewHash,
            expectedVersion: preview.version,
          }),
          'CALENDAR_CHANGED',
        );
        // Weekend nights changing after the preview also invalidates it.
        const weekendPreview = await changeHotelAri(sql, owner, h.hotel, {
          ...input,
          preview: true,
        });
        const [{ weekend_nights: weekendNights }] =
          await sql`SELECT weekend_nights FROM hotel_profile WHERE rentable_id=${h.hotel}`;
        await sql`UPDATE hotel_profile SET weekend_nights=${[0, 6]} WHERE rentable_id=${h.hotel}`;
        await rejects(
          changeHotelAri(sql, owner, h.hotel, {
            ...input,
            expectedVersion: weekendPreview.version,
          }),
          'CALENDAR_CHANGED',
        );
        await sql`UPDATE hotel_profile SET weekend_nights=${weekendNights} WHERE rentable_id=${h.hotel}`;
        const grid = await hotelAriGrid(sql, owner, h.hotel, { from: start, days: 2 });
        assert.deepEqual(
          grid.roomTypes.find((r) => r.id === h.deluxe).nights.map((n) => n.priceMinor),
          [320000, 320000],
        );
        await apply(owner, h.hotel, input);
        assert.deepEqual(await booked(), bookedBefore, 'booked rooms keep their snapshot');
        await sql`INSERT INTO rate_plan(room_type_id,rentable_id,name,derived_from,derived_pct_bps) VALUES (${h.deluxe},${h.hotel},'With breakfast',${h.deluxeBase},2000)`;
        const derived = (
          await hotelAriGrid(sql, owner, h.hotel, { from: start, days: 1 })
        ).roomTypes
          .find((r) => r.id === h.deluxe)
          .derivedPlans.find((p) => p.name === 'With breakfast');
        assert.deepEqual(derived.prices, [422400], 'base 3,520 + 20%');
        await sql`DELETE FROM rate_plan WHERE name='With breakfast' AND rentable_id=${h.hotel}`;
        await apply(owner, h.hotel, { ...input, op: 'price', value: 3200 });
        await apply(owner, h.hotel, { ...input, to: start, op: 'minNights', value: 1 });
      },
    );

    await t.test(
      'a stay follows its booking: cancel releases rooms; no-show and completed keep them sold',
      async () => {
        const { confirmHotelRooms } = await import('@/services/booking/hotel-stays.js');
        const { ownerNotificationMessage } =
          await import('@/services/notifications/owner-domain.js');
        const { describeVisit } = await import('@/services/domain/booking-record.js');
        const checkIn = addLocalDays(start, 40);
        const guest = await seedCustomer(sql);
        const book = async () => {
          const quote = await quoteHotelStay(sql, {
            rentableId: h.hotel,
            checkIn,
            checkOut: addLocalDays(checkIn, 2),
            rooms: [{ roomTypeId: h.standard, ratePlanId: h.standardBase, adults: 2 }],
          });
          const ids = await withListingInventory(sql, h.hotel, async (tx, listing) => {
            const created = await insertStayBooking(tx, {
              customerId: guest,
              rentableId: h.hotel,
              quote,
            });
            await holdHotelRooms(tx, listing, { bookingId: created.bookingId, quote });
            return created;
          });
          await confirmHotelRooms(sql, ids.bookingId);
          await sql`UPDATE booking SET state='confirmed' WHERE id=${ids.bookingId}`;
          return ids.bookingId;
        };
        const sold = async () =>
          (
            await sql`SELECT coalesce(sum(sold),0)::int s FROM room_night WHERE room_type_id=${h.standard} AND night >= ${checkIn}`
          )[0].s;
        const cancelled = await book();
        assert.equal(await sold(), 2);
        await sql`UPDATE booking SET state='cancelled', cancelled_at=now(), cancelled_by_kind='customer' WHERE id=${cancelled}`;
        assert.equal(await sold(), 0, 'cancelling the booking puts both nights back on sale');
        assert.deepEqual(
          (await sql`SELECT state FROM booking_room WHERE booking_id=${cancelled}`).map(
            (r) => r.state,
          ),
          ['released'],
        );
        const noShow = await book();
        const done = await book();
        // Existing guards require an admin case and visit evidence for these states; this checks only the room sync.
        const ROLLBACK = new Error('rollback');
        await sql
          .begin(async (tx) => {
            await tx`ALTER TABLE booking DISABLE TRIGGER visit_transition_proof`;
            await tx`UPDATE booking SET state='no_show' WHERE id=${noShow}`;
            await tx`UPDATE booking SET state='completed' WHERE id=${done}`;
            const rows =
              await tx`SELECT booking_id, state FROM booking_room WHERE booking_id IN (${noShow}, ${done})`;
            assert.deepEqual(
              rows.map((r) => [r.booking_id === noShow ? 'noShow' : 'done', r.state]).sort(),
              [
                ['done', 'stayed'],
                ['noShow', 'no_show'],
              ],
            );
            assert.equal(
              (
                await tx`SELECT sum(sold)::int s FROM room_night WHERE room_type_id=${h.standard} AND night >= ${checkIn}`
              )[0].s,
              4,
              'they stay sold',
            );
            throw ROLLBACK;
          })
          .catch((error) => {
            if (error !== ROLLBACK) throw error;
          });
        assert.equal(await sold(), 4);
        assert.match(
          ownerNotificationMessage(
            {
              event: 'booking_confirmed',
              property_title: 'Riverside',
              detail: {
                slot: 'stay',
                visitDate: checkIn,
                checkOut: addLocalDays(checkIn, 2),
                rooms: 2,
                guests: 4,
              },
            },
            'https://rentra.test',
          ),
          new RegExp(`Riverside · ${checkIn} to ${addLocalDays(checkIn, 2)} · 2 rooms · 4 guests`),
        );
        assert.equal(
          describeVisit({ date: '2026-11-18', slot: 'stay', endsAt: '2026-11-20T05:30:00Z' }),
          'Wed 18 Nov – Fri 20 Nov · 2 nights',
        );
      },
    );

    await t.test(
      'team: owners give hotel roles; only hotel staff get the rooms capabilities',
      async () => {
        const { inviteStaff, updateStaffAccess, listTeam } =
          await import('@/services/auth/staff-team.js');
        const { capabilitiesFor } = await import('@/services/auth/capabilities.js');
        await sql`UPDATE "user" SET account_status='active' WHERE id=${h.owner}`;
        const invited = await inviteStaff(sql, h.owner, {
          name: 'Desk Ravi',
          phone: '9876500011',
          propertyIds: [h.hotel],
          evidence: 'on',
          hotelRole: 'front_desk',
        });
        let member = (await listTeam(sql, h.owner)).members.find((m) => m.id === invited.staffId);
        assert.equal(member.permissions.hotelRole, 'front_desk');
        await updateStaffAccess(sql, h.owner, invited.staffId, {
          expectedVersion: member.version,
          propertyIds: [h.hotel],
          evidence: 'on',
          hotelRole: 'manager',
        });
        member = (await listTeam(sql, h.owner)).members.find((m) => m.id === invited.staffId);
        assert.equal(member.permissions.hotelRole, 'manager');
        await assert.rejects(
          inviteStaff(sql, h.owner, {
            name: 'Bad Role',
            phone: '9876500012',
            propertyIds: [h.hotel],
            hotelRole: 'owner',
          }),
          (e) => e.statusCode === 422,
        );
        assert.deepEqual(
          capabilitiesFor({ active: true, permissions: { evidence: true } }, 'staff'),
          ['staff.assigned-visits.read', 'staff.assigned-visits.evidence'],
        );
        assert.deepEqual(
          capabilitiesFor({ active: true, permissions: { hotelRole: 'front_desk' } }, 'staff'),
          ['staff.assigned-visits.read', 'staff.hotel-rooms.read', 'staff.hotel-rooms.write'],
        );
      },
    );

    await t.test(
      'roles: front desk opens and closes rooms only; managers edit prices; strangers see nothing',
      async () => {
        await apply(frontDesk, h.hotel, {
          from: start,
          to: start,
          roomTypeIds: [h.standard],
          op: 'close',
        });
        assert.equal(
          (await hotelAriGrid(sql, frontDesk, h.hotel, { from: start, days: 1 })).roomTypes.find(
            (r) => r.id === h.standard,
          ).nights[0].stopSell,
          true,
        );
        await rejects(
          apply(frontDesk, h.hotel, {
            from: start,
            to: start,
            roomTypeIds: [h.standard],
            op: 'price',
            value: 2500,
          }),
          'ROLE_FORBIDDEN',
        );
        await rejects(
          apply(frontDesk, h.hotel, {
            from: start,
            to: start,
            roomTypeIds: [h.standard],
            op: 'rooms',
            value: 1,
          }),
          'ROLE_FORBIDDEN',
        );
        assert.equal(
          (await hotelAriGrid(sql, frontDesk, h.hotel, { from: start, days: 1 })).canEditPrices,
          false,
        );
        await apply(manager, h.hotel, {
          from: start,
          to: start,
          roomTypeIds: [h.standard],
          op: 'price',
          value: 2500,
        });
        await apply(owner, h.hotel, {
          from: start,
          to: start,
          roomTypeIds: [h.standard],
          op: 'open',
        });
        const [stranger] =
          await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('other@fixture.invalid','client','active','Other') RETURNING id`;
        await rejects(
          hotelAriGrid(sql, { kind: 'owner', id: stranger.id }, h.hotel, { from: start }),
          'NOT_FOUND',
        );
        const [revoked] =
          await sql`UPDATE client_staff SET is_active=false, revoked_at=now() WHERE id=${manager.id} RETURNING id`;
        await rejects(
          apply({ kind: 'staff', id: revoked.id }, h.hotel, {
            from: start,
            to: start,
            roomTypeIds: [h.standard],
            op: 'close',
          }),
          'NOT_FOUND',
        );
        await rejects(
          apply(owner, h.hotel, {
            from: addLocalDays(propertyToday(), -1),
            to: start,
            roomTypeIds: [h.standard],
            op: 'close',
          }),
          'VALIDATION_FAILED',
        );
        const audits = await sql`SELECT actor_type FROM audit_log WHERE action='hotel_ari_changed'`;
        assert.ok(
          audits.some((a) => a.actor_type === 'staff') &&
            audits.some((a) => a.actor_type === 'client'),
        );
      },
    );
  },
);
