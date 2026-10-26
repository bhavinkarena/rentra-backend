import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { allocateByWeights, refundOfPaid } from '../../src/services/domain/booking-money.js';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/** Hotel plan, Phase 10: cancel some rooms, change a stay, stay-worded messages, weekly KPIs. */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_HOTEL10KEY12',
  RAZORPAY_KEY_SECRET: 'hotel10-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'hotel10-disposable-webhook-secret',
};

test(
  'Phase 10: hotel booking flow — partial cancellation, change booking, KPIs',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const dir = await mkdtemp(join(tmpdir(), 'hotel10-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await fixture.drop();
    });
    const { sql } = fixture;
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    Object.assign(process.env, {
      RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
    });
    const { createStayQuote } = await import('@/services/booking/hotel-checkout.js');
    const { createCheckoutHold, ownedCheckout } = await import('@/services/booking/checkout.js');
    const { startCheckoutPayment, verifyCheckoutPayment } =
      await import('@/services/payments/checkout-service.js');
    const { setPaymentGatewayConfiguration } =
      await import('@/services/payments/gateway-settings.js');
    const { previewCancellation, commitCancellation, estimateCancellation, applyCancellation } =
      await import('@/services/booking/cancellation.js');
    const { previewHotelCancellation } = await import('@/services/booking/hotel-stays.js');
    const { getAdminHotelAnalytics } = await import('@/services/analytics/hotel-analytics.js');
    const { notificationMessage } = await import('@/services/domain/notifications.js');

    const h = await seedHotel(sql, { deluxeRooms: 5 });
    await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
    await setPaymentGatewayConfiguration(
      sql,
      {
        actorId: h.admin,
        expectedVersion: 0,
        provider: 'razorpay',
        environment: 'test',
        enabled: true,
        collectionPurpose: 'full',
      },
      env,
    );
    const providerFile = join(dir, 'provider.json');
    const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
    const customer = await seedCustomer(sql);
    const [row] =
      await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${customer},now()+interval '1 day') RETURNING id`;
    const session = { role: 'customer', userId: customer, sessionId: row.id };
    const roomsOf = (count, plan) =>
      Array.from({ length: count }, () => ({
        roomTypeId: h.deluxe,
        ratePlanId: plan,
        adults: 2,
        childAges: [],
      }));
    async function pay(input) {
      const quote = await createStayQuote(
        sql,
        { rentableId: h.hotel, ...input },
        { customerId: customer },
      );
      const held = await createCheckoutHold(
        sql,
        session,
        {
          rentableId: h.hotel,
          quoteId: quote.id,
          hash: quote.hash,
          version: quote.version,
          idempotencyKey: randomUUID(),
          accepted: true,
          stay: { guestNames: input.rooms.map((_, i) => `Guest ${i + 1}`) },
        },
        env,
      );
      const started = await startCheckoutPayment(sql, session, held.orderId, opts);
      const paymentId = `pay_H10${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      providerCaptures(providerFile, started.providerOrderId, paymentId);
      await verifyCheckoutPayment(
        sql,
        session,
        {
          orderId: held.orderId,
          paymentId,
          signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET)
            .update(`${started.providerOrderId}|${paymentId}`)
            .digest('hex'),
        },
        opts,
      );
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
      return { quote, orderId: held.orderId, visitId: visit.id };
    }
    const checkIn = addLocalDays(propertyToday(), 20);

    await t.test(
      'cancel one room of a two-room stay: that room is refunded and released, the stay stays booked',
      async () => {
        const stay = await pay({
          checkIn,
          checkOut: addLocalDays(checkIn, 2),
          rooms: roomsOf(2, h.deluxeBase),
        });
        const rooms =
          await sql`SELECT id, (amount_room_minor + amount_tax_minor)::int AS total FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
        const preview = await previewCancellation(
          sql,
          session,
          { orderId: stay.orderId, visitIds: [stay.visitId], roomIds: [rooms[0].id] },
          env,
        );
        // Story 2.2: each room refund also returns its share of the guest service fee.
        const feeShare = Math.floor(
          (stay.quote.totals.feeMinor * rooms[0].total) / (rooms[0].total + rooms[1].total),
        );
        assert.equal(
          preview.refundMinor,
          rooms[0].total + feeShare,
          JSON.stringify(preview.visits),
        );
        await commitCancellation(
          sql,
          session,
          {
            orderId: stay.orderId,
            visitIds: [stay.visitId],
            roomIds: [rooms[0].id],
            hash: preview.hash,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        );
        const states =
          await sql`SELECT id, state FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
        assert.deepEqual(
          states.map((r) => r.state),
          ['released', 'booked'],
        );
        const [visit] = await sql`SELECT state FROM booking WHERE id=${stay.visitId}`;
        assert.equal(visit.state, 'confirmed');
        const [{ held }] =
          await sql`SELECT (sold + held)::int AS held FROM room_night WHERE room_type_id=${h.deluxe} AND night=${checkIn}`;
        assert.equal(held, 1, 'the cancelled room is back on sale');
        // The last room cancels the whole stay.
        const rest = await previewCancellation(
          sql,
          session,
          { orderId: stay.orderId, visitIds: [stay.visitId] },
          env,
        );
        assert.equal(
          rest.refundMinor,
          rooms[1].total + stay.quote.totals.feeMinor - feeShare,
          'the rest of the fee, nothing stranded',
        );
      },
    );

    const policy = (pct, after = 0) => ({
      version: 1,
      windows: [{ hoursBefore: 0, pct }],
      atOrAfterCheckInPct: after,
      earlyDeparture: { offered: false, pct: 0 },
    });
    const scope = (stay, ids) => ({
      orderId: stay.orderId,
      visitIds: [stay.visitId],
      ...(ids ? { roomIds: ids } : {}),
    });
    const confirm = (input, preview, extra = {}) =>
      commitCancellation(
        sql,
        session,
        { ...input, hash: preview.hash, idempotencyKey: randomUUID(), accepted: true, ...extra },
        env,
      );
    async function mixedStay(offset, after = 0) {
      await sql`UPDATE rate_plan SET cancellation_policy=${JSON.stringify(policy(50, after))}::text::jsonb WHERE id=${h.deluxeBreakfast}`;
      const date = addLocalDays(checkIn, offset);
      const stay = await pay({
        checkIn: date,
        checkOut: addLocalDays(date, 2),
        rooms: [
          ...roomsOf(1, h.deluxeBreakfast),
          ...roomsOf(1, h.deluxeNonRefundable),
          ...roomsOf(1, h.deluxeBase),
        ],
      });
      const lines =
        await sql`SELECT * FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
      return {
        ...stay,
        date,
        lines,
        half: lines.find((r) => r.rate_plan_id === h.deluxeBreakfast),
        zero: lines.find((r) => r.rate_plan_id === h.deluxeNonRefundable),
        retained: lines.find((r) => r.rate_plan_id === h.deluxeBase),
      };
    }

    await t.test(
      'mixed booked policies, scope refusals, racing replay and retained snapshots/inventory',
      async () => {
        const stay = await mixedStay(60);
        const input = scope(stay, [stay.half.id, stay.zero.id]);
        const fees = allocateByWeights(
          stay.quote.totals.feeMinor,
          stay.lines.map((r) => Number(r.amount_room_minor)),
        );
        const expected = refundOfPaid(
          {
            rent: Number(stay.half.amount_room_minor),
            tax: Number(stay.half.amount_tax_minor),
            fee: fees[stay.lines.findIndex((r) => r.id === stay.half.id)],
          },
          50,
        );
        // Owner edits after booking cannot rewrite any booked room's terms.
        await sql`UPDATE rate_plan SET cancellation_policy=${JSON.stringify(policy(100))}::text::jsonb WHERE id=${h.deluxeBreakfast}`;
        const preview = await previewCancellation(sql, session, input, env);
        assert.equal(preview.refundMinor, expected.rent + expected.tax + expected.fee);
        assert.deepEqual(
          [preview.visits[0].rent, preview.visits[0].tax, preview.visits[0].fee],
          [expected.rent, expected.tax, expected.fee],
        );
        const stranger = await seedCustomer(sql);
        const [auth] =
          await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${stranger},now()+interval '1 day') RETURNING id`;
        await assert.rejects(
          previewCancellation(
            sql,
            { role: 'customer', userId: stranger, sessionId: auth.id },
            input,
            env,
          ),
          { code: 'CHECKOUT_NOT_FOUND' },
        );
        const [foreign] =
          await sql`SELECT id FROM booking_room WHERE booking_id<>${stay.visitId} AND state='booked' LIMIT 1`;
        await assert.rejects(previewCancellation(sql, session, scope(stay, [foreign.id]), env), {
          code: 'ROOM_NOT_CANCELLABLE',
        });
        await assert.rejects(previewCancellation(sql, session, scope(stay, [randomUUID()]), env), {
          code: 'ROOM_NOT_CANCELLABLE',
        });
        await assert.rejects(
          previewCancellation(
            sql,
            session,
            { ...input, visitIds: [stay.visitId, randomUUID()] },
            env,
          ),
          { code: 'ROOMS_NEED_ONE_STAY' },
        );
        const [before] =
          await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE id=${stay.retained.id}`;
        const command = {
          ...input,
          hash: preview.hash,
          idempotencyKey: randomUUID(),
          accepted: true,
        };
        const receipts = await Promise.all([
          commitCancellation(sql, session, command, env),
          commitCancellation(sql, session, command, env),
        ]);
        assert.deepEqual(receipts[0], receipts[1]);
        assert.equal(receipts[0].actualBankRefundMinor, 0);
        await assert.rejects(
          commitCancellation(sql, session, { ...command, reason: 'different payload' }, env),
          { code: 'IDEMPOTENCY_CONFLICT' },
        );
        await assert.rejects(previewCancellation(sql, session, input, env), {
          code: 'ROOM_NOT_CANCELLABLE',
        });
        const [after] =
          await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE id=${stay.retained.id}`;
        assert.deepEqual(
          after.snapshot,
          before.snapshot,
          'retained dates, amounts, terms and all other room fields stay equal',
        );
        const nights =
          await sql`SELECT sold, held FROM room_night WHERE room_type_id=${h.deluxe} AND night>=${stay.date} AND night<${addLocalDays(stay.date, 2)}`;
        assert.equal(nights.length, 2);
        nights.forEach((n) => assert.deepEqual([n.sold, n.held], [1, 0]));
        const [{ count }] =
          await sql`SELECT count(*)::int count FROM booking_cancellation WHERE order_id=${stay.orderId}`;
        assert.equal(count, 1);
        const rest = await previewCancellation(sql, session, scope(stay), env);
        const retainedFee = fees[stay.lines.findIndex((r) => r.id === stay.retained.id)];
        assert.equal(
          rest.refundMinor,
          Number(stay.retained.amount_room_minor) +
            Number(stay.retained.amount_tax_minor) +
            retainedFee,
          'attributable earlier reservations do not consume retained entitlement',
        );
        await confirm(scope(stay), rest);
        await assert.rejects(
          previewHotelCancellation(sql, stay.visitId, new Date(), [stay.retained.id]),
          { code: 'ROOM_NOT_CANCELLABLE' },
        );
        await assert.rejects(
          previewCancellation(sql, session, scope(stay, [stay.retained.id]), env),
          { code: 'ROOM_NOT_CANCELLABLE' },
        );
        const [{ excess }] =
          await sql`SELECT count(*)::int excess FROM payment_allocation a WHERE a.booking_id=${stay.visitId} AND a.actual_minor < (SELECT coalesce(sum(ra.expected_minor),0) FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id WHERE ra.payment_allocation_id=a.id AND r.state<>'failed')`;
        assert.equal(excess, 0);
      },
    );

    await t.test(
      'zero-due selected room releases only its stock, creates no refund and rejects stale/overlapping commands',
      async () => {
        const stay = await mixedStay(65);
        const input = scope(stay, [stay.zero.id]);
        const preview = await previewCancellation(sql, session, input, env);
        assert.equal(preview.refundMinor, 0);
        const stale = await previewCancellation(sql, session, scope(stay, [stay.half.id]), env);
        await sql`UPDATE booking SET lifecycle_version=lifecycle_version+1 WHERE id=${stay.visitId}`;
        await assert.rejects(confirm(scope(stay, [stay.half.id]), stale), {
          code: 'CANCELLATION_CHANGED',
        });
        const fresh = await previewCancellation(sql, session, input, env);
        const competing = await Promise.allSettled([confirm(input, fresh), confirm(input, fresh)]);
        assert.equal(competing.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          competing.find((r) => r.status === 'rejected').reason.code,
          'ROOM_NOT_CANCELLABLE',
        );
        const receipt = competing.find((r) => r.status === 'fulfilled').value;
        assert.deepEqual(receipt.refundIds, []);
        assert.equal(receipt.refundMinor, 0);
        const [{ count }] =
          await sql`SELECT count(*)::int count FROM refund_allocation WHERE booking_id=${stay.visitId}`;
        assert.equal(count, 0);
        const nights =
          await sql`SELECT sold FROM room_night WHERE room_type_id=${h.deluxe} AND night>=${stay.date} AND night<${addLocalDays(stay.date, 2)}`;
        nights.forEach((n) => assert.equal(n.sold, 2));
      },
    );

    await t.test(
      'unattributed historical reservation requires admin resolution without mutation',
      async () => {
        const stay = await mixedStay(70);
        const [source] =
          await sql`SELECT * FROM payment_allocation WHERE booking_id=${stay.visitId} AND component='rent'`;
        await sql.begin(async (tx) => {
          const [refund] =
            await tx`INSERT INTO refund(transaction_id,reference,provider,environment,mode,currency,expected_minor,reason,idempotency_key,request_hash)
      VALUES(${source.transaction_id},${'HISTORY_' + randomUUID()},'razorpay','test','real','INR',100,'Historical refund',${randomUUID()},${'a'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor) VALUES(${refund.id},${source.id},${stay.visitId},'rent',100)`;
        });
        await assert.rejects(previewCancellation(sql, session, scope(stay, [stay.half.id]), env), {
          code: 'REFUND_ATTRIBUTION_REQUIRED',
        });
        const states = await sql`SELECT state FROM booking_room WHERE booking_id=${stay.visitId}`;
        assert.ok(states.every((r) => r.state === 'booked'));
        const [{ count }] =
          await sql`SELECT count(*)::int count FROM booking_cancellation WHERE order_id=${stay.orderId}`;
        assert.equal(count, 0);
        await sql`UPDATE refund SET state='failed' WHERE transaction_id=${source.transaction_id}`;
        const afterFailure = await previewCancellation(
          sql,
          session,
          scope(stay, [stay.half.id]),
          env,
        );
        assert.equal(
          afterFailure.refundMinor,
          afterFailure.visits[0].rent + afterFailure.visits[0].tax + afterFailure.visits[0].fee,
          'failed unattributed refunds consume no captured capacity and do not require attribution',
        );
        await confirm(scope(stay, [stay.half.id]), afterFailure);
      },
    );

    await t.test(
      'positive booked at/after percentage works for selected and whole stay; unaffected zero/legacy rooms do not block it',
      async () => {
        const stay = await mixedStay(75, 40);
        const beforeStart = await previewCancellation(
          sql,
          session,
          scope(stay, [stay.half.id]),
          env,
        );
        assert.equal(beforeStart.visits[0].startedAtEstimate, false);
        // Establish an already-started fixture; production accepted dates remain immutable.
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
          await tx`UPDATE booking SET starts_at=now()-interval '1 hour', blocked_start_at=now()-interval '1 hour' WHERE id=${stay.visitId}`;
          await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
        });
        const input = scope(stay, [stay.half.id]);
        const preview = await previewCancellation(sql, session, input, env);
        assert.equal(preview.visits[0].roomDetails[0].pct, 40);
        assert.equal(preview.visits[0].startedAtEstimate, true);
        assert.notEqual(preview.hash, beforeStart.hash);
        await confirm(input, preview);
        await assert.rejects(previewCancellation(sql, session, scope(stay, [stay.zero.id]), env), {
          code: 'STAY_STARTED',
        });
        const wholeDate = addLocalDays(checkIn, 80);
        const whole = await pay({
          checkIn: wholeDate,
          checkOut: addLocalDays(wholeDate, 2),
          rooms: roomsOf(1, h.deluxeBreakfast),
        });
        const beforeWholeStart = await previewCancellation(sql, session, scope(whole), env);
        assert.equal(beforeWholeStart.visits[0].startedAtEstimate, false);
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
          await tx`UPDATE booking SET starts_at=now()-interval '1 hour', blocked_start_at=now()-interval '1 hour' WHERE id=${whole.visitId}`;
          await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
        });
        const wholePreview = await previewCancellation(sql, session, scope(whole), env);
        assert.equal(wholePreview.visits[0].roomDetails[0].pct, 40);
        assert.equal(wholePreview.visits[0].startedAtEstimate, true);
        await confirm(scope(whole), wholePreview);
        const [booking] = await sql`SELECT state FROM booking WHERE id=${whole.visitId}`;
        assert.equal(booking.state, 'cancelled');
      },
    );

    await t.test(
      'legacy room snapshots keep partial fee scope and refuse cancellation after check-in',
      async () => {
        const date = addLocalDays(checkIn, 85);
        const stay = await pay({
          checkIn: date,
          checkOut: addLocalDays(date, 2),
          rooms: roomsOf(2, h.deluxeBase),
        });
        // Establish a historical pre-window snapshot on this disposable database only.
        await sql`UPDATE booking_room SET plan_snapshot=plan_snapshot-'cancellationPolicy' WHERE booking_id=${stay.visitId}`;
        const lines =
          await sql`SELECT id, (amount_room_minor + amount_tax_minor)::int total FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
        const input = scope(stay, [lines[0].id]);
        const preview = await previewCancellation(sql, session, input, env);
        assert.equal(
          preview.refundMinor,
          lines[0].total + Math.floor(stay.quote.totals.feeMinor / 2),
        );
        assert.deepEqual(preview.visits[0].roomDetails, [
          {
            id: lines[0].id,
            rule: 'free',
            freeCancelHours: 48,
            refundMinor: lines[0].total,
            chargeMinor: 0,
          },
        ]);
        await confirm(input, preview);
        await sql`UPDATE booking_room SET plan_snapshot=jsonb_set(plan_snapshot,'{freeCancelHours}','null'::jsonb) WHERE id=${lines[1].id}`;
        const late = await previewCancellation(sql, session, scope(stay, [lines[1].id]), env);
        assert.equal(late.visits[0].roomDetails[0].rule, 'first_night');
        assert.ok(late.visits[0].roomDetails[0].chargeMinor > 0);
        assert.equal(
          late.visits[0].roomDetails[0].chargeMinor + late.visits[0].roomDetails[0].refundMinor,
          lines[1].total,
        );
        await sql.begin(async (tx) => {
          await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
          await tx`UPDATE booking SET starts_at=now()-interval '1 hour', blocked_start_at=now()-interval '1 hour' WHERE id=${stay.visitId}`;
          await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
        });
        await assert.rejects(previewCancellation(sql, session, scope(stay, [lines[1].id]), env), {
          code: 'STAY_STARTED',
        });
      },
    );

    await t.test(
      'a pre-check-in estimate cannot release partial or whole inventory after crossing check-in',
      async () => {
        const stay = await mixedStay(90);
        for (const ids of [[stay.half.id], null]) {
          const value = scope(stay, ids);
          await assert.rejects(
            ownedCheckout(
              sql,
              session,
              stay.orderId,
              async (tx, order) => {
                const preview = await estimateCancellation(tx, order, value);
                assert.equal(preview.visits[0].startedAtEstimate, false);
                // Cross the clock between estimate and mutation on this disposable fixture.
                await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
                await tx`UPDATE booking SET starts_at=now()-interval '1 hour', blocked_start_at=now()-interval '1 hour' WHERE id=${stay.visitId}`;
                await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
                await applyCancellation(tx, order, preview, value, {
                  actorKind: 'customer',
                  reason: 'Clock crossing',
                  idempotencyKey: randomUUID(),
                  requestHash: preview.hash,
                  customerId: customer,
                });
              },
              env,
            ),
            { code: 'CANCELLATION_CHANGED' },
          );
        }
        const states = await sql`SELECT state FROM booking_room WHERE booking_id=${stay.visitId}`;
        assert.ok(states.every((room) => room.state === 'booked'));
        const [{ count }] =
          await sql`SELECT count(*)::int count FROM refund_allocation WHERE booking_id=${stay.visitId}`;
        assert.equal(count, 0, 'rolled-back cutoff refusals create no refund obligation');
      },
    );

    await t.test(
      'distinct room confirmations share captured capacity without changing the retained room',
      async () => {
        const date = addLocalDays(checkIn, 95);
        const stay = await pay({
          checkIn: date,
          checkOut: addLocalDays(date, 2),
          rooms: roomsOf(3, h.deluxeBase),
        });
        const lines =
          await sql`SELECT * FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
        const [before] =
          await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE id=${lines[2].id}`;
        const values = lines.slice(0, 2).map((room) => scope(stay, [room.id]));
        const previews = await Promise.all(
          values.map((value) => previewCancellation(sql, session, value, env)),
        );
        const receipts = await Promise.all(
          values.map((value, index) => confirm(value, previews[index])),
        );
        const fees = allocateByWeights(
          stay.quote.totals.feeMinor,
          lines.map((room) => Number(room.amount_room_minor)),
        );
        receipts.forEach((receipt, index) => {
          assert.deepEqual(receipt.visits[0].roomIds, [lines[index].id]);
          assert.equal(
            receipt.refundMinor,
            Number(lines[index].amount_room_minor) +
              Number(lines[index].amount_tax_minor) +
              fees[index],
          );
        });
        const [after] =
          await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE id=${lines[2].id}`;
        assert.deepEqual(after.snapshot, before.snapshot);
        const states =
          await sql`SELECT state FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
        assert.deepEqual(
          states.map((room) => room.state),
          ['released', 'released', 'booked'],
        );
        const nights =
          await sql`SELECT sold,held FROM room_night WHERE room_type_id=${h.deluxe} AND night>=${date} AND night<${addLocalDays(date, 2)}`;
        assert.equal(nights.length, 2);
        nights.forEach((night) => assert.deepEqual([night.sold, night.held], [1, 0]));
        const captures =
          await sql`SELECT a.actual_minor, coalesce(sum(ra.expected_minor) FILTER (WHERE r.state<>'failed'),0)::bigint reserved FROM payment_allocation a LEFT JOIN refund_allocation ra ON ra.payment_allocation_id=a.id LEFT JOIN refund r ON r.id=ra.refund_id WHERE a.booking_id=${stay.visitId} GROUP BY a.id`;
        captures.forEach((source) =>
          assert.ok(Number(source.reserved) <= Number(source.actual_minor)),
        );
        const [{ total }] =
          await sql`SELECT sum(ra.expected_minor)::int total FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id WHERE ra.booking_id=${stay.visitId} AND r.state<>'failed'`;
        assert.equal(
          total,
          receipts.reduce((sum, receipt) => sum + receipt.refundMinor, 0),
        );
      },
    );

    await t.test(
      'change dates: new stay paid, old stay cancelled and refunded in full',
      async () => {
        const old = await pay({
          checkIn: addLocalDays(checkIn, 5),
          checkOut: addLocalDays(checkIn, 7),
          rooms: roomsOf(1, h.deluxeBase),
        });
        const moved = await pay({
          checkIn: addLocalDays(checkIn, 10),
          checkOut: addLocalDays(checkIn, 13),
          rooms: roomsOf(1, h.deluxeBase),
          replacesOrderId: old.orderId,
        });
        const [before] = await sql`SELECT state FROM booking_order WHERE id=${old.orderId}`;
        assert.equal(before.state, 'cancelled');
        const [{ refunded }] =
          await sql`SELECT sum(ra.expected_minor)::int AS refunded FROM refund_allocation ra WHERE ra.booking_id=${old.visitId}`;
        assert.equal(refunded, old.quote.totals.totalMinor);
        const [after] = await sql`SELECT state FROM booking_order WHERE id=${moved.orderId}`;
        assert.equal(after.state, 'confirmed');
        const [reason] = await sql`SELECT cancellation_reason FROM booking WHERE id=${old.visitId}`;
        assert.match(reason.cancellation_reason, /^Changed to booking /);
      },
    );

    await t.test('a non-refundable stay cannot be changed for free', async () => {
      const strict = await pay({
        checkIn: addLocalDays(checkIn, 30),
        checkOut: addLocalDays(checkIn, 31),
        rooms: roomsOf(1, h.deluxeNonRefundable),
      });
      await assert.rejects(
        createStayQuote(
          sql,
          {
            rentableId: h.hotel,
            checkIn: addLocalDays(checkIn, 40),
            checkOut: addLocalDays(checkIn, 41),
            rooms: roomsOf(1, h.deluxeBase),
            replacesOrderId: strict.orderId,
          },
          { customerId: customer },
        ),
        { code: 'CHANGE_NOT_ALLOWED' },
      );
      const stranger = await seedCustomer(sql);
      await assert.rejects(
        createStayQuote(
          sql,
          {
            rentableId: h.hotel,
            checkIn: addLocalDays(checkIn, 40),
            checkOut: addLocalDays(checkIn, 41),
            rooms: roomsOf(1, h.deluxeBase),
            replacesOrderId: strict.orderId,
          },
          { customerId: stranger },
        ),
        { code: 'CHANGE_NOT_ALLOWED' },
      );
    });

    await t.test('stay messages use stay words', () => {
      assert.match(
        notificationMessage({
          template: 'review_invitation',
          reference: 'R1',
          id: 'x',
          is_stay: true,
          visit_provenance: 'real',
        }),
        /How was your stay\?/,
      );
      assert.match(
        notificationMessage({
          template: 'review_invitation',
          reference: 'R1',
          id: 'x',
          visit_provenance: 'real',
        }),
        /How was your visit\?/,
      );
    });

    await t.test('weekly KPIs: quotes, paid, guest cancellations', async () => {
      const report = await getAdminHotelAnalytics(sql, h.admin, {
        from: addLocalDays(propertyToday(), -1),
        to: addLocalDays(propertyToday(), 60),
      });
      assert.ok(
        report.weekly.quotes >= 4 && report.weekly.paid >= 4,
        JSON.stringify(report.weekly),
      );
      assert.ok(report.weekly.guestCancelled >= 1);
      assert.ok(report.weekly.holdToPaid > 0);
    });
  },
);
