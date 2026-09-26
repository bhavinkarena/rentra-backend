// CP13 gate: run after seed-pricing-operations-gate.mjs. Disposable fixture only; never .env DATABASE_URL.
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const fixture = JSON.parse(await readFile(process.env.CP06_GATE_FIXTURE, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
if (!fixture.operationalVisit) throw new Error('Run seed-pricing-operations-gate.mjs first');
const sql = postgres(fixture.databaseUrl);
try {
  // The due visit becomes a real visit, so its evidence is actual rather than simulated.
  await sql`UPDATE booking SET visit_provenance='real' WHERE id=${fixture.operationalVisit}`;
  console.log('CP13 disposable fixture ready');
} finally {
  await sql.end();
}
