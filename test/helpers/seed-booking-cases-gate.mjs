// CP14 gate: run after seed-pricing-operations-gate.mjs. Creates a paid two-visit order through the real
// checkout services with a stubbed Razorpay transport. Disposable fixture only; never .env DATABASE_URL.
import { readFile, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
const path = process.env.CP06_GATE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
// Same signing secret as serve-property-review, so the API accepts the customer cookie.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: fixture.databaseUrl,
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3106',
  SESSION_SECRET: 'cp06-local-fixture-signing-secret-not-for-deployment',
  CLOUDINARY_CLOUD_NAME: 'cp06-fixture',
  CLOUDINARY_API_KEY: 'cp06-fixture',
  CLOUDINARY_API_SECRET: 'cp06-fixture',
});
const env = {
  ...process.env,
  RAZORPAY_TEST_KEY_ID: 'rzp_test_CP14GATE',
  RAZORPAY_TEST_KEY_SECRET: 'cp14-gate-key-secret',
  RAZORPAY_TEST_WEBHOOK_SECRET: 'cp14-gate-webhook-secret',
};
const { openBookingDates } = await import('@/services/booking/owner-settings.js');
const { createBookingQuote } = await import('@/services/booking/quotes.js');
const { createCheckoutHold } = await import('@/services/booking/checkout.js');
const { setPaymentGatewayConfiguration } = await import('@/services/payments/gateway-settings.js');
const { startCheckoutPayment, verifyCheckoutPayment } =
  await import('@/services/payments/checkout-service.js');
const { propertyToday, addLocalDays } = await import('@/services/domain/booking-dates.js');
const { encryptSession } = await import('@/services/auth/session-crypto.js');
const sql = postgres(fixture.databaseUrl, { onnotice: () => {} });
try {
  const listing = fixture.ids.listing,
    customer = fixture.booking.customer;
  const [d1, d2, d3] = [10, 11, 12].map((n) => addLocalDays(propertyToday(), n));
  await openBookingDates(sql, fixture.ids.owner, { rentableId: listing, from: d1, to: d3 });
  const [{ version }] =
    await sql`SELECT coalesce(max(version),0)::int version FROM payment_gateway_config`;
  await setPaymentGatewayConfiguration(
    sql,
    {
      actorId: fixture.ids.admin,
      expectedVersion: version,
      provider: 'razorpay',
      environment: 'test',
      enabled: true,
      collectionPurpose: 'full',
    },
    env,
  );
  const [row] =
    await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${customer},now()+interval '1 day') RETURNING id`;
  const session = { role: 'customer', userId: customer, sessionId: row.id };
  const quote = await createBookingQuote(
    sql,
    { rentableId: listing, dates: [d1, d2], slot: 'day', guests: 2 },
    { customerId: customer, variables: env },
  );
  const held = await createCheckoutHold(
    sql,
    session,
    {
      rentableId: listing,
      quoteId: quote.id,
      hash: quote.hash,
      version: quote.version,
      idempotencyKey: randomUUID(),
      accepted: true,
    },
    env,
  );
  const capture = {
    id: 'pay_CP14GATE',
    order_id: 'order_CP14GATE',
    amount: held.expectedMinor,
    currency: 'INR',
    status: 'captured',
    captured: true,
  };
  const fetcher = async (target, init) => {
    const route = new URL(target).pathname.replace('/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    const reply =
      route === 'orders'
        ? {
            id: 'order_CP14GATE',
            amount: body.amount,
            currency: 'INR',
            receipt: body.receipt,
            partial_payment: false,
          }
        : route === 'payments/pay_CP14GATE'
          ? capture
          : null;
    return { ok: Boolean(reply), json: async () => reply };
  };
  await startCheckoutPayment(sql, session, held.orderId, { env, fetcher });
  const signature = createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
    .update('order_CP14GATE|pay_CP14GATE')
    .digest('hex');
  const status = await verifyCheckoutPayment(
    sql,
    session,
    { orderId: held.orderId, paymentId: 'pay_CP14GATE', signature },
    { env, fetcher },
  );
  if (status.state !== 'confirmed') throw new Error('Paid gate order did not confirm');
  const visits =
    await sql`SELECT id,reference,amount_rent_minor,amount_fee_minor FROM booking WHERE order_id=${held.orderId} ORDER BY item_position`;
  const token = await encryptSession({
    userId: customer,
    sessionId: row.id,
    role: 'customer',
    accountStatus: 'active',
  });
  await writeFile(
    path,
    JSON.stringify({
      ...fixture,
      tokens: { ...fixture.tokens, customer: token },
      paid: {
        order: held.orderId,
        visits: visits.map((v) => ({
          id: v.id,
          reference: v.reference,
          refundMinor: Number(v.amount_rent_minor) + Number(v.amount_fee_minor),
        })),
        changeDate: d3,
      },
    }),
  );
  console.log('CP14 disposable fixture ready');
} finally {
  await sql.end();
}
