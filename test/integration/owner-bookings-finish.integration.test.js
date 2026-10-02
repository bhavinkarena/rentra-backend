import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import {
  startCheckoutPayment,
  verifyCheckoutPayment,
} from '../../src/services/payments/checkout-service.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { createBookingCase, resolveBookingCase } from '../../src/services/booking/booking-cases.js';
import { listBookingRecords, readBookingRecord } from '../../src/services/booking/records.js';
import { listStaffVisits } from '../../src/services/booking/staff-visits.js';
import {
  arrivalGuideMessage,
  queueArrivalGuides,
  readArrivalGuide,
  saveArrivalGuide,
} from '../../src/services/booking/arrival-guide.js';
import { processNotification } from '../../src/services/notifications/jobs.js';
import { notificationMessage } from '../../src/services/domain/notifications.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_TEST_KEY_ID: 'rzp_test_BOOK08KEY12',
  RAZORPAY_TEST_KEY_SECRET: 'book08-disposable-key-secret',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'book08-disposable-webhook-secret',
};
const gate = 'https://res.cloudinary.com/demo/image/upload/gate.jpg';
// Local clusters without PostGIS store the point as text; read it back the same way.
const geometryStubs = (sql) =>
  sql.unsafe(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') THEN
  CREATE FUNCTION st_x(text) RETURNS float8 IMMUTABLE LANGUAGE sql AS 'SELECT (regexp_match($1,''POINT\\(([-0-9.]+) ([-0-9.]+)\\)''))[1]::float8';
  CREATE FUNCTION st_y(text) RETURNS float8 IMMUTABLE LANGUAGE sql AS 'SELECT (regexp_match($1,''POINT\\(([-0-9.]+) ([-0-9.]+)\\)''))[2]::float8';
END IF; END $$`);
const visitAt = (sql, id, start, end) =>
  sql`UPDATE booking SET hours_known=true,starts_at=${start},ends_at=${end},blocked_start_at=${start},blocked_end_at=${end},
    local_day=(${start}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date WHERE id=${id} RETURNING *`;

test(
  'BOOK-01/06/08: list cards, caretaker contact toggle, no-show prefill, arrival guide outbox',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql);
      const booked = await seedConfirmedBooking(sql, f.listing);
      const owner = { kind: 'owner', id: f.owner };
      await geometryStubs(sql);
      await sql`UPDATE booking_order SET listing_snapshot=listing_snapshot||'{"contact":{"name":"Riya Patel","phone":"9876543210"}}'::jsonb WHERE id=${booked.order}`;
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booked.order}`;
      await visitAt(sql, visit.id, new Date(Date.now() + 60_000), new Date(Date.now() + 3_600_000));

      // BOOK-01: owner list card carries guest first name, contact, visits and next action.
      const list = await listBookingRecords(sql, owner, { tab: 'upcoming' });
      const card = list.items.find((i) => i.id === booked.order);
      assert.equal(card.contact.name, 'Riya');
      assert.equal(card.contact.phone, '9876543210');
      assert.equal(card.visits.length, 1);
      assert.equal(card.visits[0].operation.action, 'handover');
      assert.equal(card.guests, 2);

      // BOOK-06: caretaker list shows the guest on the visit day unless the owner turned it off.
      const [staff] =
        await sql`INSERT INTO client_staff(client_id,phone,name,permissions,accepted_at) VALUES(${f.owner},'9811111111','Ramesh Kaka','{"evidence":true}',now()) RETURNING id`;
      await sql`INSERT INTO staff_property(staff_id,rentable_id) VALUES(${staff.id},${f.listing})`;
      const actor = (guestContact) => ({
        id: staff.id,
        ownerId: f.owner,
        permissions: { evidence: true, guestContact },
        capabilities: [],
      });
      const shown = await listStaffVisits(sql, actor(true), { tab: 'today' });
      assert.deepEqual(shown.items[0].guest, { name: 'Riya', phone: '9876543210', guests: 2 });
      const hidden = await listStaffVisits(sql, actor(false), { tab: 'today' });
      assert.equal(hidden.items[0].guest, null);
      const later = await listStaffVisits(sql, actor(true), { tab: 'upcoming' });
      assert.ok(later.items.every((i) => i.guest === null || i.date === propertyToday()));

      // No-show: overdue and never checked in → eligible; the owner's no_show case is accepted.
      await visitAt(
        sql,
        visit.id,
        new Date(Date.now() - 7_200_000),
        new Date(Date.now() - 3_600_000),
      );
      const record = await readBookingRecord(sql, owner, booked.order);
      assert.equal(record.visits[0].noShowEligible, true);
      const noShow = await createBookingCase(sql, owner, {
        orderId: booked.order,
        type: 'no_show',
        visitIds: [visit.id],
        reason: 'The guest did not arrive for this visit.',
        requestKey: randomUUID(),
      });
      assert.ok(noShow.id);

      // BOOK-08: guide editing is owner-scoped and the gate photo must be the property's own.
      await sql`UPDATE rentable SET photos=${sql.json([{ url: gate }])},location='SRID=4326;POINT(73.1 19.2)' WHERE id=${f.listing}`;
      assert.equal(await readArrivalGuide(sql, f.other, f.listing), null);
      assert.equal(await saveArrivalGuide(sql, f.other, f.listing, { landmark: 'x' }), null);
      await assert.rejects(
        saveArrivalGuide(sql, f.owner, f.listing, { gatePhotoKey: 'https://evil.example/x.jpg' }),
        { code: 'INVALID_ARRIVAL_GUIDE' },
      );
      await assert.rejects(
        saveArrivalGuide(sql, f.owner, f.listing, { landmark: 'x'.repeat(301) }),
        { name: 'ZodError' },
      );
      await saveArrivalGuide(sql, f.owner, f.listing, {
        landmark: 'Blue gate after the temple',
        parking: 'Inside, 4 cars',
        gatePhotoKey: gate,
        caretakerVisible: true,
      });
      assert.equal(
        (await readArrivalGuide(sql, f.owner, f.listing)).guide.parking,
        'Inside, 4 cars',
      );

      // Three more visits: one due for its guide, one cancelled, one too far ahead.
      const add = async (ref, position, startOffsetMs, slot, state = 'confirmed') => {
        const start = new Date(Date.now() + startOffsetMs);
        const end = new Date(+start + 3_600_000);
        const [row] =
          await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,units_booked,guests,cancelled_at,cancelled_by_kind,cancellation_reason)
          VALUES(${ref},${f.listing},${booked.customer},${booked.order},${position},(${start}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date,${slot},${state},${start},${end},true,${start},${end},'INR','Asia/Kolkata',100000,8000,0,1,2,
            ${state === 'cancelled' ? new Date() : null},${state === 'cancelled' ? 'admin' : null},${state === 'cancelled' ? 'Test cancel' : null}) RETURNING id`;
        return row.id;
      };
      const due = await add('V-GUIDE', 2, 20 * 3_600_000, 'full_day');
      const cancelled = await add('V-GUIDE-X', 3, 21 * 3_600_000, 'night', 'cancelled');
      const far = await add('V-GUIDE-FAR', 4, 72 * 3_600_000, 'day');
      const queued = await queueArrivalGuides(sql);
      assert.equal(queued, 1);
      assert.equal(await queueArrivalGuides(sql), 0, 'deduped on a second run');
      const rows = await sql`SELECT * FROM notification_outbox WHERE template='arrival_guide'`;
      assert.deepEqual(
        rows.map((r) => r.booking_id),
        [due],
      );
      // Morning of arrival (07:00 IST) supersedes T-24h once it is due.
      const [{ morningDue }] =
        await sql`SELECT (local_day::timestamp+time '07:00') AT TIME ZONE 'Asia/Kolkata'<=now() "morningDue" FROM booking WHERE id=${due}`;
      assert.match(rows[0].event_key, morningDue ? /^arrivalam:/ : /^arrival24:/);
      assert.ok(![cancelled, far].includes(rows[0].booking_id));

      const text = await arrivalGuideMessage(sql, due);
      for (const part of [
        'Landmark: Blue gate',
        'Parking: Inside',
        `Gate photo: ${gate}`,
        'Caretaker: Ramesh Kaka 9811111111',
        'Map: https://maps.google.com/?q=19.2,73.1',
      ])
        assert.ok(text.includes(part), part);
      assert.match(
        notificationMessage({
          template: 'arrival_guide',
          guide: text,
          reference: 'ORD-CP08',
          id: 'n1',
          visit_provenance: 'real',
        }),
        /^Rentra: Arrival guide for ORD-CP08\. Map:/,
      );

      // At send time: a live visit passes eligibility (then waits on SMS config); a cancelled one is suppressed.
      await processNotification(sql, rows[0].id, { env: { NODE_ENV: 'test' } });
      const [sent] =
        await sql`SELECT state,failure_code FROM notification_outbox WHERE id=${rows[0].id}`;
      assert.equal(sent.state, 'blocked');
      assert.notEqual(sent.failure_code, 'ARRIVAL_GUIDE_OBSOLETE');
      await sql`UPDATE booking SET state='cancelled',cancelled_at=now(),cancelled_by_kind='admin',cancellation_reason='Test cancel' WHERE id=${due}`;
      await sql`UPDATE notification_outbox SET next_attempt_at=now() WHERE id=${rows[0].id}`;
      await processNotification(sql, rows[0].id, { env: { NODE_ENV: 'test' } });
      const [after] =
        await sql`SELECT state,failure_code FROM notification_outbox WHERE id=${rows[0].id}`;
      assert.deepEqual(
        { ...after },
        { state: 'suppressed', failure_code: 'ARRIVAL_GUIDE_OBSOLETE' },
      );
    } finally {
      await fixture.drop();
    }
  },
);

test(
  'BOOK-05/08: partial refunds stay inside the capture recorded by the fake Razorpay provider',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = fixture.sql;
    const dir = await mkdtemp(join(tmpdir(), 'rentra-book08-'));
    const providerFile = join(dir, 'razorpay.json');
    try {
      const f = await seedReviewFixture(sql);
      const booked = await seedConfirmedBooking(sql, f.listing);
      const slot = {
        enabled: true,
        startTime: '09:00',
        endTime: '18:00',
        endDayOffset: 0,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        capacity: 12,
        includedGuests: 12,
        extraGuestChargeMinor: 0,
      };
      await sql`UPDATE rentable SET status='live',booking_config=${sql.json({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })} WHERE id=${f.listing}`;
      const [legacy] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${booked.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${legacy.id},'booking','committed',${legacy.starts_at},${legacy.ends_at})`;
      const day = addLocalDays(propertyToday(), 10);
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: day, to: day });
      await setPaymentGatewayConfiguration(
        sql,
        {
          actorId: f.admin,
          expectedVersion: 0,
          provider: 'razorpay',
          environment: 'test',
          enabled: true,
          collectionPurpose: 'full',
        },
        env,
      );
      const [row] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${booked.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: booked.customer, sessionId: row.id };
      const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
      const quote = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [day], slot: 'day', guests: 2 },
        { customerId: booked.customer, variables: env },
      );
      const held = await createCheckoutHold(
        sql,
        session,
        {
          rentableId: f.listing,
          quoteId: quote.id,
          hash: quote.hash,
          version: quote.version,
          idempotencyKey: randomUUID(),
          accepted: true,
        },
        env,
      );
      const started = await startCheckoutPayment(sql, session, held.orderId, opts);
      providerCaptures(providerFile, started.providerOrderId, 'pay_BOOK08');
      await verifyCheckoutPayment(
        sql,
        session,
        {
          orderId: held.orderId,
          paymentId: 'pay_BOOK08',
          signature: createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
            .update(`${started.providerOrderId}|pay_BOOK08`)
            .digest('hex'),
        },
        opts,
      );
      const [v] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
      const [{ captured }] =
        await sql`SELECT sum(actual_minor)::int captured FROM payment_allocation WHERE booking_id=${v.id}`;
      assert.ok(captured > 0);

      const owner = { kind: 'owner', id: f.owner };
      const admin = { kind: 'admin', id: f.admin };
      const openCase = async () => {
        const c = await createBookingCase(sql, owner, {
          orderId: held.orderId,
          type: 'operational',
          visitIds: [v.id],
          reason: 'The pool pump failed during the stay.',
          requestKey: randomUUID(),
        });
        const [{ version }] = await sql`SELECT version FROM booking_case WHERE id=${c.id}`;
        return (refundMinor) =>
          resolveBookingCase(sql, admin, {
            caseId: c.id,
            expectedVersion: version,
            outcome: 'partial_refund',
            refundMinor,
            note: 'Goodwill for the failed pool pump.',
            audience: 'everyone',
            requestKey: randomUUID(),
          });
      };
      // Not checked in yet: a partial refund is refused.
      await assert.rejects((await openCase())(1000), { code: 'INVALID_OUTCOME' });

      // Check in, then refund: above the capture is refused, the whole capture is allowed once.
      const start = new Date(Date.now() - 3_600_000),
        end = new Date(Date.now() + 3_600_000);
      // Test-only time travel: paid checkout terms are immutable, so move the visit with triggers off.
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role=replica`;
        await tx`UPDATE inventory_reservation SET blocked_start_at=${start},blocked_end_at=${end} WHERE booking_id=${v.id}`;
        await visitAt(tx, v.id, start, end);
      });
      await sql`INSERT INTO visit_evidence(booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,request_key,request_hash) VALUES(${v.id},'handover','simulation','owner',${f.owner},'',now()-interval '30 minutes',${randomUUID()},${'0'.repeat(64)})`;
      await sql`UPDATE booking SET state='handed_over',lifecycle_version=lifecycle_version+1 WHERE id=${v.id}`;
      const refund = await openCase();
      await assert.rejects(refund(captured + 1), { code: 'REFUND_EXCEEDS_CAPTURE' });
      await refund(captured);
      const [{ reserved }] =
        await sql`SELECT sum(expected_minor)::int reserved FROM refund_allocation WHERE booking_id=${v.id}`;
      assert.equal(reserved, captured);
      await assert.rejects((await openCase())(1), { code: 'REFUND_EXCEEDS_CAPTURE' });
    } finally {
      await fixture.drop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
