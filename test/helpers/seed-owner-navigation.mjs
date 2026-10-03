import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';
import { encryptSession } from '../../src/services/auth/session-crypto.js';
process.env.SESSION_SECRET = 'cp06-local-fixture-signing-secret-not-for-deployment';
const fixture = JSON.parse(await readFile(process.env.CP06_GATE_FIXTURE, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
const sql = postgres(fixture.databaseUrl);
try {
  await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${fixture.ids.other}`;
  fixture.tokens.other = await encryptSession({
    userId: fixture.ids.other,
    role: 'client',
    sessionId: await issuePortalSession(sql, 'client', fixture.ids.other, 3600),
  });
  await writeFile(process.env.CP06_GATE_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
} finally {
  await sql.end();
}
