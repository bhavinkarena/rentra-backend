// Extend only the explicit disposable admin fixture. Never load the production .env.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { recordOnboardingDestination } from '../../src/services/payouts/destinations.js';
import { createSupportRequest } from '../../src/services/support/service.js';

const path = process.env.ADMIN_BASELINE_FIXTURE;
const fixture = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(fixture.databaseUrl);
assert.equal(url.hostname, '127.0.0.1');
assert.ok(url.pathname.startsWith('/rentra_test_'));
const sql = postgres(fixture.databaseUrl, { onnotice: () => {} });
try {
  const destination = await recordOnboardingDestination(sql, fixture.ids.owner, {
    method: 'upi',
    upiId: 'property.owner@okaxis',
    holderName: 'Property Owner',
  });
  const [session] =
    await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${fixture.booking.customer}, now()+interval '1 day') RETURNING id`;
  await sql`INSERT INTO customer_privacy_request(customer_id,kind) VALUES (${fixture.booking.customer}, 'access')`;
  const support = await createSupportRequest(
    sql,
    {
      kind: 'customer',
      session: { role: 'customer', userId: fixture.booking.customer, sessionId: session.id },
    },
    {
      category: 'booking',
      subject: 'Arrival directions for my booking',
      body: 'Please clarify the arrival directions before the upcoming visit.',
      orderId: fixture.booking.order,
      privacyRequestId: null,
      propertyId: null,
      requestKey: randomUUID(),
    },
  );
  await sql`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,reason)
    VALUES ('admin',${fixture.ids.admin},'user',${fixture.ids.owner},'client_reviewed','Fixture history event'),
      ('admin',${fixture.ids.admin},'user',${fixture.booking.customer},'customer_reviewed','Fixture history event')`;
  // Two pages plus every directory status, without modifying real accounts.
  for (const role of ['client', 'customer']) {
    for (let i = 0; i < 23; i++) {
      const status = ['active', 'suspended', 'blocked', 'pending_application'][i % 4];
      await sql`INSERT INTO "user"(email,role,account_status,name,created_at)
        VALUES (${`${role}${i}@fixture.invalid`},${role},${status},${`Directory ${role} ${i}`},now()-interval '1 year')`;
    }
  }
  await writeFile(
    path,
    JSON.stringify({ ...fixture, people: { destination: destination.id, support: support.id } }),
    { mode: 0o600 },
  );
  console.log('Disposable Phase 7 People dataset ready');
} finally {
  await sql.end();
}
