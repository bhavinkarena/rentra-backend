import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { ownerPortfolioCalendar } from '../../src/services/booking/owner-calendar.js';
import {
  changeCalendarCells,
  undoCalendarCells,
} from '../../src/services/booking/calendar-bulk.js';
import {
  saveOwnerBookingNote,
  regenerateCalendarFeed,
  readCalendarFeed,
  addOfflineBooking,
} from '../../src/services/booking/owner-experience.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { createOwnerBlock } from '../../src/services/booking/inventory.js';
test(
  'Phase 7 bulk preview, conditional undo, bounded conflicts, private notes, offline inventory and secret feeds',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const f = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
        through: '0059_owner_pause_until',
      }),
      sql = f.sql;
    try {
      await migrateWithDrizzle(f.url, 1790591500004);
      const ids = await seedReviewFixture(sql),
        day = addLocalDays(propertyToday(), 10),
        next = addLocalDays(day, 1);
      const read = () =>
        ownerPortfolioCalendar(sql, ids.owner, { property: ids.listing, from: day, days: 7 });
      const input = {
        rentableId: ids.listing,
        change: {
          cells: [
            { date: day, slot: 'day' },
            { date: next, slot: 'day' },
          ],
          command: 'prices',
          rentMinor: 200000,
        },
        expectedCalendarVersion: (await read()).items[0].version,
        preview: true,
      };
      const preview = await changeCalendarCells(sql, ids.owner, input);
      assert.equal(preview.preview.result.affected.length, 2);
      assert.equal((await sql`SELECT * FROM booking_price_override`).length, 0);
      // Another day's owner block cannot invalidate a window-scoped confirmation.
      await createOwnerBlock(sql, ids.owner, {
        rentableId: ids.listing,
        blockedStartAt: addLocalDays(day, 5) + 'T12:00:00+05:30',
        blockedEndAt: addLocalDays(day, 5) + 'T13:00:00+05:30',
        reason: 'Repairs',
      });
      const saved = await changeCalendarCells(sql, ids.owner, {
        ...input,
        preview: false,
        previewToken: preview.preview.token,
      });
      assert.equal(saved.ok, true);
      assert.ok(saved.undoToken);
      assert.equal(
        (await read()).items[0].cells.find((c) => c.date === day && c.slot === 'day')
          .effectivePriceMinor,
        200000,
      );
      const resetInput = {
        ...input,
        change: { ...input.change, rentMinor: undefined, reset: true },
      };
      const resetPreview = await changeCalendarCells(sql, ids.owner, resetInput);
      const resetSaved = await changeCalendarCells(sql, ids.owner, {
        ...resetInput,
        preview: false,
        previewToken: resetPreview.preview.token,
      });
      assert.equal((await sql`SELECT * FROM booking_price_override`).length, 0);
      await undoCalendarCells(sql, ids.owner, resetSaved.undoToken);
      assert.equal((await sql`SELECT * FROM booking_price_override`).length, 2);
      await sql`UPDATE booking_price_override SET rent_minor=201000 WHERE day=${day}`;
      await assert.rejects(
        undoCalendarCells(sql, ids.owner, saved.undoToken),
        (e) => e.code === 'CALENDAR_CHANGED',
      );
      const restorePreview = await changeCalendarCells(sql, ids.owner, resetInput);
      await changeCalendarCells(sql, ids.owner, {
        ...resetInput,
        preview: false,
        previewToken: restorePreview.preview.token,
      });
      assert.equal((await sql`SELECT * FROM booking_price_override`).length, 0);
      const closing = {
        ...input,
        change: { cells: [{ date: day, slot: 'day' }], command: 'slots', open: false },
      };
      const closePreview = await changeCalendarCells(sql, ids.owner, closing);
      await changeCalendarCells(sql, ids.owner, {
        ...closing,
        preview: false,
        previewToken: closePreview.preview.token,
      });
      assert.equal(
        (await read()).items[0].cells.find((c) => c.date === day && c.slot === 'day').state,
        'closed',
      );
      const offline = await addOfflineBooking(sql, ids.owner, {
        rentableId: ids.listing,
        date: next,
        slot: 'day',
        name: 'Patel',
        phone: '9876543210',
        guests: 4,
        note: 'Private birthday decoration',
        collectedMinor: 50000,
      });
      assert.ok(offline.id);
      await assert.rejects(
        addOfflineBooking(sql, ids.owner, {
          rentableId: ids.listing,
          date: next,
          slot: 'day',
          name: 'Another guest',
          guests: 4,
        }),
        (e) => e.code === 'INVENTORY_CONFLICT',
      );
      const blocked = await changeCalendarCells(sql, ids.owner, {
        ...closing,
        change: { cells: [{ date: next, slot: 'day' }], command: 'slots', open: false },
      });
      assert.equal(blocked.preview.result.conflicts.length, 1);
      await assert.rejects(
        changeCalendarCells(sql, ids.other, input),
        (e) => e.code === 'NOT_FOUND',
      );
      const feed = await regenerateCalendarFeed(sql, ids.owner, ids.listing),
        ical = await readCalendarFeed(sql, feed.token);
      assert.ok(ical.startsWith('BEGIN:VCALENDAR'));
      assert.ok(ical.includes('Offline booking'));
      assert.ok(!ical.includes('Patel'));
      assert.ok(!ical.includes('9876543210'));
      assert.ok(!ical.includes('decoration'));
      await regenerateCalendarFeed(sql, ids.owner, ids.listing);
      assert.equal(await readCalendarFeed(sql, feed.token), null);
      const booking = await seedConfirmedBooking(sql, ids.listing);
      await saveOwnerBookingNote(sql, ids.owner, {
        orderId: booking.order,
        body: 'Vegetarian food only',
      });
      assert.equal(
        (await sql`SELECT owner_note FROM booking_order WHERE id=${booking.order}`)[0].owner_note,
        'Vegetarian food only',
      );
      await assert.rejects(
        saveOwnerBookingNote(sql, ids.other, { orderId: booking.order, body: 'Foreign edit' }),
        (e) => e.code === 'NOT_FOUND',
      );
    } finally {
      await f.drop();
    }
  },
);

test(
  'Phase 7 early arrival, optional notes, automatic completion proof and admin no-show authority',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const { randomUUID } = await import('node:crypto');
    const { recordVisitTransition, completeReturnedVisits } =
      await import('../../src/services/booking/visit-lifecycle.js');
    const { createBookingCase, resolveBookingCase } =
      await import('../../src/services/booking/booking-cases.js');
    const f = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = f.sql;
    try {
      const ids = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, ids.listing),
        owner = { kind: 'owner', id: ids.owner },
        admin = { kind: 'admin', id: ids.admin };
      const [early] =
        await sql`UPDATE booking SET hours_known=true,starts_at=now()+interval '90 minutes',ends_at=now()+interval '4 hours',blocked_start_at=now()+interval '90 minutes',blocked_end_at=now()+interval '4 hours' WHERE order_id=${booked.order} RETURNING *`;
      const input = {
        visitId: early.id,
        phase: 'handover',
        occurredAt: new Date().toISOString(),
        note: '',
        attested: true,
        expectedVersion: early.lifecycle_version,
        requestKey: randomUUID(),
      };
      await assert.rejects(
        recordVisitTransition(sql, owner, {
          ...input,
          occurredAt: new Date(Date.now() - 60 * 60000).toISOString(),
        }),
        (e) => e.code === 'INVALID_EVIDENCE_TIME',
      );
      const checked = await recordVisitTransition(sql, owner, input);
      assert.ok(checked.id);
      assert.equal(
        (await sql`SELECT state FROM booking WHERE id=${early.id}`)[0].state,
        'handed_over',
      );
      const [past] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,visit_provenance,units_booked,guests) VALUES('PH7-RETURN',${ids.listing},${booked.customer},${booked.order},2,current_date-2,'day','confirmed',now()-interval '30 hours',now()-interval '26 hours',true,now()-interval '30 hours',now()-interval '26 hours','INR','Asia/Kolkata',100000,8000,0,'test',1,2) RETURNING *`;
      for (const [kind, state, hours] of [
        ['handover', 'handed_over', 29],
        ['return', 'returned', 25],
      ]) {
        await sql`INSERT INTO visit_evidence(booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,recorded_at,request_key,request_hash) VALUES(${past.id},${kind},'simulation','owner',${ids.owner},'',now()-make_interval(hours=>${hours}),now()-make_interval(hours=>${hours}),${randomUUID()},${'0'.repeat(64)})`;
        await sql`UPDATE booking SET state=${state},lifecycle_version=lifecycle_version+1 WHERE id=${past.id}`;
      }
      assert.equal((await completeReturnedVisits(sql)).completed, 1);
      assert.equal((await completeReturnedVisits(sql)).completed, 0);
      assert.equal(
        (
          await sql`SELECT actor_kind FROM visit_evidence WHERE booking_id=${past.id} AND kind='complete'`
        )[0].actor_kind,
        'system',
      );
      const [absent] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,visit_provenance,units_booked,guests) VALUES('PH7-NOSHOW',${ids.listing},${booked.customer},${booked.order},3,current_date-4,'day','confirmed',now()-interval '4 days',now()-interval '3 days',true,now()-interval '4 days',now()-interval '3 days','INR','Asia/Kolkata',100000,8000,0,'test',1,2) RETURNING *`;
      await assert.rejects(
        sql`UPDATE booking SET state='no_show' WHERE id=${absent.id}`,
        (e) => e.code === '23514',
      );
      const c = await createBookingCase(sql, owner, {
        orderId: booked.order,
        type: 'no_show',
        visitIds: [absent.id],
        reason: 'Guest did not arrive at the property.',
        requestKey: randomUUID(),
      });
      const [row] = await sql`SELECT version FROM booking_case WHERE id=${c.id}`;
      const resolution = {
        caseId: c.id,
        expectedVersion: row.version,
        outcome: 'no_show',
        note: 'Confirmed no arrival with owner and guest.',
        audience: 'everyone',
        requestKey: randomUUID(),
      };
      await assert.rejects(
        resolveBookingCase(sql, owner, resolution),
        (e) => e.code === 'OPERATOR_REQUIRED',
      );
      await resolveBookingCase(sql, admin, resolution);
      assert.equal(
        (await sql`SELECT state FROM booking WHERE id=${absent.id}`)[0].state,
        'no_show',
      );
      assert.equal((await sql`SELECT * FROM refund`).length, 0);
      const [oldOrder] =
        await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,state,confirmed_at) VALUES('PH7-OLD',${booked.customer},${ids.listing},'INR','Asia/Kolkata','v1','v1','{}','{"contact":{"name":"Old Guest","phone":"9000000077"}}',100000,8000,0,${randomUUID()},'hash','confirmed',now()) RETURNING id AS "order"`;
      await sql`INSERT INTO booking(reference,rentable_id,customer_id,slot,state,starts_at,ends_at,order_id,item_position,local_day,currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor,confirmed_at) VALUES('PH7-OLD',${ids.listing},${booked.customer},'day','confirmed',now()-interval '9 days',now()-interval '8 days',${oldOrder.order},1,current_date-9,'INR','Asia/Kolkata',2,1,100000,8000,0,now()-interval '10 days')`;
      const [oldVisit] =
        await sql`UPDATE booking SET hours_known=true,starts_at=now()-interval '9 days',ends_at=now()-interval '8 days',blocked_start_at=now()-interval '9 days',blocked_end_at=now()-interval '8 days' WHERE order_id=${oldOrder.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES(${ids.listing},${oldVisit.id},'booking','committed',${oldVisit.blocked_start_at},${oldVisit.blocked_end_at})`;
      for (const [kind, state, hours] of [
        ['handover', 'handed_over', 215],
        ['return', 'returned', 194],
        ['complete', 'completed', 193],
      ]) {
        await sql`INSERT INTO visit_evidence(booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,recorded_at,request_key,request_hash) VALUES(${oldVisit.id},${kind},'simulation','owner',${ids.owner},'',now()-make_interval(hours=>${hours}),now()-make_interval(hours=>${hours}),${randomUUID()},${'0'.repeat(64)})`;
        await sql`UPDATE booking SET state=${state},lifecycle_version=lifecycle_version+1 WHERE id=${oldVisit.id}`;
      }
      const { readBookingRecord } = await import('../../src/services/booking/records.js');
      const expired = await readBookingRecord(sql, owner, oldOrder.order);
      assert.equal(expired.contact.phone, null);
      assert.equal(expired.contact.withheld, true);
      const oldCalendar = await ownerPortfolioCalendar(sql, ids.owner, {
        property: ids.listing,
        from: propertyToday(oldVisit.starts_at),
        days: 7,
      });
      assert.equal(
        oldCalendar.items[0].intervals.find((r) => r.order_id === oldOrder.order).guest_phone,
        null,
      );
    } finally {
      await f.drop();
    }
  },
);
