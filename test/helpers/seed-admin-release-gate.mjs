// Phase 12 release fixture: layer the booking/case/refund dataset over the review fixture.
// Disposable localhost database only; no provider calls.
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const path = process.env.ADMIN_BASELINE_FIXTURE;
const f = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(f.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw Error('Disposable fixture required');
if (!f.review?.current) throw Error('Start the fixture with ADMIN_REVIEW_FIXTURE=1');
const sql = postgres(f.databaseUrl, { onnotice: () => {} });
try {
  const [before] = await sql`SELECT status FROM rentable WHERE id=${f.ids.listing}`;
  // The booking seeder must publish the property to check out; the journey then reviews it.
  await import('./seed-admin-bookings-gate.mjs');
  await sql`UPDATE rentable SET status=${before.status} WHERE id=${f.ids.listing}`;
  console.log('Admin release fixture ready; property status restored to', before.status);
} finally {
  await sql.end();
}
