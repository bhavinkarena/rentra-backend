// CP30: extend only a disposable published/pricing fixture, never the configured database.
import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import { inviteStaff, consumeInvite } from '@/services/auth/staff-team.js';
import { issuePortalSession } from '@/services/auth/portal-sessions.js';
import { encryptSession } from '@/services/auth/session-crypto.js';

const path = process.env.CP06_GATE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/rentra_test_'))
  throw new Error('Disposable fixture required');
process.env.SESSION_SECRET = 'cp06-local-fixture-signing-secret-not-for-deployment';
const sql = postgres(fixture.databaseUrl, { onnotice: () => {} });
try {
  const invited = await inviteStaff(sql, fixture.ids.owner, {
    name: 'Cross-role Caretaker',
    phone: '9876543210',
    evidence: true,
    propertyIds: [fixture.ids.listing],
  });
  await consumeInvite(sql, invited.token);
  fixture.ids.staff = invited.staffId;
  fixture.tokens.staff = await new SignJWT({
    staffId: invited.staffId,
    sessionId: await issuePortalSession(sql, 'staff', invited.staffId, 3600),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('rentra:staff')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const [customer] = await sql`INSERT INTO "user"(email,role,account_status,name)
    VALUES ('foreign-customer@fixture.invalid','customer','active','Foreign Customer') RETURNING id`;
  await sql`UPDATE "user" SET profile_completed_at=now(),profile_version=1,consent_updated_at=now() WHERE id=${customer.id}`;
  const [session] = await sql`INSERT INTO auth_session(user_id,expires_at)
    VALUES (${customer.id},now()+interval '1 day') RETURNING id`;
  fixture.tokens.foreignCustomer = await encryptSession({
    userId: customer.id,
    role: 'customer',
    sessionId: session.id,
  });
  await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
  console.log('CP30 disposable cross-role fixture ready');
} finally {
  await sql.end();
}
