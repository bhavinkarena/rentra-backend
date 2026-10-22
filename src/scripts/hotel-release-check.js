// Hotels launch readiness (hotel plan, Phase 9): npm run release:hotels -- beta|public. Read-only.
import postgres from 'postgres';
import { inspectHotelRelease } from '../services/operations/hotel-release.js';

const stage = process.argv[2] || 'beta';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  connect_timeout: 10,
});
try {
  const report = await inspectHotelRelease(sql, stage);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
} finally {
  await sql.end();
}
