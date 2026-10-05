// Extend only the explicit disposable admin fixture; no production database or provider access.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { seedFinanceFixture } from './finance-fixture.js';
import { createBookingCase } from '../../src/services/booking/booking-cases.js';
const path = process.env.ADMIN_BASELINE_FIXTURE;
const f = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(f.databaseUrl);
assert.equal(url.hostname, '127.0.0.1');
assert.ok(url.pathname.startsWith('/rentra_test_'));
const sql = postgres(f.databaseUrl, { onnotice: () => {} });
try {
  const [visit] =
    await sql`UPDATE booking SET starts_at=now()-interval '1 hour',ends_at=now()+interval '2 hours',blocked_start_at=now()-interval '1 hour',blocked_end_at=now()+interval '2 hours',hours_known=true,visit_provenance='real',local_day=(now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_id=${f.booking.order} RETURNING id`;
  await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) SELECT rentable_id,id,'booking','committed',blocked_start_at,blocked_end_at FROM booking WHERE id=${visit.id}`;
  await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,starts_at,ends_at,hours_known,blocked_start_at,blocked_end_at,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
    VALUES ('ADMIN6-CANCELLED',${f.ids.listing},${f.booking.customer},${f.booking.order},2,current_date+20,'day','cancelled',now()+interval '20 days',now()+interval '20 days 8 hours',true,now()+interval '20 days',now()+interval '20 days 8 hours','INR','Asia/Kolkata',100000,8000,0)`;
  await sql`UPDATE booking_order SET listing_snapshot=listing_snapshot||'{"contact":{"name":"Fixture Guest","phone":"9000000077"}}'::jsonb,policy_snapshot='{"cancellationTier":"flexible","houseRules":{"smoking":"not_allowed"}}'::jsonb WHERE id=${f.booking.order}`;
  const finance = await seedFinanceFixture(sql, f.ids);
  // Reuse the real checkout fixture with stubbed Razorpay transport.
  await sql`UPDATE rentable SET status='live' WHERE id=${f.ids.listing}`;
  process.env.CP06_GATE_FIXTURE = path;
  await import('./seed-booking-cases-gate.mjs');
  const paidFixture = JSON.parse(await readFile(path, 'utf8'));
  const paid = paidFixture.paid;
  const c = await createBookingCase(
    sql,
    { kind: 'owner', id: f.ids.owner },
    {
      orderId: paid.order,
      type: 'owner_cancellation',
      visitIds: [paid.visits[0].id],
      reason: 'The water pump failed; the property cannot host guests.',
      requestKey: randomUUID(),
    },
  );
  const operationalCase = await createBookingCase(
    sql,
    { kind: 'admin', id: f.ids.admin },
    {
      orderId: f.booking.order,
      type: 'operational',
      requesterKind: 'admin',
      source: 'internal',
      visitIds: [visit.id],
      reason: 'Please review this upcoming arrival and its operational evidence.',
      requestKey: randomUUID(),
    },
  );
  await writeFile(
    path,
    JSON.stringify({
      ...paidFixture,
      bookings: {
        visit: visit.id,
        case: c.id,
        operationalCase: operationalCase.id,
        paidOrder: paid.order,
        paidVisit: paid.visits[0].id,
        liveOrder: finance.live.orderId,
      },
    }),
    { mode: 0o600 },
  );
  console.log('Admin booking fixture ready');
} finally {
  await sql.end();
}
