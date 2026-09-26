import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { createBookingQuote } from '../../src/services/booking/quotes.js';
import { openBookingDates } from '../../src/services/booking/owner-settings.js';
import { createCheckoutHold } from '../../src/services/booking/checkout.js';
import {
  previewCancellation,
  commitCancellation,
} from '../../src/services/booking/cancellation.js';
import { setPaymentGatewayConfiguration } from '../../src/services/payments/gateway-settings.js';
import {
  startCheckoutPayment,
  verifyCheckoutPayment,
} from '../../src/services/payments/checkout-service.js';
import { propertyToday, addLocalDays } from '../../src/services/domain/booking-dates.js';
import { readBookingRecord } from '../../src/services/booking/records.js';
import {
  addCaseUpdate,
  assignBookingCase,
  createBookingCase,
  listBookingCases,
  previewCaseResolution,
  readBookingCase,
  resolveBookingCase,
} from '../../src/services/booking/booking-cases.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_TEST_KEY_ID: 'rzp_test_CP14',
  RAZORPAY_TEST_KEY_SECRET: 'cp14-disposable-key-secret',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'cp14-disposable-webhook-secret',
};

test(
  'CP14 booking cases: exact visits, previewed partial cancellation, one refund effect, races and audiences',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const [{ udt_name }] =
        await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
      if (udt_name !== 'geometry') {
        await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
        await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
      }
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
      const owner = { kind: 'owner', id: f.owner },
        other = { kind: 'owner', id: f.other },
        admin = { kind: 'admin', id: f.admin },
        second = { kind: 'admin', id: f.second };

      // A real paid two-visit order through checkout (stubbed Razorpay transport).
      const [d1, d2, d3] = [10, 11, 12].map((n) => addLocalDays(propertyToday(), n));
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: d1, to: d3 });
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
      const [sessionRow] =
        await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${booked.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: booked.customer, sessionId: sessionRow.id };
      const quote = await createBookingQuote(
        sql,
        { rentableId: f.listing, dates: [d1, d2], slot: 'day', guests: 2 },
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
      const capture = {
        id: 'pay_CP14',
        order_id: 'order_CP14',
        amount: held.expectedMinor,
        currency: 'INR',
        status: 'captured',
        captured: true,
      };
      const fetcher = async (url, init) => {
        const path = new URL(url).pathname.replace('/v1/', '');
        const body = init.body ? JSON.parse(init.body) : null;
        const reply =
          path === 'orders'
            ? {
                id: 'order_CP14',
                amount: body.amount,
                currency: 'INR',
                receipt: body.receipt,
                partial_payment: false,
              }
            : path === 'payments/pay_CP14'
              ? capture
              : null;
        return { ok: Boolean(reply), json: async () => reply };
      };
      await startCheckoutPayment(sql, session, held.orderId, { env, fetcher });
      const signature = createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
        .update('order_CP14|pay_CP14')
        .digest('hex');
      assert.equal(
        (
          await verifyCheckoutPayment(
            sql,
            session,
            { orderId: held.orderId, paymentId: 'pay_CP14', signature },
            { env, fetcher },
          )
        ).state,
        'confirmed',
      );
      const paid =
        await sql`SELECT * FROM booking WHERE order_id=${held.orderId} ORDER BY item_position`;
      const [v1, v2] = paid;
      const refunds = async () => (await sql`SELECT count(*)::int n FROM refund`)[0].n;

      // Owner opens an owner-cancellation case for v1 only; replay, scope and type rules.
      const ownerKey = randomUUID();
      const request = {
        orderId: held.orderId,
        type: 'owner_cancellation',
        visitIds: [v1.id],
        reason: 'Water pump failure; the property cannot host guests that day.',
        requestKey: ownerKey,
      };
      const caseA = await createBookingCase(sql, owner, request);
      assert.match(caseA.reference, /^CASE-[0-9A-F]{10}$/);
      assert.equal((await createBookingCase(sql, owner, request)).id, caseA.id);
      await assert.rejects(
        createBookingCase(sql, owner, {
          ...request,
          reason: 'A different reason with the same key.',
        }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      await assert.rejects(
        createBookingCase(sql, other, { ...request, requestKey: randomUUID() }),
        { code: 'BOOKING_NOT_FOUND' },
      );
      await assert.rejects(
        createBookingCase(sql, owner, {
          ...request,
          type: 'change_request',
          requestKey: randomUUID(),
        }),
        { code: 'CASE_TYPE_UNAVAILABLE' },
      );
      await assert.rejects(
        createBookingCase(sql, owner, {
          ...request,
          visitIds: [legacy.id],
          requestKey: randomUUID(),
        }),
        { code: 'VISIT_NOT_FOUND' },
      );

      // Assignment is version-guarded; updates carry audiences.
      const assigned = await assignBookingCase(sql, admin, {
        caseId: caseA.id,
        expectedVersion: 1,
        assigneeId: f.admin,
      });
      assert.equal(assigned.version, 2);
      await assert.rejects(
        assignBookingCase(sql, second, {
          caseId: caseA.id,
          expectedVersion: 1,
          assigneeId: f.second,
        }),
        { code: 'CASE_CHANGED' },
      );
      await addCaseUpdate(sql, owner, {
        caseId: caseA.id,
        audience: 'everyone',
        body: 'Pump repair confirmed for next week.',
        requestKey: randomUUID(),
      });
      await addCaseUpdate(sql, admin, {
        caseId: caseA.id,
        audience: 'internal',
        body: 'Checked with the owner by phone.',
        requestKey: randomUUID(),
      });
      await assert.rejects(
        addCaseUpdate(sql, other, {
          caseId: caseA.id,
          body: 'Not my booking.',
          requestKey: randomUUID(),
        }),
        { code: 'CASE_NOT_FOUND' },
      );

      // Preview writes nothing; full returns rent+fee for v1 only; policy follows the accepted snapshot.
      const full = await previewCaseResolution(
        sql,
        admin,
        { caseId: caseA.id, basis: 'full' },
        env,
      );
      const policy = await previewCaseResolution(
        sql,
        admin,
        { caseId: caseA.id, basis: 'policy' },
        env,
      );
      assert.equal(full.preview.cancelCount, 1);
      assert.equal(
        full.preview.refundMinor,
        Number(v1.amount_rent_minor) + Number(v1.amount_fee_minor),
      );
      assert.ok(policy.preview.refundMinor <= full.preview.refundMinor);
      assert.equal(full.preview.orderAfter, 'unchanged', 'v2 keeps the order confirmed');
      assert.equal(
        full.preview.visits[0].releasedStartAt,
        new Date(v1.blocked_start_at).toISOString(),
      );
      assert.equal(full.preview.visits[0].refunds, undefined, 'allocation ids stay internal');
      assert.equal(await refunds(), 0);

      // Resolution: stale preview refused; exact preview cancels v1 once; replay returns the same effect.
      const resolve = (actor, extra) =>
        resolveBookingCase(sql, actor, {
          caseId: caseA.id,
          expectedVersion: 2,
          outcome: 'visits_cancelled',
          basis: 'full',
          hash: full.hash,
          note: 'Owner cannot host; guest refunded in full.',
          audience: 'everyone',
          requestKey: randomUUID(),
          ...extra,
        });
      await assert.rejects(resolve(admin, { hash: policy.hash }), { code: 'PREVIEW_CHANGED' });
      const resolveKey = randomUUID();
      const done = await resolve(admin, { requestKey: resolveKey });
      assert.equal(done.outcome, 'visits_cancelled');
      assert.equal((await resolve(admin, { requestKey: resolveKey })).replayed, true);
      await assert.rejects(resolve(admin), { code: 'CASE_CHANGED' });
      const states =
        await sql`SELECT id,state,cancelled_by FROM booking WHERE order_id=${held.orderId} ORDER BY item_position`;
      assert.deepEqual(
        states.map((s) => s.state),
        ['cancelled', 'confirmed'],
      );
      assert.equal(
        states[0].cancelled_by,
        null,
        'an admin cancellation is not attributed to the customer or owner',
      );
      assert.equal(
        (await sql`SELECT state FROM booking_order WHERE id=${held.orderId}`)[0].state,
        'confirmed',
      );
      const refundRows =
        await sql`SELECT r.expected_minor,ra.booking_id FROM refund r JOIN refund_allocation ra ON ra.refund_id=r.id`;
      assert.equal(await refunds(), 1);
      assert.ok(refundRows.every((r) => r.booking_id === v1.id));
      assert.equal(
        Number((await sql`SELECT sum(expected_minor)::bigint total FROM refund`)[0].total),
        full.preview.refundMinor,
      );
      assert.equal(
        Number(
          (await sql`SELECT sum(expected_minor)::bigint total FROM refund_allocation`)[0].total,
        ),
        full.preview.refundMinor,
      );
      assert.deepEqual(
        (
          await sql`SELECT booking_id,state FROM inventory_reservation WHERE booking_id IN ${sql([v1.id, v2.id])} ORDER BY state`
        ).map((r) => r.state),
        ['committed', 'released'],
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM notification_outbox WHERE order_id=${held.orderId} AND template='cancellation'`
        )[0].n,
        1,
      );

      // A customer cancellation that lands first makes a case preview stale; still one refund set for v2.
      const caseC = await createBookingCase(sql, admin, {
        orderId: held.orderId,
        type: 'customer_cancellation',
        requesterKind: 'customer',
        source: 'phone',
        visitIds: [v2.id],
        reason: 'Customer phoned to cancel the second visit.',
        requestKey: randomUUID(),
      });
      const staleSoon = await previewCaseResolution(
        sql,
        admin,
        { caseId: caseC.id, basis: 'policy' },
        env,
      );
      assert.equal(staleSoon.preview.orderAfter, 'cancelled');
      const estimate = await previewCancellation(
        sql,
        session,
        { orderId: held.orderId, visitIds: [v2.id] },
        env,
      );
      await commitCancellation(
        sql,
        session,
        {
          orderId: held.orderId,
          visitIds: [v2.id],
          hash: estimate.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        },
        env,
      );
      await assert.rejects(
        resolveBookingCase(sql, admin, {
          caseId: caseC.id,
          expectedVersion: 1,
          outcome: 'visits_cancelled',
          basis: 'policy',
          hash: staleSoon.hash,
          note: 'Cancelling as the customer asked.',
          audience: 'customer',
          requestKey: randomUUID(),
        }),
        { code: 'PREVIEW_CHANGED' },
      );
      assert.equal(await refunds(), 2, 'only the customer cancellation refunded v2');
      const nowNothing = await previewCaseResolution(
        sql,
        admin,
        { caseId: caseC.id, basis: 'policy' },
        env,
      );
      assert.match(nowNothing.preview.visits[0].reason, /Already cancelled/);
      await assert.rejects(
        resolveBookingCase(sql, admin, {
          caseId: caseC.id,
          expectedVersion: 1,
          outcome: 'visits_cancelled',
          basis: 'policy',
          hash: nowNothing.hash,
          note: 'Nothing left to cancel here.',
          audience: 'internal',
          requestKey: randomUUID(),
        }),
        { code: 'NOTHING_TO_CANCEL' },
      );
      // Two admins resolving at once: one winner.
      const race = await Promise.allSettled(
        [admin, second].map((actor) =>
          resolveBookingCase(sql, actor, {
            caseId: caseC.id,
            expectedVersion: 1,
            outcome: 'no_change',
            note: 'Customer already cancelled it themselves.',
            audience: 'customer',
            requestKey: randomUUID(),
          }),
        ),
      );
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'CASE_CHANGED');

      // An unpaid legacy visit: policy cannot apply; full cancels with no refund and releases inventory.
      const caseL = await createBookingCase(sql, admin, {
        orderId: booked.order,
        type: 'customer_cancellation',
        requesterKind: 'customer',
        source: 'support',
        visitIds: [legacy.id],
        reason: 'Legacy booking the customer asked to cancel.',
        requestKey: randomUUID(),
      });
      assert.equal(
        (await previewCaseResolution(sql, admin, { caseId: caseL.id, basis: 'policy' }, env))
          .preview.blocked,
        true,
      );
      const legacyFull = await previewCaseResolution(
        sql,
        admin,
        { caseId: caseL.id, basis: 'full' },
        env,
      );
      assert.deepEqual(
        [legacyFull.preview.refundMinor, legacyFull.preview.visits[0].paid],
        [0, false],
      );
      await resolveBookingCase(sql, admin, {
        caseId: caseL.id,
        expectedVersion: 1,
        outcome: 'visits_cancelled',
        basis: 'full',
        hash: legacyFull.hash,
        note: 'No verified payment existed for this legacy visit.',
        audience: 'customer',
        requestKey: randomUUID(),
      });
      assert.equal(
        (await sql`SELECT state FROM inventory_reservation WHERE booking_id=${legacy.id}`)[0].state,
        'released',
      );
      assert.equal(await refunds(), 2);

      // Change request: availability is checked, never reserved.
      const quotesBefore = (await sql`SELECT count(*)::int n FROM booking_quote`)[0].n;
      const reservationsBefore = (await sql`SELECT count(*)::int n FROM inventory_reservation`)[0]
        .n;
      const caseX = await createBookingCase(sql, admin, {
        orderId: held.orderId,
        type: 'change_request',
        requesterKind: 'customer',
        source: 'email',
        visitIds: [v2.id],
        reason: 'Customer asked to move to a later date.',
        requestedChange: { dates: [d3], slot: 'day', guests: 2 },
        requestKey: randomUUID(),
      });
      const change = await previewCaseResolution(
        sql,
        admin,
        { caseId: caseX.id, basis: 'policy' },
        env,
      );
      assert.equal(change.replacement.available, true);
      assert.equal(change.replacement.reserved, false);
      assert.match(change.replacement.note, /Nothing is reserved/);
      assert.equal((await sql`SELECT count(*)::int n FROM booking_quote`)[0].n, quotesBefore);
      assert.equal(
        (await sql`SELECT count(*)::int n FROM inventory_reservation`)[0].n,
        reservationsBefore,
      );
      await resolveBookingCase(sql, admin, {
        caseId: caseX.id,
        expectedVersion: 1,
        outcome: 'declined',
        note: 'Please book the new date through Book again.',
        audience: 'customer',
        requestKey: randomUUID(),
      });

      // Read models honour audiences.
      const ownerView = await readBookingRecord(sql, owner, held.orderId);
      const ownerCaseA = ownerView.cases.find((c) => c.id === caseA.id);
      assert.equal(ownerCaseA.requestedByYou, true);
      assert.ok(ownerCaseA.updates.every((u) => ['client', 'everyone'].includes(u.audience)));
      assert.ok(ownerCaseA.updates.some((u) => u.author === 'You'));
      assert.equal(
        ownerView.cases.some((c) => c.id === caseX.id),
        false,
        'customer-only change request is not shown to the owner',
      );
      const customerView = await readBookingRecord(
        sql,
        { kind: 'customer', session },
        held.orderId,
      );
      assert.deepEqual(Object.keys(customerView.cases[0]).sort(), [
        'reference',
        'state',
        'updates',
      ]);
      assert.ok(
        customerView.cases
          .flatMap((c) => c.updates)
          .every((u) => ['customer', 'everyone'].includes(u.audience)),
      );
      assert.ok(customerView.cases.some((c) => c.updates.some((u) => /Book again/.test(u.body))));
      const list = await listBookingCases(sql, admin, { state: 'all' });
      assert.equal(list.total, 4);
      assert.equal((await listBookingCases(sql, admin, { state: 'open' })).total, 0);
      const detail = await readBookingCase(sql, admin, caseA.id);
      assert.equal(detail.state, 'resolved');
      assert.equal(detail.cancellation.refundMinor, full.preview.refundMinor);
      assert.ok(detail.updates.some((u) => u.audience === 'internal'));

      // Append-only at the database.
      await assert.rejects(
        sql`UPDATE booking_case SET reason='Rewritten reason for the case.' WHERE id=${caseA.id}`,
      );
      await assert.rejects(
        sql`UPDATE booking_case SET state='open',outcome=NULL,outcome_note=NULL,refund_basis=NULL,cancellation_id=NULL,resolved_at=NULL,resolved_by=NULL,resolve_key=NULL,resolve_hash=NULL,version=version+1 WHERE id=${caseA.id}`,
      );
      await assert.rejects(sql`DELETE FROM booking_case_update WHERE case_id=${caseA.id}`);
      await assert.rejects(
        sql`INSERT INTO booking_case_visit(case_id,booking_id) VALUES (${caseA.id},${v2.id})`,
      );
    } finally {
      await fixture.drop();
    }
  },
);
