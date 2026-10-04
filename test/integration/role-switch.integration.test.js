import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { issueSwitchedSession } from '../../src/services/auth/role-switch.js';

const skip = !process.env.PORTAL_TEST_DATABASE_URL;
let fixture, sql;
before(async () => {
  if (skip) return;
  fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  sql = fixture.sql;
  process.env.DATABASE_URL = fixture.url;
});
after(async () => {
  if (skip) return;
  const { sql: pool } = await import('@/config/database.js');
  await pool.end({ timeout: 5 });
  await fixture.drop();
});
async function principal(phone, role = 'customer', verified = true) {
  const [user] = await sql`INSERT INTO "user"(phone,role,account_status,phone_verified_at,name)
    VALUES (${phone},${role},'active',${verified ? new Date() : null},'Switch Person') RETURNING id`;
  const [session] = await sql`INSERT INTO auth_session(user_id,expires_at)
    VALUES (${user.id},now()+interval '1 day') RETURNING id,expires_at`;
  return { userId: user.id, role, sessionId: session.id, expiresAt: session.expires_at };
}
test(
  'round trip creates a pending owner and restores the same customer without extending expiry',
  { skip },
  async () => {
    const source = await principal('9000008801');
    const owner = await issueSwitchedSession(sql, source, 'client');
    assert.equal(owner.role, 'client');
    assert.equal(owner.accountStatus, 'pending_application');
    const customer = await issueSwitchedSession(sql, owner, 'customer');
    assert.equal(customer.userId, source.userId);
    const [session] = await sql`SELECT expires_at FROM auth_session WHERE id=${customer.sessionId}`;
    assert.equal(+session.expires_at, +source.expiresAt);
    const [count] = await sql`SELECT count(*)::int AS n FROM "user" WHERE phone='9000008801'`;
    assert.equal(count.n, 2);
  },
);
test('existing owner is reused and restricted accounts are refused', { skip }, async () => {
  const customer = await principal('9000008802');
  const owner = await principal('9000008802', 'client');
  assert.equal((await issueSwitchedSession(sql, customer, 'client')).userId, owner.userId);
  await sql`UPDATE "user" SET account_status='suspended' WHERE id=${owner.userId}`;
  assert.equal((await issueSwitchedSession(sql, customer, 'client')).code, 'ACCOUNT_RESTRICTED');
});
test('unverified contact fields cannot link either role', { skip }, async () => {
  const owner = await principal('9000008803', 'client', false);
  assert.equal(
    (await issueSwitchedSession(sql, owner, 'customer')).code,
    'PHONE_VERIFICATION_REQUIRED',
  );
  const customer = await principal('9000008803');
  assert.equal((await issueSwitchedSession(sql, customer, 'client')).code, 'ACCOUNT_LINK_REQUIRED');
});
test('expired, revoked and production development sessions cannot switch', { skip }, async () => {
  const source = await principal('9000008804');
  assert.equal(
    (
      await issueSwitchedSession(sql, { ...source, development: true }, 'client', {
        NODE_ENV: 'production',
      })
    ).code,
    'SESSION_INVALID',
  );
  await sql`UPDATE auth_session SET expires_at=now()-interval '1 second' WHERE id=${source.sessionId}`;
  assert.equal((await issueSwitchedSession(sql, source, 'client')).code, 'SESSION_INVALID');
  const revoked = await principal('9000008805');
  await sql`UPDATE auth_session SET revoked_at=now() WHERE id=${revoked.sessionId}`;
  assert.equal((await issueSwitchedSession(sql, revoked, 'client')).code, 'SESSION_INVALID');
});
test(
  'saved roles restore without issuing new sessions and logout revokes both',
  { skip },
  async () => {
    const { createSession, destroySession } = await import('../../src/services/auth/session.js');
    const { switchAccountRole } = await import('../../src/services/auth/role-switch-actions.js');
    const { decryptSession } = await import('../../src/services/auth/session-crypto.js');
    const { runWithContext } = await import('../../src/runtime/context.js');
    const browser = {};
    const res = {
      cookie(name, value) {
        browser[name] = value;
      },
      clearCookie(name) {
        delete browser[name];
      },
    };
    const request = (fn) =>
      runWithContext({ req: { cookies: { ...browser }, headers: {} }, res }, fn);
    const customer = await principal('9000008806');
    await request(() => createSession({ ...customer, accountStatus: 'active' }));
    await assert.rejects(
      request(() => switchAccountRole('client')),
      (error) => error.location === '/partner',
    );
    const owner = await decryptSession(browser.rentra_session);
    assert.equal(owner.role, 'client');
    await assert.rejects(
      request(() => switchAccountRole('customer')),
      (error) => error.location === '/',
    );
    assert.equal((await decryptSession(browser.rentra_session)).sessionId, customer.sessionId);
    await assert.rejects(
      request(() => switchAccountRole('client')),
      (error) => error.location === '/partner',
    );
    assert.equal((await decryptSession(browser.rentra_session)).sessionId, owner.sessionId);
    await request(destroySession);
    assert.equal(browser.rentra_session, undefined);
    assert.equal(browser.rentra_customer_session, undefined);
    assert.equal(browser.rentra_client_session, undefined);
    const rows =
      await sql`SELECT revoked_at FROM auth_session WHERE id IN (${customer.sessionId},${owner.sessionId})`;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.revoked_at));
  },
);

test(
  'a different person’s saved role cookie is never adopted on a shared browser',
  { skip },
  async () => {
    const { createSession } = await import('../../src/services/auth/session.js');
    const { switchAccountRole } = await import('../../src/services/auth/role-switch-actions.js');
    const { encryptSession, decryptSession } =
      await import('../../src/services/auth/session-crypto.js');
    const { runWithContext } = await import('../../src/runtime/context.js');
    const current = await principal('9000008807');
    const other = await principal('9000008808', 'client');
    const browser = {
      rentra_client_session: await encryptSession({ ...other, accountStatus: 'active' }),
    };
    const res = {
      cookie(name, value) {
        browser[name] = value;
      },
    };
    const request = (fn) =>
      runWithContext({ req: { cookies: { ...browser }, headers: {} }, res }, fn);
    await request(() => createSession({ ...current, accountStatus: 'active' }));
    await assert.rejects(
      request(() => switchAccountRole('client')),
      (error) => error.location === '/partner',
    );
    const switched = await decryptSession(browser.rentra_session);
    assert.notEqual(switched.userId, other.userId);
    const [owner] = await sql`SELECT phone FROM "user" WHERE id=${switched.userId}`;
    assert.equal(owner.phone, '9000008807');
  },
);

test(
  'simultaneous switches in opposite directions succeed without duplicate accounts',
  { skip },
  async () => {
    const customer = await principal('9000008809');
    const owner = await principal('9000008809', 'client');
    const results = await Promise.all([
      issueSwitchedSession(sql, customer, 'client'),
      issueSwitchedSession(sql, owner, 'customer'),
    ]);
    assert.equal(results[0].userId, owner.userId);
    assert.equal(results[1].userId, customer.userId);
  },
);

test(
  'switching to booking preserves the signed listing selection and its return path',
  { skip },
  async () => {
    const { createSession } = await import('../../src/services/auth/session.js');
    const { switchAccountRole } = await import('../../src/services/auth/role-switch-actions.js');
    const { signCustomerSelection, readCustomerSelection, SELECTION_COOKIE } =
      await import('../../src/services/auth/customer-selection.js');
    const { runWithContext } = await import('../../src/runtime/context.js');
    const owner = await principal('9000008810', 'client');
    const selection = { rentableId: owner.userId, dates: ['2026-12-01'], slot: 'day', guests: 2 };
    const browser = {
      [SELECTION_COOKIE]: await signCustomerSelection(selection, '/listing/test-farm'),
    };
    const original = browser[SELECTION_COOKIE];
    const res = {
      cookie(name, value) {
        browser[name] = value;
      },
    };
    const request = (fn) =>
      runWithContext({ req: { cookies: { ...browser }, headers: {} }, res }, fn);
    await request(() => createSession({ ...owner, accountStatus: 'active' }));
    await assert.rejects(
      request(() => switchAccountRole('customer')),
      (error) => error.location === '/listing/test-farm',
    );
    assert.equal(browser[SELECTION_COOKIE], original);
    assert.equal((await readCustomerSelection(original)).selection.guests, 2);
  },
);

test(
  'booking button eligibility requires an existing active customer with the same verified mobile',
  { skip },
  async () => {
    const { hasCustomerAccount } = await import('../../src/services/auth/role-switch.js');
    const owner = {
      role: 'client',
      phone: '9000008891',
      phoneVerifiedAt: new Date(),
      accountStatus: 'active',
    };
    assert.equal(await hasCustomerAccount(sql, owner), false);
    await principal('9000008892');
    assert.equal(await hasCustomerAccount(sql, owner), false);
    const customer = await principal(owner.phone, 'customer', false);
    assert.equal(await hasCustomerAccount(sql, owner), false);
    await sql`UPDATE "user" SET phone_verified_at=now() WHERE id=${customer.userId}`;
    assert.equal(await hasCustomerAccount(sql, owner), true);
    assert.equal(
      await hasCustomerAccount(sql, { ...owner, accountStatus: 'pending_application' }),
      true,
    );
    assert.equal(await hasCustomerAccount(sql, { ...owner, phoneVerifiedAt: null }), false);
    assert.equal(await hasCustomerAccount(sql, { ...owner, phone: null }), false);
    assert.equal(await hasCustomerAccount(sql, { ...owner, role: 'customer' }), false);
    assert.equal(await hasCustomerAccount(sql, null), false);
    await sql`UPDATE "user" SET account_status='suspended' WHERE id=${customer.userId}`;
    assert.equal(await hasCustomerAccount(sql, owner), false);
  },
);
