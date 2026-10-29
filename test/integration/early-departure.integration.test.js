import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase, migrateWithDrizzle } from '../helpers/disposable-db.js';
import { seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { allocateByWeights } from '../../src/services/domain/booking-money.js';
import {
  addLocalDays,
  propertyToday,
  propertyLocalInstant,
} from '../../src/services/domain/booking-dates.js';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_HOTEL11KEY12',
  RAZORPAY_KEY_SECRET: 'local-departure-key',
  RAZORPAY_WEBHOOK_SECRET: 'local-departure-hook',
};
const policy = (offered, pct) => ({
  version: 1,
  windows: [{ hoursBefore: 0, pct: 100 }],
  atOrAfterCheckInPct: 40,
  earlyDeparture: { offered, pct },
});
test(
  'Story 2.11: explicit scoped early departure',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL, {
      through: '0075_cancellation_policy',
    });
    const dir = await mkdtemp(join(tmpdir(), 'hotel11-'));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
      await fixture.drop();
    });
    const { sql } = fixture;
    // Current admission code runs on the 0075 schema first; stub the 0083 rule until migration.
    await sql`CREATE FUNCTION owner_repayment_overdue(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'`;
    // ...and the 0084 room-promise columns.
    await sql.unsafe(`ALTER TABLE room_type ADD COLUMN IF NOT EXISTS extra_places jsonb NOT NULL DEFAULT '[]'; ALTER TABLE rate_plan ADD COLUMN IF NOT EXISTS inclusions jsonb;
      ALTER TABLE booking_room ADD COLUMN IF NOT EXISTS room_snapshot jsonb`);
    globalThis.__rentraSql = sql;
    Object.assign(process.env, {
      DATABASE_URL: fixture.url,
      RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
    });
    const { createStayQuote } = await import('@/services/booking/hotel-checkout.js');
    const { createCheckoutHold } = await import('@/services/booking/checkout.js');
    const { startCheckoutPayment, verifyCheckoutPayment } =
      await import('@/services/payments/checkout-service.js');
    const { setPaymentGatewayConfiguration } =
      await import('@/services/payments/gateway-settings.js');
    const { previewCancellation, commitCancellation } =
      await import('@/services/booking/cancellation.js');
    const { readBookingRecord, listBookingRecords } = await import('@/services/booking/records.js');
    const { ownerDayVisits } = await import('@/services/booking/owner-visits.js');
    const { getOwnerHotelAnalytics, getAdminHotelAnalytics } =
      await import('@/services/analytics/hotel-analytics.js');
    const { getOwnerHotelEarnings, previewPayoutRun, executePayoutRun } =
      await import('@/services/finance/hotel-payouts.js');
    const { listStaffVisits, readStaffVisitRecord } =
      await import('@/services/booking/staff-visits.js');
    const { reconcileRefund } = await import('@/services/payments/refunds.js');
    const { bookingSummary } = await import('@/services/domain/booking-record.js');
    const { earlyDepartureRoom } = await import('@/services/domain/early-departure.js');
    const { recordVisitTransition } = await import('@/services/booking/visit-lifecycle.js');
    const h = await seedHotel(sql, { deluxeRooms: 500 });
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
    await sql`UPDATE hotel_profile SET check_in_minute=840 WHERE rentable_id=${h.hotel}`;
    let offset = 20;
    const future = async (count = 3) => {
      const date = addLocalDays(propertyToday(), offset);
      offset += 5;
      return pay({
        checkIn: date,
        checkOut: addLocalDays(date, 4),
        rooms: roomsOf(count, h.deluxeBase),
      });
    };
    const preserved = await future(1);
    const beforeMigration = (
      await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE booking_id=${preserved.visitId}`
    )[0].snapshot;
    const originalStock = await sql`SELECT * FROM room_night ORDER BY night`;
    const journal = JSON.parse(
      await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    await sql`DROP FUNCTION owner_repayment_overdue(uuid)`;
    await migrateWithDrizzle(fixture.url, journal.entries[75].when);
    assert.deepEqual(
      (
        await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE booking_id=${preserved.visitId}`
      )[0].snapshot,
      { ...beforeMigration, departed_at: null, inventory_end: null },
    );
    assert.deepEqual(await sql`SELECT * FROM room_night ORDER BY night`, originalStock);
    const input = (stay, ids) => ({
      orderId: stay.orderId,
      visitIds: [stay.visitId],
      operation: 'early_departure',
      ...(ids ? { roomIds: ids } : {}),
    });
    const confirm = (value, preview, key = randomUUID()) =>
      commitCancellation(
        sql,
        session,
        { ...value, hash: preview.hash, idempotencyKey: key, accepted: true },
        env,
      );
    const stock = () =>
      sql`SELECT night::text,sold,held FROM room_night WHERE room_type_id=${h.deluxe} ORDER BY night`;
    async function begun(count = 3, offer = policy(true, 50), daysAgo = 1) {
      const stay = await future(count),
        date = addLocalDays(propertyToday(), -daysAgo),
        out = addLocalDays(date, 4);
      const lines =
        await sql`SELECT * FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`;
      // Only this disposable fixture moves accepted dates and corresponding stock.
      await sql.begin(async (tx) => {
        await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
        await tx`ALTER TABLE booking_room DISABLE TRIGGER booking_room_inventory`;
        await tx`UPDATE room_night SET sold=sold-${count} WHERE room_type_id=${h.deluxe} AND night>=${lines[0].check_in} AND night<${lines[0].check_out}`;
        for (const row of lines) {
          const nights = row.nights.map((n, i) => ({ ...n, night: addLocalDays(date, i) }));
          await tx`UPDATE booking_room SET check_in=${date},check_out=${out},nights=${JSON.stringify(nights)}::text::jsonb,plan_snapshot=jsonb_set(plan_snapshot,'{cancellationPolicy}',${JSON.stringify(offer)}::text::jsonb) WHERE id=${row.id}`;
        }
        await tx`INSERT INTO room_night(room_type_id,night,allotment,sold) SELECT ${h.deluxe},d::date,500,${count} FROM generate_series(${date}::date,${out}::date-1,interval '1 day') d ON CONFLICT(room_type_id,night) DO UPDATE SET sold=room_night.sold+excluded.sold`;
        await tx`UPDATE booking SET local_day=${date},starts_at=${propertyLocalInstant(date, '14:00')},ends_at=${propertyLocalInstant(out, '11:00')},blocked_start_at=${propertyLocalInstant(date, '14:00')},blocked_end_at=${propertyLocalInstant(out, '11:00')},slot_snapshot=slot_snapshot || ${JSON.stringify({ checkIn: date, checkOut: out })}::text::jsonb WHERE id=${stay.visitId}`;
        await tx`ALTER TABLE booking_room ENABLE TRIGGER booking_room_inventory`;
        await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
      });
      return {
        ...stay,
        date,
        out,
        lines:
          await sql`SELECT *,check_in::text AS arrival,check_out::text AS checkout FROM booking_room WHERE booking_id=${stay.visitId} ORDER BY id`,
      };
    }
    await t.test(
      'mixed offers, retained original snapshots, strictly unused stock, exact money, replay and history',
      async () => {
        const stay = await begun();
        await sql`UPDATE booking_room SET plan_snapshot=jsonb_set(plan_snapshot,'{cancellationPolicy}',${JSON.stringify(policy(false, 100))}::text::jsonb) WHERE id=${stay.lines[1].id}`;
        const ids = stay.lines.slice(0, 2).map((r) => r.id),
          value = input(stay, ids);
        const beforeStock = await stock(),
          before = (
            await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE id=${stay.lines[2].id}`
          )[0].snapshot;
        const preview = await previewCancellation(sql, session, value, env);
        assert.deepEqual(await stock(), beforeStock, 'preview has no stock side effect');
        assert.equal(
          (
            await sql`SELECT count(*)::int n FROM refund_allocation WHERE booking_id=${stay.visitId}`
          )[0].n,
          0,
        );
        const fees = allocateByWeights(
            stay.quote.totals.feeMinor,
            stay.lines.map((r) => Number(r.amount_room_minor)),
          ),
          r = stay.lines[0];
        const exact = earlyDepartureRoom(
          {
            checkIn: r.arrival,
            checkOut: r.checkout,
            nights: r.nights,
            rent: Number(r.amount_room_minor),
            tax: Number(r.amount_tax_minor),
            fee: fees[0],
            policy: policy(true, 50),
            checkInMinute: 840,
            timeZone: 'Asia/Kolkata',
          },
          preview.requestedAt,
        );
        assert.deepEqual(preview.visits[0].roomDetails[0].refund, exact.refund);
        const key = randomUUID(),
          receipt = await confirm(value, preview, key);
        assert.equal(receipt.operation, 'early_departure');
        assert.deepEqual(await confirm(value, preview, key), receipt);
        const { operation: _operation, ...normal } = value;
        await assert.rejects(confirm(normal, preview, key), { code: 'IDEMPOTENCY_CONFLICT' });
        assert.deepEqual(
          (
            await sql`SELECT to_jsonb(br) snapshot FROM booking_room br WHERE id=${stay.lines[2].id}`
          )[0].snapshot,
          before,
        );
        const afterStock = await stock();
        for (const n of beforeStock)
          assert.equal(
            afterStock.find((x) => x.night === n.night).sold,
            n.sold - (exact.unusedNights.includes(n.night) ? 2 : 0),
          );
        const record = await readBookingRecord(
          sql,
          { kind: 'customer', session },
          stay.orderId,
          env,
        );
        assert.equal(record.stay.rooms.filter((r) => r.departedAt).length, 2);
        assert.match(bookingSummary(record), /Ended early:/);
        assert.equal(
          (
            await sql`SELECT count(*)::int n FROM visit_evidence WHERE booking_id=${stay.visitId}`
          )[0].n,
          0,
        );
        const [notice] =
          await sql`SELECT action,detail FROM client_update WHERE order_id=${stay.orderId} AND action='rooms_departed_early'`;
        assert.equal(notice.detail.rooms, 2);
        assert.deepEqual(notice.detail.roomIds, ids);
        const day = await ownerDayVisits(sql, h.owner, { date: propertyToday() });
        assert.match(day.items.find((x) => x.visitId === stay.visitId).rooms, /1 ×/);
        assert.equal(day.items.find((x) => x.visitId === stay.visitId).guests, 2);
        const lastPreview = await previewCancellation(
          sql,
          session,
          input(stay, [stay.lines[2].id]),
          env,
        );
        assert.ok(lastPreview.visits[0].priorReserved.rent > 0);
        await confirm(input(stay, [stay.lines[2].id]), lastPreview);
        assert.equal(
          (await sql`SELECT state FROM booking WHERE id=${stay.visitId}`)[0].state,
          'completed',
        );
        for (const actor of [
          { kind: 'customer', session },
          { kind: 'owner', id: h.owner },
          { kind: 'admin', id: h.admin },
        ])
          assert.ok(
            (await listBookingRecords(sql, actor, { tab: 'past' }, env)).items.some(
              (x) => x.id === stay.orderId,
            ),
          );
        const stats = await getOwnerHotelAnalytics(sql, h.owner, { from: stay.date, to: stay.out });
        assert.equal(stats.daily.find((d) => d.date === stay.date).roomsSold, 3);
        for (const night of exact.unusedNights)
          assert.equal(stats.daily.find((d) => d.date === night).roomsSold, 0);
        const unchanged = await stock();
        await sql`UPDATE booking_room SET updated_at=clock_timestamp() WHERE booking_id=${stay.visitId}`;
        assert.deepEqual(await stock(), unchanged);
        await assert.rejects(
          sql`UPDATE booking_room SET inventory_end=check_out WHERE id=${ids[0]}`,
          { code: '23514' },
        );
        await assert.rejects(sql`UPDATE booking_room SET state='released' WHERE id=${ids[0]}`, {
          code: '23514',
        });
        await assert.rejects(previewCancellation(sql, session, input(stay), env), {
          code: 'EARLY_DEPARTURE_UNAVAILABLE',
        });
      },
    );
    await t.test(
      'zero/no offer and no unused nights explicitly end occupancy without creating refunds',
      async () => {
        for (const offer of [policy(false, 100), policy(true, 0)]) {
          const stay = await begun(1, offer),
            value = input(stay),
            preview = await previewCancellation(sql, session, value, env);
          assert.equal(preview.refundMinor, 0);
          const receipt = await confirm(value, preview);
          assert.deepEqual(receipt.refundIds, []);
          assert.equal(
            (await sql`SELECT state FROM booking WHERE id=${stay.visitId}`)[0].state,
            'completed',
          );
        }
      },
    );
    await t.test(
      'ownership, foreign room, unsupported snapshots, non-started and evidence-free completion refuse',
      async () => {
        await assert.rejects(previewCancellation(sql, session, input(preserved), env), {
          code: 'EARLY_DEPARTURE_UNAVAILABLE',
        });
        const stay = await begun(2),
          value = input(stay, [stay.lines[0].id]);
        await assert.rejects(previewCancellation(sql, session, input(stay, [randomUUID()]), env), {
          code: 'ROOM_NOT_CANCELLABLE',
        });
        const other = await seedCustomer(sql),
          [auth] =
            await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${other},now()+interval '1 day') RETURNING id`;
        await assert.rejects(
          previewCancellation(
            sql,
            { role: 'customer', userId: other, sessionId: auth.id },
            value,
            env,
          ),
          { code: 'CHECKOUT_NOT_FOUND' },
        );
        const preview = await previewCancellation(sql, session, value, env);
        await assert.rejects(
          commitCancellation(
            sql,
            session,
            { ...value, hash: preview.hash, idempotencyKey: randomUUID(), accepted: false },
            env,
          ),
          { name: 'ZodError' },
        );
        await assert.rejects(sql`UPDATE booking SET state='completed' WHERE id=${stay.visitId}`, {
          code: '23514',
        });
        await sql`UPDATE booking_room SET nights='[]'::jsonb WHERE id=${stay.lines[0].id}`;
        await assert.rejects(previewCancellation(sql, session, value, env), {
          code: 'EARLY_DEPARTURE_UNSUPPORTED',
        });
        assert.equal(
          (
            await sql`SELECT count(*)::int n FROM booking_room WHERE booking_id=${stay.visitId} AND departed_at IS NOT NULL`
          )[0].n,
          0,
        );
      },
    );
    await t.test(
      'ambiguous refunds need admin resolution; failed reservations do not consume capacity',
      async () => {
        const stay = await begun(1),
          value = input(stay),
          [source] =
            await sql`SELECT * FROM payment_allocation WHERE booking_id=${stay.visitId} AND component='rent'`;
        const refund = await sql.begin(async (tx) => {
          const [refund] =
            await tx`INSERT INTO refund(transaction_id,reference,provider,environment,mode,currency,expected_minor,reason,idempotency_key,request_hash) VALUES(${source.transaction_id},${'HISTORY_' + randomUUID()},'razorpay','test','real','INR',100,'Historical refund',${randomUUID()},${'a'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor) VALUES(${refund.id},${source.id},${stay.visitId},'rent',100)`;
          return refund;
        });
        await assert.rejects(previewCancellation(sql, session, value, env), {
          code: 'REFUND_ATTRIBUTION_REQUIRED',
        });
        await sql`UPDATE refund SET state='failed' WHERE id=${refund.id}`;
        const preview = await previewCancellation(sql, session, value, env);
        assert.equal(preview.visits[0].priorReserved.rent, 0);
        await confirm(value, preview);
      },
    );
    await t.test(
      'same-key and distinct-room races cannot duplicate effects or exceed captured capacity',
      async () => {
        const stay = await begun(3),
          value = input(stay, [stay.lines[0].id]),
          preview = await previewCancellation(sql, session, value, env),
          key = randomUUID();
        const same = await Promise.all([
          confirm(value, preview, key),
          confirm(value, preview, key),
        ]);
        assert.deepEqual(same[0], same[1]);
        const values = stay.lines.slice(1).map((r) => input(stay, [r.id])),
          previews = await Promise.all(
            values.map((v) => previewCancellation(sql, session, v, env)),
          );
        const results = await Promise.allSettled(values.map((v, i) => confirm(v, previews[i])));
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          results.find((r) => r.status === 'rejected').reason.code,
          'CANCELLATION_CHANGED',
        );
        const [capacity] =
          await sql`SELECT count(*)::int excess FROM payment_allocation a WHERE a.booking_id=${stay.visitId} AND a.actual_minor<(SELECT coalesce(sum(ra.expected_minor),0) FROM refund_allocation ra JOIN refund f ON f.id=ra.refund_id WHERE ra.payment_allocation_id=a.id AND f.state<>'failed')`;
        assert.equal(capacity.excess, 0);
      },
    );
    await t.test(
      'a nightly boundary changes the hash; booked hours survive owner edits; no-unused final night releases no stock',
      async () => {
        const stay = await begun(1),
          value = input(stay);
        let now = new Date(new Date(propertyLocalInstant(propertyToday(), '14:00')).getTime() - 1);
        const wrap = (fn) =>
          new Proxy(fn, {
            apply(target, receiver, args) {
              if (args[0]?.join?.('') === 'SELECT clock_timestamp() now')
                return Promise.resolve([{ now }]);
              return Reflect.apply(target, receiver, args);
            },
            get(target, key) {
              if (key === 'begin')
                return async (...args) => {
                  const callback = args.pop();
                  return target.begin(...args, (tx) => callback(wrap(tx)));
                };
              return Reflect.get(target, key);
            },
          });
        const clocked = wrap(sql),
          before = await previewCancellation(clocked, session, value, env);
        assert.equal(before.requestedAt, now.toISOString());
        now = new Date(+now + 1);
        const equal = await previewCancellation(clocked, session, value, env);
        assert.notEqual(equal.hash, before.hash);
        assert.equal(
          equal.visits[0].roomDetails[0].consumedNights.length,
          before.visits[0].roomDetails[0].consumedNights.length + 1,
        );
        await assert.rejects(
          commitCancellation(
            clocked,
            session,
            { ...value, hash: before.hash, idempotencyKey: randomUUID(), accepted: true },
            env,
          ),
          { code: 'CANCELLATION_CHANGED' },
        );
        await sql`UPDATE hotel_profile SET check_in_minute=960 WHERE rentable_id=${h.hotel}`;
        assert.equal((await previewCancellation(clocked, session, value, env)).hash, equal.hash);
        now = new Date(propertyLocalInstant(addLocalDays(stay.date, 3), '15:00'));
        const last = await previewCancellation(clocked, session, value, env),
          beforeStock = await stock();
        assert.deepEqual(last.visits[0].roomDetails[0].unusedNights, []);
        assert.equal(last.refundMinor, 0);
        const receipt = await commitCancellation(
          clocked,
          session,
          { ...value, hash: last.hash, idempotencyKey: randomUUID(), accepted: true },
          env,
        );
        assert.deepEqual(receipt.refundIds, []);
        assert.deepEqual(await stock(), beforeStock);
        await sql`UPDATE hotel_profile SET check_in_minute=840 WHERE rentable_id=${h.hotel}`;
      },
    );
    await t.test(
      'actual handover and return remain supported without fabricating completion evidence',
      async () => {
        for (const returned of [false, true]) {
          const stay = await begun(1);
          for (const phase of returned ? ['handover', 'return'] : ['handover']) {
            const [visit] =
              await sql`SELECT lifecycle_version FROM booking WHERE id=${stay.visitId}`;
            await recordVisitTransition(
              sql,
              { kind: 'owner', id: h.owner },
              {
                visitId: stay.visitId,
                phase,
                occurredAt: new Date(Date.now() - 60000).toISOString(),
                attested: true,
                expectedVersion: visit.lifecycle_version,
                requestKey: randomUUID(),
              },
            );
          }
          const value = input(stay),
            preview = await previewCancellation(sql, session, value, env);
          await confirm(value, preview);
          assert.equal(
            (
              await sql`SELECT count(*)::int n FROM visit_evidence WHERE booking_id=${stay.visitId} AND kind='complete'`
            )[0].n,
            0,
          );
          assert.equal(
            (await sql`SELECT state FROM booking WHERE id=${stay.visitId}`)[0].state,
            'completed',
          );
        }
      },
    );
    await t.test(
      'assigned caretakers see active guests and minimal room facts, then original Past facts and count',
      async () => {
        const stay = await begun(3),
          [staff] =
            await sql`INSERT INTO client_staff(client_id,phone,name,permissions,accepted_at) VALUES(${h.owner},'9811111177','Caretaker','{"evidence":true}',now()) RETURNING id`;
        await sql`INSERT INTO staff_property(staff_id,rentable_id) VALUES(${staff.id},${h.hotel})`;
        const actor = {
          id: staff.id,
          ownerId: h.owner,
          permissions: { guestContact: false },
          capabilities: [],
        };
        const value = input(stay, [stay.lines[0].id]),
          preview = await previewCancellation(sql, session, value, env);
        await confirm(value, preview);
        const list = await listStaffVisits(sql, actor, { tab: 'today' }),
          card = list.items.find((v) => v.id === stay.visitId);
        assert.equal(card.guests, 4);
        assert.equal(card.originalGuests, 6);
        assert.equal(card.guest, null);
        const detail = await readStaffVisitRecord(sql, actor, stay.orderId);
        assert.equal(detail.visits[0].guests, 4);
        assert.equal(detail.guest, null);
        assert.deepEqual(
          detail.visits[0].rooms.map((r) => r.id),
          stay.lines.map((r) => r.id),
        );
        assert.equal(detail.visits[0].rooms.filter((r) => r.departedAt).length, 1);
        assert.ok(detail.visits[0].rooms.every((r) => r.name === 'Deluxe Double'));
        assert.doesNotMatch(
          JSON.stringify(detail),
          /guestName|roomMinor|taxMinor|rentMinor|feeMinor|customerId|payment/,
        );
        const pastBefore = await listStaffVisits(sql, actor, { tab: 'past' });
        const rest = input(
          stay,
          stay.lines.slice(1).map((r) => r.id),
        );
        await confirm(rest, await previewCancellation(sql, session, rest, env));
        const past = await listStaffVisits(sql, actor, { tab: 'past' }),
          ended = past.items.find((v) => v.id === stay.visitId);
        assert.equal(past.counts.past, pastBefore.counts.past + 1);
        assert.equal(ended.guests, 6);
        assert.equal(ended.rooms.filter((r) => r.departedAt).length, 3);
        assert.equal((await readStaffVisitRecord(sql, actor, stay.orderId)).visits[0].guests, 6);
        await sql`DELETE FROM staff_property WHERE staff_id=${staff.id}`;
        assert.equal(await readStaffVisitRecord(sql, actor, stay.orderId), null);
        assert.equal((await listStaffVisits(sql, actor, { tab: 'past' })).counts.past, 0);
      },
    );
    await t.test(
      'zero and partial departure refunds change occupied counts, never gross booked analytics revenue',
      async () => {
        for (const pct of [0, 50]) {
          const stay = await begun(1, policy(true, pct)),
            range = { from: stay.date, to: stay.out };
          const before = await getOwnerHotelAnalytics(sql, h.owner, range),
            adminBefore = await getAdminHotelAnalytics(sql, h.admin, range),
            earningsBefore = await getOwnerHotelEarnings(sql, h.owner, {
              month: stay.date.slice(0, 7),
            });
          const value = input(stay),
            preview = await previewCancellation(sql, session, value, env),
            unused = preview.visits[0].roomDetails[0].unusedNights;
          await confirm(value, preview);
          const after = await getOwnerHotelAnalytics(sql, h.owner, range),
            adminAfter = await getAdminHotelAnalytics(sql, h.admin, range),
            earningsAfter = await getOwnerHotelEarnings(sql, h.owner, {
              month: stay.date.slice(0, 7),
            });
          for (const day of before.daily) {
            const next = after.daily.find((d) => d.date === day.date);
            assert.equal(next.revenueMinor, day.revenueMinor);
            assert.equal(next.roomsSold, day.roomsSold - (unused.includes(day.date) ? 1 : 0));
          }
          const b = adminBefore.topHotels.find((x) => x.id === h.hotel),
            a = adminAfter.topHotels.find((x) => x.id === h.hotel);
          assert.equal(a.revenueMinor, b.revenueMinor);
          assert.equal(a.roomNights, b.roomNights - unused.length);
          assert.equal(
            adminAfter.topCities.find((x) => x.id === h.city).roomNights,
            adminBefore.topCities.find((x) => x.id === h.city).roomNights - unused.length,
          );
          assert.equal(
            earningsAfter.summary.roomNights,
            earningsBefore.summary.roomNights - unused.length,
          );
        }
      },
    );
    await t.test(
      'room lock waiting precedes the authoritative nightly boundary clock',
      async () => {
        const stay = await begun(1),
          value = input(stay);
        let now = new Date(+new Date(propertyLocalInstant(propertyToday(), '14:00')) - 1),
          unlock,
          locked,
          entered;
        const holding = new Promise((resolve) => {
            locked = resolve;
          }),
          waiting = new Promise((resolve) => {
            entered = resolve;
          }),
          release = new Promise((resolve) => {
            unlock = resolve;
          });
        const blocker = sql.begin(async (tx) => {
          await tx`SELECT id FROM booking_room WHERE id=${stay.lines[0].id} FOR UPDATE`;
          locked();
          await release;
        });
        await holding;
        const wrap = (fn) =>
          new Proxy(fn, {
            apply(target, receiver, args) {
              const query = args[0]?.join?.('');
              if (query === 'SELECT clock_timestamp() now') return Promise.resolve([{ now }]);
              if (query?.includes('FOR UPDATE OF br')) entered();
              return Reflect.apply(target, receiver, args);
            },
            get(target, key) {
              if (key === 'begin')
                return async (...args) => {
                  const callback = args.pop();
                  return target.begin(...args, (tx) => callback(wrap(tx)));
                };
              return Reflect.get(target, key);
            },
          });
        const pending = previewCancellation(wrap(sql), session, value, env);
        // A missing lock must fail the regression instead of keeping the fixture blocked.
        const failsafe = setTimeout(unlock, 5000);
        try {
          await Promise.race([
            waiting,
            pending.then(() => {
              throw new Error('Preview finished before the room lock');
            }),
          ]);
          now = new Date(+now + 1);
        } finally {
          clearTimeout(failsafe);
          unlock();
        }
        await blocker;
        const preview = await pending;
        assert.equal(preview.requestedAt, now.toISOString());
        assert.ok(preview.visits[0].roomDetails[0].consumedNights.includes(propertyToday()));
        assert.ok(!preview.visits[0].roomDetails[0].unusedNights.includes(propertyToday()));
        assert.equal(
          (await sql`SELECT state FROM booking_room WHERE id=${stay.lines[0].id}`)[0].state,
          'booked',
        );
      },
    );
    await t.test(
      'inconsistent original booked start and end schedules refuse departure without mutation',
      async () => {
        const stay = await begun(1),
          value = input(stay);
        for (const column of ['starts_at', 'ends_at']) {
          await sql.begin(async (tx) => {
            await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
            await tx.unsafe(
              `UPDATE booking SET ${column}=${column}+interval '1 minute', ${column === 'starts_at' ? 'blocked_start_at' : 'blocked_end_at'}=${column === 'starts_at' ? 'blocked_start_at' : 'blocked_end_at'}+interval '1 minute' WHERE id=$1`,
              [stay.visitId],
            );
            await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
          });
          await assert.rejects(previewCancellation(sql, session, value, env), {
            code: 'EARLY_DEPARTURE_UNSUPPORTED',
          });
          await sql.begin(async (tx) => {
            await tx`ALTER TABLE booking DISABLE TRIGGER checkout_terms`;
            await tx.unsafe(
              `UPDATE booking SET ${column}=${column}-interval '1 minute', ${column === 'starts_at' ? 'blocked_start_at' : 'blocked_end_at'}=${column === 'starts_at' ? 'blocked_start_at' : 'blocked_end_at'}-interval '1 minute' WHERE id=$1`,
              [stay.visitId],
            );
            await tx`ALTER TABLE booking ENABLE TRIGGER checkout_terms`;
          });
        }
        assert.equal(
          (await sql`SELECT departed_at FROM booking_room WHERE id=${stay.lines[0].id}`)[0]
            .departed_at,
          null,
        );
      },
    );
    await t.test(
      'unknown and failed provider refunds never undo departure or duplicate retry obligations',
      async () => {
        const stay = await begun(1),
          value = input(stay),
          preview = await previewCancellation(sql, session, value, env),
          key = randomUUID();
        const receipt = await confirm(value, preview, key),
          afterStock = await stock(),
          refundId = receipt.refundIds[0];
        let provider = JSON.parse(await readFile(providerFile, 'utf8'));
        provider.dropRefundResponses = 1;
        await writeFile(providerFile, JSON.stringify(provider));
        await assert.rejects(reconcileRefund(sql, refundId, opts));
        assert.equal(
          (await sql`SELECT state FROM refund WHERE id=${refundId}`)[0].state,
          'unknown',
        );
        assert.deepEqual(await confirm(value, preview, key), receipt);
        provider = JSON.parse(await readFile(providerFile, 'utf8'));
        for (const refund of Object.values(provider.refunds))
          if (refund.receipt === refundId || refund.receipt === 'TEST_REFUND_' + refundId)
            refund.status = 'failed';
        await writeFile(providerFile, JSON.stringify(provider));
        await reconcileRefund(sql, refundId, opts);
        assert.equal(
          (await sql`SELECT failure_code FROM refund_execution WHERE refund_id=${refundId}`)[0]
            .failure_code,
          'PROVIDER_REFUND_FAILED',
        );
        assert.deepEqual(await confirm(value, preview, key), receipt);
        assert.deepEqual(await stock(), afterStock);
        assert.equal(
          (
            await sql`SELECT count(*)::int n FROM refund_allocation WHERE booking_id=${stay.visitId}`
          )[0].n,
          3,
        );
        assert.equal(
          (await sql`SELECT state FROM booking WHERE id=${stay.visitId}`)[0].state,
          'completed',
        );
        const final = JSON.parse(await readFile(providerFile, 'utf8'));
        assert.equal(final.refundPosts.filter((r) => r === refundId).length, 1);
      },
    );
    await t.test(
      'Test payout statement remains historical when a later departure reserves a guest refund',
      async () => {
        const stay = await begun(1);
        await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
        VALUES(${h.owner},1,'bank','Hotel Owner','4421','HDFC0001234','same','verified','migration',now(),'fixture','fixture-verification',${'a'.repeat(64)},now())`;
        const now = new Date().toISOString(),
          run = await previewPayoutRun(sql, h.admin, { environment: 'test' }, { now });
        assert.ok(run.lines.some((line) => line.bookingId === stay.visitId));
        const saved = await executePayoutRun(
          sql,
          h.admin,
          { environment: 'test', previewHash: run.previewHash },
          { now },
        );
        const [before] = await sql`SELECT snapshot FROM payout_run WHERE id=${saved.id}`;
        const value = input(stay),
          preview = await previewCancellation(sql, session, value, env),
          receipt = await confirm(value, preview);
        assert.ok(receipt.refundMinor > 0);
        assert.deepEqual(
          (await sql`SELECT snapshot FROM payout_run WHERE id=${saved.id}`)[0],
          before,
        );
        const next = await previewPayoutRun(sql, h.admin, { environment: 'test' }, { now });
        assert.ok(!next.lines.concat(next.held).some((line) => line.bookingId === stay.visitId));
        assert.equal(
          (await sql`SELECT count(*)::int n FROM payout WHERE booking_id=${stay.visitId}`)[0].n,
          1,
        );
      },
    );
    await t.test(
      'omitted operation preserves the original preview/hash/replay contract',
      async () => {
        const value = { orderId: preserved.orderId, visitIds: [preserved.visitId] };
        const preview = await previewCancellation(sql, session, value, env),
          key = randomUUID();
        assert.equal('operation' in preview, false);
        assert.equal('requestedAt' in preview, false);
        const receipt = await confirm(value, preview, key);
        assert.deepEqual(await confirm(value, preview, key), receipt);
      },
    );
    await t.test(
      'inventory insertion, deletion, capacity, stop-sell and immutable range guards remain enforced',
      async () => {
        const stay = await future(1),
          [line] =
            await sql`SELECT *,check_in::text AS arrival FROM booking_room WHERE booking_id=${stay.visitId}`;
        const clone =
          () => sql`INSERT INTO booking_room(booking_id,rentable_id,room_type_id,rate_plan_id,check_in,check_out,adults,nights,amount_room_minor,amount_tax_minor,plan_snapshot)
    SELECT booking_id,rentable_id,room_type_id,rate_plan_id,check_in,check_out,adults,nights,amount_room_minor,amount_tax_minor,plan_snapshot FROM booking_room WHERE id=${line.id} RETURNING id`;
        const before = await stock(),
          [copy] = await clone();
        const nights = await stock();
        for (const n of before)
          assert.equal(
            nights.find((x) => x.night === n.night).held,
            n.held +
              (n.night >=
                (line.check_in instanceof Date
                  ? line.check_in.toISOString()
                  : String(line.check_in)
                ).slice(0, 10) &&
              n.night <
                (line.check_out instanceof Date
                  ? line.check_out.toISOString()
                  : String(line.check_out)
                ).slice(0, 10)
                ? 1
                : 0),
          );
        await sql`DELETE FROM booking_room WHERE id=${copy.id}`;
        assert.deepEqual(await stock(), before);
        await sql`UPDATE room_night SET allotment=sold+held WHERE room_type_id=${h.deluxe} AND night=${line.arrival}`;
        await assert.rejects(clone(), { code: '23514' });
        await sql`UPDATE room_night SET allotment=500,stop_sell=true WHERE room_type_id=${h.deluxe} AND night=${line.arrival}`;
        await assert.rejects(clone(), { code: '23514' });
        await sql`UPDATE room_night SET stop_sell=false WHERE room_type_id=${h.deluxe} AND night=${line.arrival}`;
        await assert.rejects(
          sql`UPDATE booking_room SET check_out=check_out+1 WHERE id=${line.id}`,
          { code: '23514' },
        );
        assert.deepEqual(await stock(), before);
      },
    );
  },
);
