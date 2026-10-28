import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { payoutTransferProvider } from '../helpers/payout-transfer-provider.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';

const SECRET = 'release-gates-disposable-secret';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_GATES221',
  RAZORPAY_KEY_SECRET: SECRET,
  RAZORPAY_WEBHOOK_SECRET: 'release-gates-disposable-webhook',
  FINANCE_INITIATION_DISABLED: 'false',
};
const on = { ...env, FINANCE_INITIATION_DISABLED: 'true' };
const sign = (order, pay) => createHmac('sha256', SECRET).update(`${order}|${pay}`).digest('hex');

test(
  'Story 2.21 financial release gates and initiation kill switch',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async (t) => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    const file = join(mkdtempSync(join(tmpdir(), 'gates-')), 'rzp.json');
    const state = () =>
      existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { orders: {}, refundPosts: [] };
    const orders = () => Object.keys(state().orders).length;
    const refundPosts = () => (state().refundPosts ?? []).length;
    const previousSwitch = process.env.FINANCE_INITIATION_DISABLED;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const { createBookingQuote } = await import('@/services/booking/quotes.js');
      const { openBookingDates } = await import('@/services/booking/owner-settings.js');
      const { createCheckoutHold } = await import('@/services/booking/checkout.js');
      const { setPaymentGatewayConfiguration } =
        await import('@/services/payments/gateway-settings.js');
      const { startCheckoutPayment, verifyCheckoutPayment } =
        await import('@/services/payments/checkout-service.js');
      const { reconcileRefund, runRefundJobs } = await import('@/services/payments/refunds.js');
      const { ingestRazorpayEvent, processNextPaymentEvent } =
        await import('@/services/payments/webhooks.js');
      const { listPaymentOrders } = await import('@/services/payments/investigation.js');
      const { addLocalDays, propertyToday } = await import('@/services/domain/booking-dates.js');
      const { readReleaseGates, pendingMigrations } =
        await import('@/services/finance/release-gates.js');
      const { previewOwnerCancelUpcoming, ownerCancelUpcoming } =
        await import('@/services/booking/owner-cancel-upcoming.js');
      const { reservePayoutTransfer, dispatchPayoutTransfer } =
        await import('@/services/finance/payout-transfer-fixtures.js');
      const { previewOwnerRecovery, assignOwnerRecovery } =
        await import('@/services/finance/owner-recovery.js');
      const { createRepaymentLink, listOwnerRepayments, verifyOwnerRepayment, checkRepaymentLink } =
        await import('@/services/finance/owner-repayment.js');

      const f = await seedReviewFixture(sql);
      const admin = { kind: 'admin', id: f.admin };
      const legacy = await seedConfirmedBooking(sql, f.listing);
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
      await sql`UPDATE rentable SET status='live',published_at=now(),booking_config=${JSON.stringify({ inventoryReady: true, timeZone: 'Asia/Kolkata', leadTimeMinutes: 60, bookingHorizonDays: 90, slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } } })}::text::jsonb WHERE id=${f.listing}`;
      const [old] =
        await sql`UPDATE booking SET hours_known=true,blocked_start_at=starts_at,blocked_end_at=ends_at WHERE order_id=${legacy.order} RETURNING *`;
      await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) VALUES (${f.listing},${old.id},'booking','committed',${old.starts_at},${old.ends_at})`;
      const days = [10, 11, 12].map((n) => addLocalDays(propertyToday(), n));
      await openBookingDates(sql, f.owner, { rentableId: f.listing, from: days[0], to: days[2] });
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
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${legacy.customer},now()+interval '1 day') RETURNING id`;
      const session = { role: 'customer', userId: legacy.customer, sessionId: row.id };
      const fetcher = fileBackedRazorpay(file);
      const off = { env, fetcher },
        disabled = { env: on, fetcher };
      const hold = async (date) => {
        const quote = await createBookingQuote(
          sql,
          { rentableId: f.listing, dates: [date], slot: 'day', guests: 2 },
          { customerId: legacy.customer, variables: env },
        );
        return createCheckoutHold(
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
      };
      const checkoutSign = (order, pay) =>
        createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${order}|${pay}`).digest('hex');

      // Switch off: a paid order A, and an in-flight order C (provider order created, not yet captured).
      const a = await hold(days[0]);
      const startedA = await startCheckoutPayment(sql, session, a.orderId, off);
      providerCaptures(file, startedA.providerOrderId, 'pay_GATEA');
      assert.equal(
        (
          await verifyCheckoutPayment(
            sql,
            session,
            {
              orderId: a.orderId,
              paymentId: 'pay_GATEA',
              signature: checkoutSign(startedA.providerOrderId, 'pay_GATEA'),
            },
            off,
          )
        ).state,
        'confirmed',
      );
      const c = await hold(days[2]);
      const startedC = await startCheckoutPayment(sql, session, c.orderId, off);

      await t.test('finance read admin sees blocked gates, not ready, live facts', async () => {
        const gates = await readReleaseGates(sql, admin, env);
        assert.equal(gates.overall, 'not_ready');
        assert.equal(gates.overallLabel, 'Not ready for Live money');
        assert.ok(gates.gates.length >= 7);
        assert.ok(gates.gates.every((g) => g.status === 'blocked' && g.owner && g.blocker));
        for (const id of [
          'funding',
          'specialist-terms',
          'provider-live',
          'staffing',
          'dispute-caps',
          'migrations',
          'alerts',
        ])
          assert.ok(
            gates.gates.some((g) => g.id === id),
            id,
          );
        assert.match(
          gates.gates.find((g) => g.id === 'migrations').blocker,
          /Neon last recorded at 0075.*apply 0076-\d{4}/,
        );
        assert.equal(
          pendingMigrations(null),
          'apply 0076 onward; latest migration unknown in this build',
        );
        assert.match(gates.proposal.label, /not funded, not adequacy proof/);
        assert.equal(gates.facts.gatewayEnvironment, 'test');
        assert.equal(gates.facts.fundingAllocations, 0);
        assert.equal(gates.facts.initiationDisabled, false);
        assert.equal(typeof gates.facts.unresolvedOutcomes.refunds, 'number');
        assert.equal(
          (await readReleaseGates(sql, admin, on)).facts.initiationDisabled,
          true,
          'switch fact',
        );
      });

      await t.test('non-finance admin and owner are refused', async () => {
        await assert.rejects(readReleaseGates(sql, { kind: 'admin', id: f.limited }, env), {
          statusCode: 403,
        });
        await assert.rejects(readReleaseGates(sql, { kind: 'client', id: f.owner }, env), {
          statusCode: 403,
        });
      });

      await t.test('switch on: guest new payment refused, no provider order', async () => {
        const b = await hold(days[1]);
        const before = orders();
        await assert.rejects(startCheckoutPayment(sql, session, b.orderId, disabled), {
          statusCode: 503,
          code: 'FINANCE_INITIATION_DISABLED',
        });
        assert.equal(orders(), before);
        const [exec] =
          await sql`SELECT e.state FROM payment_execution e JOIN payment_order p ON p.id=e.payment_order_id WHERE p.booking_order_id=${b.orderId}`;
        assert.equal(exec.state, 'ready', 'nothing claimed');
      });

      await t.test(
        'switch on: webhook ingest settles an already-dispatched order; GET lists work',
        async () => {
          providerCaptures(file, startedC.providerOrderId, 'pay_GATEC');
          const raw = Buffer.from(
            JSON.stringify({
              event: 'payment.captured',
              payload: {
                payment: { entity: { id: 'pay_GATEC', order_id: startedC.providerOrderId } },
              },
            }),
          );
          await ingestRazorpayEvent(
            sql,
            raw,
            createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex'),
            'evt_GATEC',
            on,
          );
          while (await processNextPaymentEvent(sql, disabled));
          const [order] = await sql`SELECT state FROM booking_order WHERE id=${c.orderId}`;
          assert.equal(order.state, 'confirmed');
          assert.ok((await listPaymentOrders(sql, admin, {})).items.length >= 2);
        },
      );

      await t.test(
        'switch on: refund dispatch makes no provider refund; obligation stays pending',
        async () => {
          const [rent] =
            await sql`SELECT a.id,a.transaction_id,a.booking_id FROM payment_allocation a
          JOIN booking b ON b.id=a.booking_id WHERE b.order_id=${a.orderId} AND a.component='rent'`;
          const id = randomUUID();
          await sql.begin(async (tx) => {
            await tx`INSERT INTO refund(id,transaction_id,reference,provider,environment,mode,currency,expected_minor,reason,idempotency_key,request_hash)
            VALUES (${id},${rent.transaction_id},${'TEST_REFUND_' + id},'razorpay','test','real','INR',1000,'Owner cancelled upcoming stay',${id},${'e'.repeat(64)})`;
            await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor)
            VALUES (${id},${rent.id},${rent.booking_id},'rent',1000)`;
          });
          await runRefundJobs(sql, disabled);
          await reconcileRefund(sql, id, disabled);
          assert.equal(refundPosts(), 0);
          const [held] =
            await sql`SELECT r.state,e.dispatched_at FROM refund r JOIN refund_execution e ON e.refund_id=r.id WHERE r.id=${id}`;
          assert.deepEqual([held.state, held.dispatched_at], ['requested', null]);
          // Switch off: the same obligation dispatches exactly as before.
          await reconcileRefund(sql, id, off);
          assert.equal(refundPosts(), 1);
        },
      );

      // Owner repayment and payout fixtures.
      const cash = await seedFinanceFixture(sql, f);
      const payout = payoutTransferProvider();
      const recovery = async () => {
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
            VALUES ('Fixture refund',${key},${s.transactionId},'fixture','test','real','INR','requested',9000,${key},${'d'.repeat(64)}) RETURNING id`;
          await tx`INSERT INTO refund_allocation(refund_id,payment_allocation_id,booking_id,component,expected_minor,actual_minor)
            VALUES (${r.id},${s.allocationId},${s.bookingId},'rent',9000,9000)`;
          await tx`UPDATE refund SET state='succeeded',actual_minor=expected_minor,verified_at=now(),provider_refund_id=${randomUUID()},evidence_hash=${'e'.repeat(64)} WHERE id=${r.id}`;
        });
        const p = await previewOwnerRecovery(sql, admin, s.allocationId);
        await assignOwnerRecovery(sql, admin, s.allocationId, {
          hash: p.hash,
          expectedVersion: 0,
          requestKey: randomUUID(),
          reason: 'Guest refund after Test payout',
        });
        return s.allocationId;
      };
      const create = async (sourceId, opts) => {
        const p = await previewOwnerRecovery(sql, admin, sourceId);
        return createRepaymentLink(
          sql,
          admin,
          sourceId,
          { hash: p.hash, expectedVersion: p.version, requestKey: randomUUID() },
          opts,
        );
      };

      await t.test(
        'switch on: repayment link refused; already-created link verifies; check and lists work',
        async () => {
          const paidSource = await recovery();
          const link = await create(paidSource, off);
          const blockedSource = await recovery();
          const before = orders();
          const links = (await sql`SELECT count(*)::int n FROM owner_repayment`)[0].n;
          await assert.rejects(create(blockedSource, disabled), {
            statusCode: 503,
            code: 'FINANCE_INITIATION_DISABLED',
          });
          assert.equal(orders(), before, 'no provider order');
          assert.equal(
            (await sql`SELECT count(*)::int n FROM owner_repayment`)[0].n,
            links,
            'nothing written',
          );
          providerCaptures(file, link.providerOrderId, 'pay_GATEREPAY');
          const paid = await verifyOwnerRepayment(
            sql,
            f.owner,
            link.id,
            { paymentId: 'pay_GATEREPAY', signature: sign(link.providerOrderId, 'pay_GATEREPAY') },
            disabled,
          );
          assert.equal(paid.state, 'paid');
          await checkRepaymentLink(sql, admin, paidSource, disabled);
          assert.ok(
            (await listOwnerRepayments(sql, f.owner, disabled)).items.some((i) => i.id === link.id),
          );
        },
      );

      await t.test('switch on: payout fixture reserve and dispatch refused', async () => {
        const s = await cash.add('test');
        const fx = await reservePayoutTransfer(
          sql,
          admin,
          { sourceId: s.allocationId, requestKey: randomUUID() },
          payout,
        );
        const calls = payout.calls.length;
        await assert.rejects(dispatchPayoutTransfer(sql, admin, fx.id, {}, payout, on), {
          statusCode: 503,
          code: 'FINANCE_INITIATION_DISABLED',
        });
        const other = await cash.add('test');
        await assert.rejects(
          reservePayoutTransfer(
            sql,
            admin,
            { sourceId: other.allocationId, requestKey: randomUUID() },
            payout,
            on,
          ),
          { statusCode: 503, code: 'FINANCE_INITIATION_DISABLED' },
        );
        assert.equal(payout.calls.length, calls, 'no provider call');
        const [row] =
          await sql`SELECT dispatched_at FROM payout_transfer_fixture WHERE id=${fx.id}`;
        assert.equal(row.dispatched_at, null);
      });

      await t.test(
        'switch on: owner cancel-upcoming records refund obligations but sends no refund',
        async () => {
          const posts = refundPosts();
          const refundsBefore = (await sql`SELECT count(*)::int n FROM refund`)[0].n;
          const preview = await previewOwnerCancelUpcoming(sql, f.owner, f.listing);
          const done = await ownerCancelUpcoming(sql, f.owner, {
            rentableId: f.listing,
            hash: preview.hash,
            expectedVersion: preview.version,
            requestKey: randomUUID(),
            reason: 'A water pipe burst and the property is closed for repairs.',
          });
          assert.ok(done.results.some((r) => r.orderId === a.orderId && r.outcome === 'cancelled'));
          const created =
            await sql`SELECT state FROM refund ORDER BY created_at DESC LIMIT ${(await sql`SELECT count(*)::int n FROM refund`)[0].n - refundsBefore}`;
          assert.ok(created.length >= 1, 'obligations recorded');
          await runRefundJobs(sql, disabled);
          assert.equal(refundPosts(), posts, 'no new provider refund');
          const pending =
            await sql`SELECT r.state,e.dispatched_at FROM refund r LEFT JOIN refund_execution e ON e.refund_id=r.id
          ORDER BY r.created_at DESC LIMIT ${created.length}`;
          assert.ok(pending.every((r) => r.state === 'requested' && r.dispatched_at === null));
        },
      );
    } finally {
      if (previousSwitch === undefined) delete process.env.FINANCE_INITIATION_DISABLED;
      else process.env.FINANCE_INITIATION_DISABLED = previousSwitch;
      await fixture.drop();
    }
  },
);
