// Prepare an already-started Test stay for browser departure QA, in the guarded fixture only.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';
import { fileBackedRazorpay, providerCaptures } from './fake-razorpay.mjs';
import { allocateByWeights } from '../../src/services/domain/booking-money.js';
const path = resolve('tmp/story312/fixture.json');
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
assert.match(url.pathname, /^\/rentra_test_[a-f0-9]{32}$/);
const sql = postgres(url.href, { max: 1 });
globalThis.__rentraSql = sql;
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url.href,
  RAZORPAY_KEY_ID: 'rzp_test_STORY312KEY',
  RAZORPAY_KEY_SECRET: 'story312-fake-provider-secret',
  RAZORPAY_WEBHOOK_SECRET: 'story312-fake-webhook-secret',
});
try {
  const { createBookingQuote } = await import('@/services/booking/quotes.js');
  const { createCheckoutHold } = await import('@/services/booking/checkout.js');
  const { startCheckoutPayment, verifyCheckoutPayment } =
    await import('@/services/payments/checkout-service.js');
  const { ids } = fixture;
  const [auth] =
    await sql`SELECT id FROM auth_session WHERE user_id=${ids.customer} ORDER BY expires_at DESC LIMIT 1`;
  const session = { role: 'customer', userId: ids.customer, sessionId: auth.id };
  const policy = {
    version: 1,
    windows: [
      { hoursBefore: 24, pct: 100 },
      { hoursBefore: 0, pct: 50 },
    ],
    atOrAfterCheckInPct: 0,
    earlyDeparture: { offered: true, pct: 100 },
  };
  await sql`UPDATE rentable SET cancellation_policy=${JSON.stringify(policy)}::text::jsonb WHERE id=${ids.apartment}`;
  fixture.departures = [];
  fixture.departureGeneration = (fixture.departureGeneration || 0) + 1;
  for (const width of [1440, 390]) {
    const from = addLocalDays(
      propertyToday(),
      (width === 1440 ? 100 : 110) + fixture.departureGeneration * 20,
    );
    const q = await createBookingQuote(
      sql,
      {
        kind: 'apartment',
        rentableId: ids.apartment,
        checkIn: from,
        checkOut: addLocalDays(from, 3),
        adults: 2,
        pets: 1,
      },
      { customerId: ids.customer },
    );
    const held = await createCheckoutHold(
      sql,
      session,
      {
        rentableId: ids.apartment,
        quoteId: q.id,
        hash: q.hash,
        version: q.version,
        idempotencyKey: randomUUID(),
        accepted: true,
        petsConfirmed: true,
        stay: { guestNames: ['Fixture Guest'] },
      },
      process.env,
    );
    const providerFile = resolve('tmp/story312/provider.json');
    const opts = { env: process.env, fetcher: fileBackedRazorpay(providerFile) };
    const started = await startCheckoutPayment(sql, session, held.orderId, opts);
    const paymentId = `pay_DEPART${randomUUID().replaceAll('-', '')}`;
    providerCaptures(providerFile, started.providerOrderId, paymentId);
    const signature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${started.providerOrderId}|${paymentId}`)
      .digest('hex');
    assert.equal(
      (
        await verifyCheckoutPayment(
          sql,
          session,
          { orderId: held.orderId, paymentId, signature },
          opts,
        )
      ).state,
      'confirmed',
    );
    const apartment = q.visits[0].apartment;
    const unusedRentMinor = apartment.nightly.slice(1).reduce((n, row) => n + row.rateMinor, 0);
    const rentFee = allocateByWeights(q.totals.feeMinor, [
      apartment.rentMinor,
      apartment.cleaningMinor,
      apartment.petMinor,
    ])[0];
    const unusedFeeMinor = allocateByWeights(
      rentFee,
      apartment.nightly.map((night) => night.rateMinor),
    )
      .slice(1)
      .reduce((sum, fee) => sum + fee, 0);
    fixture.departures.push({
      width,
      orderId: held.orderId,
      from,
      expected: {
        consumedNights: [from],
        unusedNights: [addLocalDays(from, 1), addLocalDays(from, 2)],
        unusedRentMinor,
        unusedFeeMinor,
        refundMinor: unusedRentMinor + unusedFeeMinor,
      },
    });
  }
  await writeFile(path, JSON.stringify(fixture));
  console.log(
    'Prepared two confirmed fake Test stays; activate each separately before its browser run.',
  );
} finally {
  await sql.end();
}
