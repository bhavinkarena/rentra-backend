import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';
import { fileBackedRazorpay, providerCaptures } from '../helpers/fake-razorpay.mjs';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

/**
 * Hotel plan, Phase 8. Payouts run on stays paid through the real checkout
 * (fake Razorpay, Test environment, so the run is a statement and moves no
 * money). The acceptance check: the statement reconciles to the paisa with
 * payments − refunds − commission − TCS − TDS (and − GST Rentra owes under
 * s.9(5) for an unregistered hotel). Reviews: only a completed stay.
 */
const env = {
  ...process.env,
  NODE_ENV: 'test',
  RAZORPAY_KEY_ID: 'rzp_test_HOTEL8KEY123',
  RAZORPAY_KEY_SECRET: 'hotel8-disposable-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'hotel8-disposable-webhook-secret',
};

test('Phase 8: hotel post-stay — payouts, statements, analytics, reviews', { skip: !process.env.PORTAL_TEST_DATABASE_URL }, async (t) => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const dir = await mkdtemp(join(tmpdir(), 'hotel8-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await fixture.drop();
  });
  const { sql } = fixture;
  globalThis.__rentraSql = sql;
  process.env.DATABASE_URL = fixture.url;
  Object.assign(process.env, { RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET });
  const { createStayQuote } = await import('@/services/booking/hotel-checkout.js');
  const { createCheckoutHold } = await import('@/services/booking/checkout.js');
  const { startCheckoutPayment, verifyCheckoutPayment } = await import('@/services/payments/checkout-service.js');
  const { setPaymentGatewayConfiguration } = await import('@/services/payments/gateway-settings.js');
  const { previewCancellation, commitCancellation } = await import('@/services/booking/cancellation.js');
  const payouts = await import('@/services/finance/hotel-payouts.js');
  const { getOwnerHotelAnalytics, getAdminHotelAnalytics } = await import('@/services/analytics/hotel-analytics.js');
  const { submitReview, moderateReview, replyToReview } = await import('@/services/reviews/service.js');

  const a = await seedHotel(sql);
  const b = await seedHotel(sql);
  await sql`UPDATE vertical SET status='public' WHERE code='hotel'`;
  // Hotel A is GST-registered; hotel B is not (Rentra owes its GST under s.9(5)).
  await sql`UPDATE hotel_profile SET gst_registered=true, gstin='24ABCDE1234F1Z5' WHERE rentable_id=${a.hotel}`;
  for (const h of [a, b]) {
    await sql`INSERT INTO commission_rule(vertical_code, rentable_id, rate_bps, tier, valid_from, reason, created_by)
      VALUES ('hotel', ${h.hotel}, 1000, 'standard', '2020-01-01', 'Launch commission', ${h.admin})`;
    await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
      VALUES (${h.owner},1,'bank','Hotel Owner','4421','HDFC0001234','same','verified','migration',now(),'fixture','fixture-verification',${'a'.repeat(64)},now())`;
  }
  await setPaymentGatewayConfiguration(sql, { actorId: a.admin, expectedVersion: 0, provider: 'razorpay', environment: 'test', enabled: true, collectionPurpose: 'full' }, env);
  const providerFile = join(dir, 'provider.json');
  const opts = { env, fetcher: fileBackedRazorpay(providerFile) };
  const guest = async () => {
    const id = await seedCustomer(sql);
    const [row] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${id},now()+interval '1 day') RETURNING id`;
    return { role: 'customer', userId: id, sessionId: row.id };
  };
  let offset = 3;
  /** A paid stay; `ahead` days to check-in. */
  async function paidStay(h, plan, ahead = (offset += 3)) {
    const session = await guest();
    const checkIn = addLocalDays(propertyToday(), ahead);
    const quote = await createStayQuote(sql, { rentableId: h.hotel, checkIn, checkOut: addLocalDays(checkIn, 2), rooms: [{ roomTypeId: h.deluxe, ratePlanId: plan, adults: 2, childAges: [] }] }, { customerId: session.userId });
    const held = await createCheckoutHold(sql, session, { rentableId: h.hotel, quoteId: quote.id, hash: quote.hash, version: quote.version, idempotencyKey: randomUUID(), accepted: true, stay: { guestNames: ['Guest One'] } }, env);
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    const paymentId = `pay_H8${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    providerCaptures(providerFile, started.providerOrderId, paymentId);
    await verifyCheckoutPayment(sql, session, { orderId: held.orderId, paymentId, signature: createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${started.providerOrderId}|${paymentId}`).digest('hex') }, opts);
    const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
    return { session, orderId: held.orderId, visitId: visit.id, quote };
  }
  const checkedIn = (visitId) => sql.begin(async (tx) => {
    await tx`ALTER TABLE booking DISABLE TRIGGER visit_transition_proof`;
    await tx`UPDATE booking SET state='handed_over' WHERE id=${visitId}`;
    await tx`ALTER TABLE booking ENABLE TRIGGER visit_transition_proof`;
  });
  const cancel = async (stay) => {
    const preview = await previewCancellation(sql, stay.session, { orderId: stay.orderId, visitIds: [stay.visitId] }, env);
    await commitCancellation(sql, stay.session, { orderId: stay.orderId, visitIds: [stay.visitId], hash: preview.hash, idempotencyKey: randomUUID(), accepted: true }, env);
    return preview;
  };

  // The test week: A1 checked in; A2 non-refundable and cancelled (kept); A3 refundable and cancelled
  // (fully refunded: nothing to pay); A4 not yet started (not payable); B1 checked in at the unregistered hotel.
  const a1 = await paidStay(a, a.deluxeBase);
  await checkedIn(a1.visitId);
  const a2 = await paidStay(a, a.deluxeNonRefundable);
  assert.equal((await cancel(a2)).refundMinor, 0);
  const a3 = await paidStay(a, a.deluxeBase);
  assert.equal((await cancel(a3)).refundMinor, a3.quote.totals.totalMinor);
  const a4 = await paidStay(a, a.deluxeBase, 200);
  const b1 = await paidStay(b, b.deluxeBase);
  await checkedIn(b1.visitId);
  // A run made after every stay but A4 has passed check-in + 24 h.
  const now = new Date(Date.now() + 30 * 86_400_000);

  await t.test('stayLine: money rules and the reconciliation identity', () => {
    const registered = payouts.stayLine({ roomPaidMinor: 1_000_000, taxPaidMinor: 50_000, rateBps: 1000, gstRegistered: true });
    assert.deepEqual(
      [registered.commissionMinor, registered.commissionGstMinor, registered.tcsMinor, registered.tdsMinor, registered.netMinor],
      [100_000, 18_000, 5_000, 1_000, 926_000],
    );
    const unregistered = payouts.stayLine({ roomPaidMinor: 1_000_000, taxPaidMinor: 50_000, rateBps: 1000, gstRegistered: false });
    assert.equal(unregistered.tcsMinor, 0);
    assert.equal(unregistered.gstRentraOwesMinor, 50_000);
    assert.equal(unregistered.netMinor, 1_000_000 - 100_000 - 18_000 - 1_000);
    assert.throws(() => payouts.stayLine({ roomPaidMinor: 100, roomRefundedMinor: 200, rateBps: 1000, gstRegistered: true }), RangeError);
    assert.equal(payouts.nextPayoutDate('2026-10-21'), '2026-10-27'); // Wednesday → next Tuesday
    assert.equal(payouts.nextPayoutDate('2026-10-27'), '2026-10-27');
  });

  let preview;
  await t.test('payout run: eligibility, and the statement reconciles to the paisa', async () => {
    preview = await payouts.previewPayoutRun(sql, a.admin, { environment: 'test' }, { now });
    const ids = preview.lines.map((line) => line.bookingId).sort();
    assert.deepEqual(ids, [a1.visitId, a2.visitId, b1.visitId].sort(), 'checked-in and kept-charge stays only');
    // Payments and refunds straight from the ledger, not from the service. The guest service fee
    // (Story 2.2) is Rentra's money, so the owner statement reconciles to rent and tax only.
    const [ledger] = await sql`SELECT
        (SELECT sum(pa.actual_minor) FROM payment_allocation pa WHERE pa.booking_id IN ${sql(ids)} AND pa.component <> 'fee')::bigint AS paid,
        (SELECT coalesce(sum(ra.expected_minor), 0) FROM refund_allocation ra JOIN refund f ON f.id = ra.refund_id
          WHERE ra.booking_id IN ${sql(ids)} AND f.state <> 'failed' AND ra.component <> 'fee')::bigint AS refunded`;
    assert.ok(preview.lines.every((line) => line.commissionMinor === 0 && line.commissionGstMinor === 0), 'guest-fee stays pay no commission');
    const tot = preview.totals;
    assert.equal(tot.paidMinor, Number(ledger.paid));
    assert.equal(tot.refundedMinor, Number(ledger.refunded));
    assert.equal(tot.netMinor, tot.paidMinor - tot.refundedMinor - tot.gstRentraOwesMinor - tot.commissionMinor - tot.commissionGstMinor - tot.tcsMinor - tot.tdsMinor);
    for (const line of preview.lines) {
      assert.equal(line.netMinor, line.paidMinor - line.refundedMinor - line.gstRentraOwesMinor - line.commissionMinor - line.commissionGstMinor - line.tcsMinor - line.tdsMinor);
    }
    const lineB = preview.lines.find((line) => line.bookingId === b1.visitId);
    assert.equal(lineB.tcsMinor, 0, 'no TCS for an unregistered hotel');
    assert.equal(lineB.gstToHotelMinor, 0);
    assert.equal(lineB.gstRentraOwesMinor, b1.quote.totals.taxMinor);
    const lineA2 = preview.lines.find((line) => line.bookingId === a2.visitId);
    assert.equal(lineA2.roomMinor, a2.quote.totals.roomMinor, 'a non-refundable cancellation pays out the kept room');
  });

  await t.test('a guest-fee stay never waits for a commission rule (Story 2.2)', async () => {
    const c = await seedHotel(sql);
    await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
      VALUES (${c.owner},1,'bank','Hotel Owner','4421','HDFC0001234','same','verified','migration',now(),'fixture','fixture-verification',${'a'.repeat(64)},now())`;
    const c1 = await paidStay(c, c.deluxeBase);
    await checkedIn(c1.visitId);
    const run = await payouts.previewPayoutRun(sql, a.admin, { environment: 'test' }, { now });
    assert.ok(!run.held.some((line) => line.bookingId === c1.visitId));
    const line = run.lines.find((l) => l.bookingId === c1.visitId);
    assert.equal(line.commissionMinor, 0);
    await sql`INSERT INTO commission_rule(vertical_code, rentable_id, rate_bps, tier, valid_from, reason, created_by)
      VALUES ('hotel', ${c.hotel}, 1000, 'standard', '2020-01-01', 'Launch commission', ${c.admin})`;
    preview = await payouts.previewPayoutRun(sql, a.admin, { environment: 'test' }, { now });
  });

  await t.test('execute: stale preview refused; one run; paid once; settle with UTR', async () => {
    await assert.rejects(payouts.executePayoutRun(sql, a.admin, { environment: 'test', previewHash: 'f'.repeat(64) }, { now }), { code: 'STALE_PREVIEW' });
    const run = await payouts.executePayoutRun(sql, a.admin, { environment: 'test', previewHash: preview.previewHash }, { now });
    assert.equal(run.stays, 4);
    const rows = await sql`SELECT booking_id, gross_minor::int AS gross, net_minor::int AS net, actual_net_minor::int AS actual, funding_allocation_id FROM payout WHERE payout_run_id=${run.id}`;
    assert.equal(rows.length, 6, 'room row per stay, plus a GST row per stay at the registered hotel');
    assert.ok(rows.every((row) => row.actual === 0 && row.funding_allocation_id === null), 'a test run moves no money');
    assert.equal(rows.reduce((sum, row) => sum + row.net, 0), preview.totals.netMinor);
    const again = await payouts.previewPayoutRun(sql, a.admin, { environment: 'test' }, { now });
    assert.equal(again.lines.length, 0, 'a stay is in one run only');
    await assert.rejects(payouts.executePayoutRun(sql, a.admin, { environment: 'test', previewHash: again.previewHash }, { now }), { code: 'NO_PAYABLE_STAYS' });
    await assert.rejects(payouts.settlePayoutRun(sql, a.admin, { runId: run.id, utr: 'x' }), { code: 'INVALID_UTR' });
    await payouts.settlePayoutRun(sql, a.admin, { runId: run.id, utr: 'HDFCN2026102712345' });
    const [{ paid }] = await sql`SELECT count(*) FILTER (WHERE status='paid' AND utr='HDFCN2026102712345')::int AS paid FROM payout WHERE payout_run_id=${run.id}`;
    assert.equal(paid, 6);
    await assert.rejects(payouts.settlePayoutRun(sql, a.admin, { runId: run.id, utr: 'HDFCN2026102712345' }), { code: 'ALREADY_SETTLED' });

    // Owner A's statement and invoice; owner B never sees A's lines.
    const earnings = await payouts.getOwnerHotelEarnings(sql, a.owner, {});
    assert.equal(earnings.payouts.length, 1);
    const statement = await payouts.getOwnerPayoutStatement(sql, a.owner, run.id);
    assert.deepEqual(statement.lines.map((line) => line.bookingId).sort(), [a1.visitId, a2.visitId].sort());
    assert.equal(statement.utr, 'HDFCN2026102712345');
    const invoice = await payouts.getCommissionInvoice(sql, a.owner, run.id, {});
    assert.equal(invoice.draft, true, 'no invented company details');
    assert.equal(invoice.invoiceNumber, null);
    assert.equal(invoice.lines[0].totalMinor, statement.totals.commissionMinor + statement.totals.commissionGstMinor);
    assert.equal(invoice.lines[0].cgstMinor + invoice.lines[0].sgstMinor, statement.totals.commissionGstMinor);
    const issued = await payouts.getCommissionInvoice(sql, a.owner, run.id, { RENTRA_LEGAL_NAME: 'Rentra Test Pvt Ltd', RENTRA_GSTIN: '24AAAAA0000A1Z5', RENTRA_LEGAL_ADDRESS: 'Surat' });
    assert.match(issued.invoiceNumber, /^RC-P-0001-/);
    const statementB = await payouts.getOwnerPayoutStatement(sql, b.owner, run.id);
    assert.deepEqual(statementB.lines.map((line) => line.bookingId), [b1.visitId]);
    await assert.rejects(payouts.getOwnerPayoutStatement(sql, (await seedHotel(sql)).owner, run.id), (error) => error.statusCode === 404);
  });

  await t.test('analytics: owner sees only their hotels; admin commission matches the run', async () => {
    const from = propertyToday();
    const to = addLocalDays(from, 220);
    const owner = await getOwnerHotelAnalytics(sql, a.owner, { from, to });
    assert.deepEqual(owner.hotels.map((h) => h.id), [a.hotel]);
    // A1 (2 nights) and A4 (2 nights) hold rooms; A2/A3 were cancelled and released.
    assert.equal(owner.kpis.roomNightsSold, 4);
    assert.equal(owner.kpis.bookings, 4);
    assert.equal(owner.kpis.cancelled, 2);
    assert.ok(owner.kpis.adrMinor > 0 && owner.kpis.occupancy > 0);
    await assert.rejects(getOwnerHotelAnalytics(sql, a.owner, { from, to, hotelId: b.hotel }), (error) => error.statusCode === 403);
    const admin = await getAdminHotelAnalytics(sql, a.admin, { from, to });
    assert.equal(admin.kpis.commissionMinor, preview.totals.commissionMinor);
    assert.equal(admin.kpis.roomNightsSold, 8); // A1, A4, B1, C1
  });

  await t.test('reviews: only a completed stay, with hotel sub-scores; the owner replies', async () => {
    // A completed stay outside checkout (real provenance), as the visit lifecycle records it.
    const customer = await seedCustomer(sql);
    const [session] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${customer},now()+interval '1 day') RETURNING id`;
    const stayAt = async (state) => {
      const [order] = await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash)
        VALUES (${`HT-${randomUUID()}`},${customer},${a.hotel},'confirmed','INR','Asia/Kolkata','hotel-v1','hotel-v1','{}','{}',500000,0,0,${randomUUID()},${'b'.repeat(64)}) RETURNING id`;
      const [visit] = await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,state,visit_provenance)
        VALUES (${`R${randomUUID().slice(0, 12)}`},${a.hotel},${customer},${order.id},1,current_date-3,'stay',2,now()-interval '3 days',now()-interval '1 day',now()-interval '3 days',now()-interval '1 day',true,'INR','Asia/Kolkata',500000,0,0,${state},'real') RETURNING id`;
      return visit.id;
    };
    const s = { role: 'customer', userId: customer, sessionId: session.id };
    const review = { rating: 5, body: 'Spotless room, kind front desk and an easy check-in.', cleanliness: 5, staff: 5, location: 4, comfort: 5, valueForMoney: 4, facilities: 4, travellerType: 'couple' };
    await assert.rejects(submitReview(sql, s, { ...review, visitId: await stayAt('confirmed') }), { code: 'NOT_ELIGIBLE' });
    const completed = await stayAt('completed');
    const saved = await submitReview(sql, s, { ...review, visitId: completed });
    const [row] = await sql`SELECT * FROM review WHERE id=${saved.id}`;
    assert.deepEqual([row.staff, row.location, row.comfort, row.facilities, row.traveller_type], [5, 4, 5, 4, 'couple']);
    const moderation = { id: row.id, version: row.version, state: 'published', category: 'meets_policy', reason: 'Meets the review policy.' };
    const token = (await moderateReview(sql, a.admin, { ...moderation, preview: true })).preview.token;
    await moderateReview(sql, a.admin, { ...moderation, previewToken: token });
    const [published] = await sql`SELECT version FROM review WHERE id=${row.id}`;
    const reply = { id: row.id, version: published.version, body: 'Thank you for staying with us. See you again soon!' };
    const replyToken = (await replyToReview(sql, a.owner, { ...reply, preview: true })).preview.token;
    await replyToReview(sql, a.owner, { ...reply, previewToken: replyToken });
    const [answered] = await sql`SELECT owner_reply FROM review WHERE id=${row.id}`;
    assert.match(answered.owner_reply, /Thank you/);
    const analytics = await getOwnerHotelAnalytics(sql, a.owner, {});
    assert.equal(analytics.reviews.subScores.staff, 5);
    assert.deepEqual(analytics.reviews.travellers.map((r) => r.type), ['couple']);
  });
});
