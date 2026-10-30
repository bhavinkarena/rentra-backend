// Service assertions against the guarded browser fixture; these are NOT browser interactions.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { providerCaptures, fileBackedRazorpay } from './fake-razorpay.mjs';
import { addLocalDays, propertyToday } from '../../src/services/domain/booking-dates.js';

const fixture = JSON.parse(await readFile(resolve('tmp/story312/fixture.json'), 'utf8'));
const url = new URL(fixture.databaseUrl);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55432');
assert.match(url.pathname, /^\/rentra_test_[a-f0-9]{32}$/);
const sql = postgres(url.href, { max: 2 });
globalThis.__rentraSql = sql;
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: url.href,
  RAZORPAY_KEY_ID: 'rzp_test_STORY312KEY',
  RAZORPAY_KEY_SECRET: 'story312-fake-provider-secret',
  RAZORPAY_WEBHOOK_SECRET: 'story312-fake-webhook-secret',
});
const checks = [];
const check = async (name, run) => {
  await run();
  checks.push({ source: 'service', name, ok: true });
  console.log(`PASS ${name}`);
};
try {
  const { createBookingQuote } = await import('@/services/booking/quotes.js');
  const { createCheckoutHold } = await import('@/services/booking/checkout.js');
  const { startCheckoutPayment, verifyCheckoutPayment } =
    await import('@/services/payments/checkout-service.js');
  const { readBookingRecord } = await import('@/services/booking/records.js');
  const { previewCancellation, commitCancellation } =
    await import('@/services/booking/cancellation.js');
  const { apartmentCalendar, changeApartmentCalendar } =
    await import('@/services/booking/apartment-stays.js');
  const { ids } = fixture;
  const [auth] =
    await sql`SELECT id FROM auth_session WHERE user_id=${ids.customer} ORDER BY expires_at DESC LIMIT 1`;
  const [otherAuth] =
    await sql`SELECT id FROM auth_session WHERE user_id=${ids.otherCustomer} ORDER BY expires_at DESC LIMIT 1`;
  const session = { role: 'customer', userId: ids.customer, sessionId: auth.id };
  const day = (n) => addLocalDays(propertyToday(), n + 20);
  const selection = {
    kind: 'apartment',
    rentableId: ids.apartment,
    checkIn: day(40),
    checkOut: day(42),
    adults: 2,
    childAges: [0],
    pets: 1,
  };
  const quote = (value) => createBookingQuote(sql, value, { customerId: ids.customer });
  const reject = (promise, code) =>
    assert.rejects(promise, (e) => {
      assert.equal(e.code, code);
      return true;
    });
  const q = await quote(selection);
  const input = {
    rentableId: ids.apartment,
    quoteId: q.id,
    hash: q.hash,
    version: q.version,
    idempotencyKey: randomUUID(),
    accepted: true,
    petsConfirmed: true,
    stay: { guestNames: ['Fixture Guest'] },
  };
  let held;
  await check('apartment pet and cleaning extras have authoritative amounts', async () => {
    assert.equal(q.totals.petMinor, 30000);
    assert.equal(q.visits[0].apartment.cleaningMinor, 100000);
  });
  await check('apartment pet limit refuses quote', async () => {
    await reject(quote({ ...selection, pets: 3 }), 'PETS_OVER_LIMIT');
  });
  await check('accepted hold replay creates one order', async () => {
    held = await createCheckoutHold(sql, session, input, process.env);
    const again = await createCheckoutHold(sql, session, input, process.env);
    assert.equal(again.orderId, held.orderId);
  });
  await check('held whole unit and turnover cannot be quoted again', async () => {
    await reject(quote(selection), 'DATES_UNAVAILABLE');
    await reject(quote({ ...selection, checkIn: day(42), checkOut: day(44) }), 'DATES_UNAVAILABLE');
  });
  const providerFile = resolve('tmp/story312/provider.json');
  const opts = { env: process.env, fetcher: fileBackedRazorpay(providerFile) };
  await check('fake Test capture confirms apartment', async () => {
    const pay = await startCheckoutPayment(sql, session, held.orderId, opts);
    const paymentId = `pay_STORY312${randomUUID().replaceAll('-', '')}`;
    providerCaptures(providerFile, pay.providerOrderId, paymentId);
    const signature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${pay.providerOrderId}|${paymentId}`)
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
  });
  await check('record preserves cleaning charge and refuses another identity', async () => {
    const record = await readBookingRecord(
      sql,
      { kind: 'customer', session },
      held.orderId,
      process.env,
    );
    assert.equal(record.stay.apartment.cleaningMinor, 100000);
    await reject(
      readBookingRecord(
        sql,
        {
          kind: 'customer',
          session: { ...session, userId: ids.otherCustomer, sessionId: otherAuth.id },
        },
        held.orderId,
        process.env,
      ),
      'BOOKING_NOT_FOUND',
    );
  });
  await check('booked dates protected from owner block', async () => {
    const c = await apartmentCalendar(sql, ids.hotel.owner, ids.apartment, {
      from: day(40),
      days: 14,
    });
    await reject(
      changeApartmentCalendar(sql, ids.hotel.owner, ids.apartment, {
        action: 'block',
        from: day(40),
        to: day(40),
        version: c.version,
        calendarFrom: day(40),
        calendarDays: 14,
      }),
      'DATES_BOOKED',
    );
  });
  await check('cancellation reconciles accepted total and releases inventory', async () => {
    const [visit] = await sql`SELECT id FROM booking WHERE order_id=${held.orderId}`;
    const preview = await previewCancellation(sql, session, {
      orderId: held.orderId,
      visitIds: [visit.id],
    });
    assert.equal(preview.refundMinor, q.totals.totalMinor);
    await commitCancellation(sql, session, {
      orderId: held.orderId,
      visitIds: [visit.id],
      hash: preview.hash,
      idempotencyKey: randomUUID(),
      accepted: true,
    });
    assert.ok((await quote(selection)).id);
  });
  await check('partial unblock retains other nights; stale save refused', async () => {
    const scope = { calendarFrom: day(50), calendarDays: 14 };
    const c = await apartmentCalendar(sql, ids.hotel.owner, ids.apartment, {
      from: day(50),
      days: 14,
    });
    const block = await changeApartmentCalendar(sql, ids.hotel.owner, ids.apartment, {
      action: 'block',
      from: day(52),
      to: day(56),
      version: c.version,
      ...scope,
    });
    await reject(
      changeApartmentCalendar(sql, ids.hotel.owner, ids.apartment, {
        action: 'unblock',
        from: day(54),
        to: day(54),
        version: c.version,
        ...scope,
      }),
      'CALENDAR_CHANGED',
    );
    const open = await changeApartmentCalendar(sql, ids.hotel.owner, ids.apartment, {
      action: 'unblock',
      from: day(54),
      to: day(54),
      version: block.version,
      ...scope,
    });
    assert.deepEqual(
      open.nights.slice(2, 7).map((n) => n.state),
      ['blocked', 'blocked', 'open', 'blocked', 'blocked'],
    );
  });
} catch (error) {
  checks.push({
    source: 'service',
    name: 'service matrix completed',
    ok: false,
    detail: `${error.code || error.name}: ${error.message}`,
  });
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir(resolve('docs/qa/story-3-12'), { recursive: true });
  await writeFile(
    resolve('docs/qa/story-3-12/service-results.json'),
    JSON.stringify(checks, null, 2),
  );
  await sql.end();
}
