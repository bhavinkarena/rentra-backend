import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';

const SECRET = 'owner-overdue-disposable-secret';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_OVERDUE220',
  RAZORPAY_KEY_SECRET: SECRET,
  RAZORPAY_WEBHOOK_SECRET: 'owner-overdue-disposable-webhook',
};
const sign = (order, pay) => createHmac('sha256', SECRET).update(`${order}|${pay}`).digest('hex');

test(
  'Story 2.20 overdue owner repayment stops new bookings owner-wide until settled',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    const dir = await mkdtemp(join(tmpdir(), 'rentra-overdue-'));
    const file = join(dir, 'razorpay.json');
    const opts = { env, fetcher: fileBackedRazorpay(file) };
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const { createBookingQuote, getBookingAvailability } =
        await import('@/services/booking/quotes.js');
      const { openBookingDates } = await import('@/services/booking/owner-settings.js');
      const { createCheckoutHold } = await import('@/services/booking/checkout.js');
      const { decideBookingRequest, setInstantBook } =
        await import('@/services/booking/booking-requests.js');
      const { setPaymentGatewayConfiguration } =
        await import('@/services/payments/gateway-settings.js');
      const { startCheckoutPayment } = await import('@/services/payments/checkout-service.js');
      const { addLocalDays, propertyToday } = await import('@/services/domain/booking-dates.js');
      const { reservePayoutTransfer, dispatchPayoutTransfer } =
        await import('@/services/finance/payout-transfer-fixtures.js');
      const { previewOwnerRecovery, assignOwnerRecovery, listRecoveryCandidates } =
        await import('@/services/finance/owner-recovery.js');
      const {
        createRepaymentLink,
        listOwnerRepayments,
        verifyOwnerRepayment,
        resolveRepaymentLink,
      } = await import('@/services/finance/owner-repayment.js');
      const { recordOwnerNoticeEvent, confirmNoticeReceipt } =
        await import('@/services/finance/owner-repayment-notice.js');
      const { errorHandler } = await import('@/middlewares/error.middleware.js');

      const f = await seedReviewFixture(sql);
      const cash = await seedFinanceFixture(sql, f);
      const admin = { kind: 'admin', id: f.admin };
      const payout = payoutTransferProvider();
      payout.outcome = 'succeeded';
      const recovery = async (minor) => {
        const s = await cash.add('test');
        const fx = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          payout,
        );
        await dispatchPayoutTransfer(sql, admin, fx.id, {}, payout);
        await sql.begin(async (tx) => {
          const key = randomUUID();
          const [r] =
            await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,idempotency_key,request_hash)
            VALUES ('Fixture refund',${key},${s.transactionId},'fixture','test','real','INR','requested',${minor},${key},${'d'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor,actual_minor)
            VALUES (${r.id},${s.allocationId},${s.bookingId},'rent',${minor},${minor})`;
          await tx`UPDATE refund SET state='succeeded',actual_minor=expected_minor,verified_at=now(),provider_refund_id=${randomUUID()},evidence_hash=${'e'.repeat(64)} WHERE id=${r.id}`;
        });
        const p = await previewOwnerRecovery(sql, admin, s.allocationId);
        const a = await assignOwnerRecovery(sql, admin, s.allocationId, {
          hash: p.hash,
          expectedVersion: 0,
          requestKey: randomUUID(),
          reason: 'Guest refund after Test payout',
        });
        return { sourceId: s.allocationId, recoveryId: a.recoveryId };
      };
      const link = async (r) => {
        const p = await previewOwnerRecovery(sql, admin, r.sourceId);
        return createRepaymentLink(
          sql,
          admin,
          r.sourceId,
          { hash: p.hash, expectedVersion: p.version, requestKey: randomUUID() },
          opts,
        );
      };
      const pay = (l, payId, amount) => {
        providerCaptures(file, l.providerOrderId, payId, amount);
        return verifyOwnerRepayment(
          sql,
          f.owner,
          l.id,
          { paymentId: payId, signature: sign(l.providerOrderId, payId) },
          opts,
        );
      };
      const notice = async (r) =>
        (await sql`SELECT * FROM owner_repayment_notice WHERE recovery_id=${r.recoveryId}`)[0];

      // Two recoveries, each with a link (notice issued, no receipt yet).
      const r1 = await recovery(9000);
      const r2 = await recovery(4000);
      const l1 = await link(r1);
      const l2 = await link(r2);

      // Bookable listing with an instant hold, an in-flight payment and a pending request.
      const booked = await seedConfirmedBooking(sql, f.listing);
      await sql`UPDATE rentable SET status='live',published_at=now() WHERE id=${f.listing}`;
      // The seeded stay predates inventory rows; reconcile it as the pause story does.
      const [legacy] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${booked.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at)
        VALUES (${f.listing},${legacy.id},'booking','committed',${legacy.starts_at},${legacy.ends_at})`;
      const days = [10, 11, 12, 13].map((n) => addLocalDays(propertyToday(), n));
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: days[0], to: days[3] });
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
      const quote = (date) =>
        createBookingQuote(
          sql,
          { rentableId: f.listing, dates: [date], slot: 'day', guests: 2 },
          { customerId: booked.customer, variables: env },
        );
      const hold = async (date) => {
        const q = await quote(date);
        return createCheckoutHold(
          sql,
          session,
          {
            rentableId: f.listing,
            quoteId: q.id,
            hash: q.hash,
            version: q.version,
            idempotencyKey: randomUUID(),
            accepted: true,
          },
          env,
        );
      };
      const overdue = async () => (await sql`SELECT owner_repayment_overdue(${f.owner}) o`)[0].o;
      const BLOCKED = { code: 'OWNER_REPAYMENT_OVERDUE' };

      await t.test('no receipt evidence (due_at null): bookings admitted', async () => {
        assert.equal((await notice(r1)).due_at, null);
        assert.equal(await overdue(), false);
        await quote(days[0]);
      });

      const instant = await hold(days[0]);
      const racing = await hold(days[1]);
      const racingStart = await startCheckoutPayment(sql, session, racing.orderId, opts);
      await setInstantBook(sql, f.owner, { rentableId: f.listing, enabled: false });
      const requested = await hold(days[2]);
      assert.equal(requested.approval, 'pending');

      await t.test('notice received, now < due_at: bookings admitted', async () => {
        await recordOwnerNoticeEvent(sql, f.owner, r1.recoveryId, 'portal_view', {
          requestKey: randomUUID(),
        });
        assert.ok((await notice(r1)).due_at > new Date());
        assert.equal(await overdue(), false);
        await quote(days[3]);
      });

      // Move r1's receipt back eight days (consistent with the 0082 milestone CHECK).
      await sql`UPDATE owner_repayment_notice SET issued_at=now()-interval '9 days',received_at=now()-interval '8 days',
        reminder_at=now()-interval '3 days',due_at=now()-interval '1 day' WHERE recovery_id=${r1.recoveryId}`;

      await t.test('overdue: quote, hold, approve and new payment start refused', async () => {
        assert.equal(await overdue(), true);
        await assert.rejects(quote(days[3]), BLOCKED);
        await assert.rejects(hold(days[3]), BLOCKED);
        await assert.rejects(
          decideBookingRequest(sql, f.owner, { orderId: requested.orderId, approve: true }),
          BLOCKED,
        );
        await assert.rejects(startCheckoutPayment(sql, session, instant.orderId, opts), BLOCKED);
        // An in-flight provider order is still only read.
        const inFlight = await startCheckoutPayment(sql, session, racing.orderId, opts);
        assert.equal(inFlight.providerOrderId, racingStart.providerOrderId);
      });

      await t.test('guest response is 409 and never mentions repayment or debt', async () => {
        let status, body;
        const res = {
          error: (s, message, extra) => {
            status = s;
            body = { message, ...extra };
          },
        };
        await quote(days[3]).catch((e) =>
          errorHandler(e, { method: 'POST', originalUrl: '/' }, res),
        );
        assert.equal(status, 409);
        assert.equal(body.code, 'LISTING_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(body), /repay|debt|overdue/i);
      });

      await t.test('confirmed stay unchanged; status is derived, not stored', async () => {
        assert.equal(
          (await sql`SELECT state FROM booking WHERE order_id=${booked.order}`)[0].state,
          'confirmed',
        );
        assert.equal(
          (await sql`SELECT status FROM rentable WHERE id=${f.listing}`)[0].status,
          'live',
        );
      });

      await t.test('decline still works while overdue', async () => {
        const declined = await decideBookingRequest(sql, f.owner, {
          orderId: requested.orderId,
          approve: false,
        });
        assert.equal(declined.approval, 'declined');
      });

      await t.test('direct insert bypassing the service: trigger raises, maps to 409', async () => {
        const error =
          await sql`INSERT INTO booking_order SELECT (jsonb_populate_record(null::booking_order,
            to_jsonb(o)||jsonb_build_object('id',gen_random_uuid(),'reference','BYPASS','idempotency_key',gen_random_uuid()))).*
            FROM booking_order o WHERE id=${instant.orderId}`.then(
            () => assert.fail('insert admitted'),
            (e) => e,
          );
        assert.equal(error.code, 'RN001');
        let status, body;
        errorHandler(
          error,
          { method: 'POST', originalUrl: '/' },
          {
            error: (s, message, extra) => {
              status = s;
              body = { message, ...extra };
            },
          },
        );
        assert.equal(status, 409);
        assert.equal(body.code, 'LISTING_UNAVAILABLE');
        assert.doesNotMatch(JSON.stringify(body), /repay|debt|overdue/i);
      });

      await t.test('public calendar reads treat overdue as unavailable', async () => {
        await assert.rejects(
          getBookingAvailability(sql, { rentableId: f.listing, from: days[3], to: days[3] }, env),
          BLOCKED,
        );
      });

      await t.test('other owner unaffected', async () => {
        assert.equal((await sql`SELECT owner_repayment_overdue(${f.other}) o`)[0].o, false);
        await sql`UPDATE rentable SET client_id=${f.other} WHERE id=${f.listing}`;
        try {
          await quote(days[3]);
        } finally {
          await sql`UPDATE rentable SET client_id=${f.owner} WHERE id=${f.listing}`;
        }
      });

      await t.test('owner and admin surfaces show the restriction', async () => {
        const mine = await listOwnerRepayments(sql, f.owner, { env });
        assert.equal(mine.overdue, true);
        assert.equal(mine.outstandingMinor, '13000');
        const rows = (await listRecoveryCandidates(sql, admin)).items;
        assert.equal(rows.find((i) => i.recoveryId === r1.recoveryId).overdue, true);
        assert.equal(rows.find((i) => i.recoveryId === r2.recoveryId).overdue, false);
      });

      await t.test('partial / needs_review payment: still blocked', async () => {
        const out = await pay(l1, 'pay_SHORT220', 3000);
        assert.equal(out.state, 'needs_review');
        assert.equal(await overdue(), true);
        await assert.rejects(quote(days[3]), BLOCKED);
      });

      await t.test('admin earlier-receipt correction makes r2 overdue immediately', async () => {
        await sql`UPDATE owner_repayment_notice SET issued_at=now()-interval '10 days' WHERE recovery_id=${r2.recoveryId}`;
        const n = await notice(r2);
        await confirmNoticeReceipt(sql, admin, r2.sourceId, {
          reason: 'Owner confirmed by phone call',
          requestKey: randomUUID(),
          receivedAt: new Date(Date.now() - 9 * 86400000).toISOString(),
          expectedVersion: n.version,
        });
        const rows = (await listRecoveryCandidates(sql, admin)).items;
        assert.equal(rows.find((i) => i.recoveryId === r2.recoveryId).overdue, true);
      });

      await t.test('two overdue recoveries, one repaid: still blocked', async () => {
        // Admin closes the mismatched link; a replaced/new link alone clears nothing.
        await resolveRepaymentLink(
          sql,
          admin,
          r1.sourceId,
          { linkId: l1.id, reason: 'Mismatched Test capture' },
          opts,
        );
        const fresh = await link(r1);
        assert.equal(await overdue(), true);
        const out = await pay(fresh, 'pay_FULL1');
        assert.equal(out.state, 'paid');
        assert.equal(await overdue(), true);
        await assert.rejects(quote(days[3]), BLOCKED);
      });

      await t.test('owner pause persists after debt repaid', async () => {
        await sql`UPDATE rentable SET status='paused' WHERE id=${f.listing}`;
        assert.equal((await pay(l2, 'pay_FULL2')).state, 'paid');
        assert.equal(await overdue(), false);
        assert.equal(
          (await sql`SELECT status FROM rentable WHERE id=${f.listing}`)[0].status,
          'paused',
        );
        await sql`UPDATE rentable SET status='live' WHERE id=${f.listing}`;
      });

      await t.test('verified full repayment: admission works again without a worker', async () => {
        await quote(days[3]);
        assert.equal((await listOwnerRepayments(sql, f.owner, { env })).overdue, false);
        const payable = await startCheckoutPayment(sql, session, instant.orderId, opts);
        assert.ok(payable.providerOrderId);
      });
    } finally {
      await fixture.drop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
