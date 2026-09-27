// CP19 gate: run after seed-pricing-operations-gate.mjs with the same FAKE_RAZORPAY_STATE and
// RAZORPAY_TEST_* values as the fixture API. Disposable fixture only; never .env DATABASE_URL.
import { readFile, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { fileBackedRazorpay, providerCaptures } from './fake-razorpay.mjs';
const path = process.env.CP06_GATE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
const state = process.env.FAKE_RAZORPAY_STATE;
if (!state || !process.env.RAZORPAY_TEST_KEY_ID)
  throw new Error('Set FAKE_RAZORPAY_STATE and RAZORPAY_TEST_* like the fixture API');
Object.assign(process.env, { NODE_ENV: 'test' });
const env = { ...process.env };
const fetcher = fileBackedRazorpay(state);
const { openBookingDates } = await import('@/services/booking/owner-settings.js');
const { createBookingQuote } = await import('@/services/booking/quotes.js');
const { createCheckoutHold } = await import('@/services/booking/checkout.js');
const { previewCancellation, commitCancellation } =
  await import('@/services/booking/cancellation.js');
const { setPaymentGatewayConfiguration } = await import('@/services/payments/gateway-settings.js');
const { startCheckoutPayment, verifyCheckoutPayment } =
  await import('@/services/payments/checkout-service.js');
const { propertyToday, addLocalDays } = await import('@/services/domain/booking-dates.js');
const sql = postgres(fixture.databaseUrl, { onnotice: () => {} });
try {
  const listing = fixture.ids.listing,
    customer = fixture.booking.customer;
  const days = [10, 11, 12, 13].map((n) => addLocalDays(propertyToday(), n));
  await openBookingDates(sql, fixture.ids.owner, {
    rentableId: listing,
    from: days[0],
    to: days.at(-1),
  });
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
  const hold = async (dates) => {
    const quote = await createBookingQuote(
      sql,
      { rentableId: listing, dates, slot: 'day', guests: 2 },
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
    const started = await startCheckoutPayment(sql, session, held.orderId, { env, fetcher });
    return { ...held, providerOrderId: started.providerOrderId };
  };
  // Paid two-visit order with one visit cancelled by the customer → a pending refund obligation.
  const paid = await hold([days[0], days[1]]);
  providerCaptures(state, paid.providerOrderId, 'pay_FAKEPAID');
  const signature = createHmac('sha256', env.RAZORPAY_TEST_KEY_SECRET)
    .update(`${paid.providerOrderId}|pay_FAKEPAID`)
    .digest('hex');
  await verifyCheckoutPayment(
    sql,
    session,
    { orderId: paid.orderId, paymentId: 'pay_FAKEPAID', signature },
    { env, fetcher },
  );
  const [, second] =
    await sql`SELECT id FROM booking WHERE order_id=${paid.orderId} ORDER BY item_position`;
  const estimate = await previewCancellation(
    sql,
    session,
    { orderId: paid.orderId, visitIds: [second.id] },
    env,
  );
  await commitCancellation(
    sql,
    session,
    {
      orderId: paid.orderId,
      visitIds: [second.id],
      hash: estimate.hash,
      idempotencyKey: randomUUID(),
      accepted: true,
    },
    env,
  );
  // Stuck: the provider captured it but Rentra never heard back.
  const stuck = await hold([days[2]]);
  providerCaptures(state, stuck.providerOrderId, 'pay_FAKESTUCK');
  // Unknown: the provider has no payment for this order.
  const unknown = await hold([days[3]]);
  // A simulated order (dummy provider, no money moved).
  const [simOrder] =
    await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,state,payment_mode)
    VALUES ('SIM-CP19',${customer},${listing},'INR','Asia/Kolkata','v1','v1','{}','{"title":"Simulated farm"}',50000,4000,0,${randomUUID()},${'e'.repeat(64)},'confirmed','simulated') RETURNING id`;
  const [simVisit] =
    await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,state,amount_rent,amount_fee,starts_at,ends_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,payment_mode,units_booked,guests)
    VALUES ('SIM-CP19-V',${listing},${customer},${simOrder.id},1,current_date+40,current_date+40,'day','confirmed',500,40,now()+interval '40 days',now()+interval '40 days 8 hours','INR','Asia/Kolkata',50000,4000,0,'simulated',1,2) RETURNING id`;
  const [simPayment] =
    await sql`INSERT INTO payment_order(booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,state)
    VALUES (${simOrder.id},'dummy','simulated','simulated','INR','full',54000,${randomUUID()},${'f'.repeat(64)},'succeeded') RETURNING id`;
  const [simAttempt] =
    await sql`INSERT INTO payment_attempt(payment_order_id,provider,environment,mode,currency,attempt_number,expected_minor,state)
    VALUES (${simPayment.id},'dummy','simulated','simulated','INR',1,54000,'succeeded') RETURNING id`;
  await sql.begin(async (tx) => {
    const [txn] =
      await tx`INSERT INTO payment_transaction(attempt_id,reference,provider,environment,mode,currency,kind,outcome,expected_minor,simulated_minor)
      VALUES (${simAttempt.id},'DUMMY_TXN_CP19','dummy','simulated','simulated','INR','simulated','succeeded',54000,54000) RETURNING id`;
    await tx`INSERT INTO payment_allocation(transaction_id,booking_id,component,simulated_minor) VALUES (${txn.id},${simVisit.id},'rent',54000)`;
  });
  // New attempts paused; outstanding obligations must still reconcile.
  await setPaymentGatewayConfiguration(
    sql,
    {
      actorId: fixture.ids.admin,
      expectedVersion: version + 1,
      provider: 'razorpay',
      environment: 'test',
      enabled: false,
      collectionPurpose: 'full',
    },
    env,
  );
  await writeFile(
    path,
    JSON.stringify({
      ...fixture,
      payments: { paid, stuck, unknown, simulated: { paymentOrderId: simPayment.id } },
    }),
  );
  console.log('CP19 disposable fixture ready');
} finally {
  await sql.end();
}
