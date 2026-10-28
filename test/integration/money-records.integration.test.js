import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { readBookingRecord } from '../../src/services/booking/records.js';
import { readOwnerEarnings } from '../../src/services/finance/owner-earnings.js';
import { bookingSummary } from '../../src/services/domain/booking-record.js';
import { bookingCalendar } from '../../src/services/domain/booking-calendar.js';

const keys = (value, found = new Set()) => {
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { found.add(k); keys(v, found); }
  return found;
};

test('Story 2.16 distinct guest, owner and admin money records', { skip: !process.env.PORTAL_TEST_DATABASE_URL }, async () => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const { sql } = fixture;
  try {
    const f = await seedReviewFixture(sql);
    const fin = await seedFinanceFixture(sql, f);
    const [{ customer_id: guestId }] = await sql`SELECT customer_id FROM booking_order WHERE id=${fin.live.orderId}`;
    const session = async userId => { const [row] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${userId},now()+interval '1 day') RETURNING id`;
      return { kind: 'customer', session: { role: 'customer', userId, sessionId: row.id } }; };
    const owner = { kind: 'owner', id: f.owner }, guest = await session(guestId), admin = { kind: 'admin', id: f.admin };
    // An unpaid second payment order on the live booking: no verified capture.
    const key = randomUUID();
    const [unpaid] = await sql`INSERT INTO payment_order(booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash)
      VALUES (${fin.live.orderId},'fixture','live','real','INR','full',5000,${key},${'f'.repeat(64)}) RETURNING id`;

    const ownerLive = await readBookingRecord(sql, owner, fin.live.orderId);
    const ownerKeys = keys(ownerLive);
    assert.ok(!ownerKeys.has('providerOrderId') && !ownerKeys.has('providerRefundId') && !ownerKeys.has('payments'));
    assert.equal(ownerLive.guestPayment.state, 'paid');
    assert.equal(ownerLive.guestPayment.environment, 'live');
    assert.deepEqual(ownerLive.guestPayment.refund, { state: 'in_progress', requestedMinor: 30000, refundedMinor: 20000 });
    // Funded actual net, not the quoted net; the payout row wins over the fixture added below.
    assert.deepEqual(ownerLive.visits[0].payout, { state: 'paid', amountMinor: 30000, environment: 'live' });

    const ownerTest = await readBookingRecord(sql, owner, fin.test.orderId);
    assert.deepEqual(ownerTest.visits[0].payout, { state: 'scheduled', amountMinor: null, environment: 'legacy_unknown' });
    assert.equal(ownerTest.guestPayment.state, 'paid');
    assert.equal(ownerTest.guestPayment.mixedEnvironments, false);
    assert.deepEqual(ownerTest.guestPayment.refund, { state: 'none', requestedMinor: 0, refundedMinor: 0 });
    const ownerSim = await readBookingRecord(sql, owner, fin.simulated.orderId);
    assert.equal(ownerSim.visits[0].payout.state, 'not_started');
    assert.equal(ownerSim.guestPayment.environment, 'simulated');

    // Payout DB mapping and precedence. Fixture guards need a rentra_test_ database, so bypass triggers here.
    const visitOf = async o => (await readBookingRecord(sql, owner, o.orderId)).visits[0];
    const extra = {};
    for (const name of ['processing', 'failed', 'frozen', 'unpaid', 'review']) extra[name] = await fin.add('live');
    for (const status of ['processing', 'failed', 'frozen'])
      await sql`INSERT INTO payout(booking_id,client_id,gross_minor,commission_minor,net_minor,status,destination_id) VALUES (${extra[status].bookingId},${f.owner},100000,8000,92000,${status},${fin.destinationId})`;
    await sql.begin(async tx => {
      await tx`SET LOCAL session_replication_role=replica`;
      const fixtureRow = (allocation, state) => tx`INSERT INTO payout_transfer_fixture(source_id,owner_id,destination_id,destination_version,mode,policy,expected_minor,provider,provider_account,actor_id,request_key,request_hash,state,dispatched_at,dispatch_actor_id,dispatch_mode,dispatch_policy)
        VALUES (${allocation},${f.owner},${fin.destinationId},1,'auto','{}',100000,'local-fixture','local-fixture-account',${f.admin},${randomUUID()},${'a'.repeat(64)},${state},now(),${f.admin},'auto','{}')`;
      await fixtureRow(fin.simulated.allocationId, 'unknown');
      await fixtureRow(fin.live.allocationId, 'processing');
      // No verified capture: drop the fixture capture (and its allocations) for this order.
      await tx`DELETE FROM payment_allocation WHERE transaction_id=${extra.unpaid.transactionId}`;
      await tx`DELETE FROM payment_transaction WHERE id=${extra.unpaid.transactionId}`;
      // An unknown refund outcome (allocation reconciliation is a separate concern).
      const k = randomUUID();
      await tx`INSERT INTO refund(reason,reference,transaction_id,provider,environment,mode,currency,state,expected_minor,actual_minor,idempotency_key,request_hash)
        VALUES ('Fixture unknown refund',${k},${extra.review.transactionId},'fixture','live','real','INR','unknown',4000,0,${k},${'d'.repeat(64)})`;
    });
    assert.equal((await visitOf(extra.processing)).payout.state, 'processing');
    assert.equal((await visitOf(extra.failed)).payout.state, 'failed');
    assert.equal((await visitOf(extra.frozen)).payout.state, 'on_hold');
    assert.deepEqual((await visitOf(fin.simulated)).payout, { state: 'needs_check', amountMinor: 100000, environment: 'test' });
    assert.equal((await visitOf(fin.live)).payout.state, 'paid');
    const unpaidOwner = await readBookingRecord(sql, owner, extra.unpaid.orderId);
    assert.equal(unpaidOwner.guestPayment.state, 'unpaid');
    assert.equal(unpaidOwner.guestPayment.receivedMinor, null);
    assert.deepEqual(unpaidOwner.guestPayment.refund, { state: 'none', requestedMinor: 0, refundedMinor: 0 });
    assert.equal((await readBookingRecord(sql, owner, extra.review.orderId)).guestPayment.refund.state, 'needs_review');

    // Owner printable summary and calendar render from the owner shape.
    const ownerAgain = await readBookingRecord(sql, owner, fin.live.orderId);
    const text = bookingSummary(ownerAgain);
    assert.match(text, /Guest payment: Paid in full/);
    assert.match(text, /Guest refunds: Refund in progress/);
    assert.match(text, /Your payout .*: Paid/);
    assert.doesNotMatch(text, /provider reference/i);
    assert.match(bookingCalendar(ownerAgain), /BEGIN:VCALENDAR/);
    const simText = bookingSummary(await readBookingRecord(sql, owner, fin.simulated.orderId));
    assert.match(simText, /Guest payment \(Simulation\)/);

    const guestLive = await readBookingRecord(sql, guest, fin.live.orderId);
    assert.ok(!keys(guestLive).has('payout') && !('guestPayment' in guestLive));
    const unpaidRow = guestLive.payments.find(p => p.id === unpaid.id);
    assert.equal(unpaidRow.capturedMinor, null);
    assert.equal(unpaidRow.actualBankMinor, null);
    assert.equal(guestLive.payments.find(p => p.id === fin.live.paymentId).actualBankMinor, 108000);
    const guestSim = await readBookingRecord(sql, guest, fin.simulated.orderId);
    const guestText = bookingSummary(guestSim);
    assert.match(guestText, /Simulation amount \(not money\)/);
    assert.match(guestText, /actual bank collection: Not applicable \(not live\)/);
    assert.equal(guestSim.payments[0].actualBankMinor, null);
    assert.equal(guestSim.payments[0].simulatedMinor, 108000);

    const adminLive = await readBookingRecord(sql, admin, fin.live.orderId);
    assert.ok(adminLive.payments.length === 2 && !keys(adminLive).has('payout'));

    // Scope: another owner and another guest still get the not-found error.
    const [other] = await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${randomUUID()+'@fixture.invalid'},'client','active','Other') RETURNING id`;
    await assert.rejects(readBookingRecord(sql, { kind: 'owner', id: other.id }, fin.live.orderId), { code: 'BOOKING_NOT_FOUND' });
    const [otherGuest] = await sql`INSERT INTO "user"(email,role,account_status,name) VALUES (${randomUUID()+'@fixture.invalid'},'customer','active','Other') RETURNING id`;
    await assert.rejects(readBookingRecord(sql, await session(otherGuest.id), fin.live.orderId), { code: 'BOOKING_NOT_FOUND' });

    const earnings = await sql.begin(tx => readOwnerEarnings(tx, owner, { month: fin.period, environment: 'live', propertyId: '', page: 1 }));
    assert.equal(earnings.items.find(i => i.id === fin.live.bookingId).payoutState, 'paid');
    const testEarnings = await sql.begin(tx => readOwnerEarnings(tx, owner, { month: fin.period, environment: 'test', propertyId: '', page: 1 }));
    assert.equal(testEarnings.items.find(i => i.id === fin.test.bookingId).payoutState, 'scheduled');

    // Success path: the owner record endpoint sends no-store.
    globalThis.__rentraSql = sql;
    process.env.DATABASE_URL = fixture.url;
    const { runWithContext } = await import('@/runtime/context.js');
    const { encryptSession } = await import('@/services/auth/session-crypto.js');
    const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
    const { detail } = await import('../../src/controllers/records.controller.js');
    const token = await encryptSession({ role: 'client', userId: f.owner, sessionId: await issuePortalSession(sql, 'client', f.owner, 3600) });
    const headers = {};
    let body, failure;
    const res = { set: (h, v) => { headers[h] = v; return res; }, success: (status, data) => { body = { status, data }; return res; } };
    await runWithContext({ req: { cookies: { rentra_session: token } } }, () =>
      detail({ baseUrl: '/api/v1/records/partner', params: { id: fin.live.orderId }, query: {} }, res, e => { failure = e; }));
    assert.equal(failure, undefined);
    assert.equal(body.data.id, fin.live.orderId);
    assert.equal(headers['Cache-Control'], 'private, no-store');
  } finally {
    await fixture.drop();
  }
});

// Runs after the DB test so the controllers first bind to the disposable database.
test('Story 2.16 records and admin payments send private, no-store', async () => {
  const records = await import('../../src/controllers/records.controller.js');
  const payments = await import('../../src/controllers/payments.controller.js');
  for (const handler of [records.detail, records.history, payments.orders, payments.order, payments.refunds, payments.refundDetail]) {
    const headers = {};
    const res = { set: (k, v) => { headers[k] = v; return res; } };
    // An unknown scope / missing id fails after the header is set; the error goes to next.
    await handler({ baseUrl: '/nowhere', params: { id: 'x' }, query: {} }, res, () => {});
    assert.equal(headers['Cache-Control'], 'private, no-store');
  }
});
