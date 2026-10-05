// Extend only the private, disposable localhost QA fixture; no provider calls.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { seedFinanceFixture } from './finance-fixture.js';
import { createDispute } from '../../src/services/disputes/service.js';
const path = process.env.ADMIN_BASELINE_FIXTURE;
const f = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(f.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw Error('Disposable fixture required');
const sql = postgres(f.databaseUrl, { onnotice: () => {} });
try {
  const finance = await seedFinanceFixture(sql, f.ids);
  const dispute = await createDispute(
    sql,
    { kind: 'admin', id: f.ids.admin },
    {
      orderId: finance.test.orderId,
      visitId: finance.test.bookingId,
      kind: 'service',
      subject: 'Recorded finance evidence case',
      body: 'Fixture claim; recorded evidence only, no provider submission.',
      claimedMinor: 20000,
      requestKey: randomUUID(),
    },
  );
  const refunds =
    await sql`SELECT id FROM refund WHERE transaction_id=${finance.live.transactionId} ORDER BY created_at,id`;
  await writeFile(
    path,
    JSON.stringify({ ...f, finance, dispute: dispute.id, refunds: refunds.map((r) => r.id) }),
    { mode: 0o600 },
  );
  await sql`UPDATE rentable SET status='live' WHERE id=${f.ids.listing}`;
  const [visit] =
    await sql`UPDATE booking SET starts_at=now()-interval '1 hour',ends_at=now()+interval '2 hours',blocked_start_at=now()-interval '1 hour',blocked_end_at=now()+interval '2 hours',hours_known=true,local_day=(now() AT TIME ZONE 'Asia/Kolkata')::date WHERE order_id=${f.booking.order} RETURNING id`;
  await sql`INSERT INTO inventory_reservation(rentable_id,booking_id,source,state,blocked_start_at,blocked_end_at) SELECT rentable_id,id,'booking','committed',blocked_start_at,blocked_end_at FROM booking WHERE id=${visit.id}`;
  process.env.CP06_GATE_FIXTURE = path;
  await import('./seed-booking-cases-gate.mjs');
  console.log('Admin finance fixture ready');
} finally {
  await sql.end();
}
