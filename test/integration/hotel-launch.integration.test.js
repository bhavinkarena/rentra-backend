import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedCustomer, seedHotel } from '../helpers/hotel-fixture.js';

/**
 * Hotel plan, Phase 9: closed beta (invite → beta pass → Hotels visible for that
 * request only) and the launch inspection behind the public switch.
 */
test('Phase 9: hotel closed beta and launch readiness', { skip: !process.env.PORTAL_TEST_DATABASE_URL }, async (t) => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  t.after(() => fixture.drop());
  const { sql } = fixture;
  globalThis.__rentraSql = sql;
  process.env.DATABASE_URL = fixture.url;
  process.env.HOTEL_LAUNCH_MIN_HOTELS = '1';
  const beta = { ...(await import('@/services/auth/beta-access.js')), ...(await import('@/services/catalogues/beta-guests.js')) };
  const { runWithContext } = await import('@/runtime/context.js');
  const { searchDiscovery, clearDiscoveryRegistryCache, getLandingRoutes } = await import('@/services/db/discovery.js');
  const { parseDiscoveryQuery } = await import('@/services/domain/discovery.js');
  const { getListingByCode } = await import('@/services/db/queries.js');
  const { inspectHotelRelease } = await import('@/services/operations/hotel-release.js');
  const { verticalCommand } = await import('@/services/catalogues/verticals.js');

  const h = await seedHotel(sql);
  const [hotel] = await sql`SELECT public_code FROM rentable WHERE id=${h.hotel}`;
  await sql`UPDATE vertical SET status='partners' WHERE code='hotel'`;
  const admin = { kind: 'admin', id: h.admin };
  const customer = await seedCustomer(sql);
  const [{ phone }] = await sql`SELECT phone FROM "user" WHERE id=${customer}`;
  const [row] = await sql`INSERT INTO auth_session(user_id,expires_at) VALUES (${customer},now()+interval '1 day') RETURNING id`;
  const session = { role: 'customer', userId: customer, sessionId: row.id };
  /** Runs `fn` as an API request that carries `pass` in X-Rentra-Beta. */
  const asRequest = (pass, fn) => runWithContext({ req: { get: (name) => (name.toLowerCase() === beta.BETA_HEADER ? pass : undefined) } }, fn);
  const hotelSearch = () => {
    const { filters } = parseDiscoveryQuery({ vertical: 'hotel', city: 'surat' });
    return searchDiscovery(filters, null, sql);
  };

  await t.test('beta pass: signed, expiring, unforgeable', () => {
    const { token } = beta.issueBetaPass(['hotel']);
    assert.deepEqual(beta.readBetaPass(token), ['hotel']);
    assert.deepEqual(beta.readBetaPass(token.replace('hotel', 'hotels')), []);
    assert.deepEqual(beta.readBetaPass(`${token}x`), []);
    assert.deepEqual(beta.readBetaPass(token, process.env, Date.now() + 8 * 86_400_000), [], 'expires after 7 days');
    assert.deepEqual(beta.readBetaPass(undefined), []);
  });

  let pass;
  await t.test('invites: admin adds phones, only invited customers get a pass', async () => {
    await assert.rejects(beta.claimBetaPass(sql, session), { code: 'NOT_INVITED' });
    await assert.rejects(beta.betaGuestCommand(sql, admin, 'hotel', { action: 'invite', phones: '12345' }), { code: 'INVALID_INVITE' });
    const added = await beta.betaGuestCommand(sql, admin, 'hotel', { action: 'invite', phones: `+91 ${phone.slice(-10)}\n9898989898, 9898989898`, note: 'Team' });
    assert.deepEqual([added.added, added.alreadyInvited], [2, 0]);
    const list = await beta.listBetaGuests(sql, admin, 'hotel');
    assert.equal(list.items.length, 2);
    assert.equal(list.items.find((g) => g.phone === phone.slice(-10)).hasAccount, true);
    pass = (await beta.claimBetaPass(sql, session)).token;
    assert.deepEqual(beta.readBetaPass(pass), ['hotel']);
  });

  await t.test('visibility: Hotels only for a request carrying the pass; never in the sitemap', async () => {
    clearDiscoveryRegistryCache(sql);
    const anonymous = await hotelSearch();
    assert.equal(anonymous.total, 0);
    assert.equal(await getListingByCode(hotel.public_code), null);
    const invited = await asRequest(pass, hotelSearch);
    assert.equal(invited.total, 1);
    assert.ok(await asRequest(pass, () => getListingByCode(hotel.public_code)));
    // The shared registry cache never keeps what a pass revealed.
    assert.equal((await hotelSearch()).total, 0);
    const routes = await asRequest(pass, () => getLandingRoutes(sql));
    assert.ok(!routes.some((route) => route.path.includes('hotel')), 'beta pages are never indexed');
    const forged = await asRequest(`${pass.slice(0, -2)}xx`, hotelSearch);
    assert.equal(forged.total, 0);
  });

  await t.test('revoking ends new passes; a public vertical needs no pass', async () => {
    const list = await beta.listBetaGuests(sql, admin, 'hotel');
    for (const guest of list.items) await beta.betaGuestCommand(sql, admin, 'hotel', { action: 'revoke', id: guest.id });
    await assert.rejects(beta.claimBetaPass(sql, session), { code: 'NOT_INVITED' });
  });

  await t.test('launch inspection: beta passes; public refused with reasons', async () => {
    await sql`INSERT INTO commission_rule(vertical_code, rate_bps, tier, valid_from, reason, created_by) VALUES ('hotel', 1000, 'standard', '2020-01-01', 'Launch', ${h.admin})`;
    await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at,verification_provider,verification_reference,verification_evidence_hash,verified_at)
      VALUES (${h.owner},1,'bank','Hotel Owner','4421','HDFC0001234','same','verified','migration',now(),'fixture','fixture',${'a'.repeat(64)},now())`;
    await sql`UPDATE hotel_profile SET policies = policies || '{"gstAnswered":true}' WHERE rentable_id=${h.hotel}`;
    const report = await inspectHotelRelease(sql, 'beta');
    assert.equal(report.ready, true, JSON.stringify(report.checks.filter((c) => !c.pass)));
    const launch = await inspectHotelRelease(sql, 'public');
    assert.equal(launch.ready, false);
    const failed = launch.checks.filter((c) => !c.pass).map((c) => c.name);
    assert.ok(failed.includes('live hotels have 8+ photos') && failed.includes('live payments enabled'), failed.join(', '));
    const [v] = await sql`SELECT version, name, sort_order FROM vertical WHERE code='hotel'`;
    const input = { version: v.version, name: v.name, sortOrder: v.sort_order, status: 'public', reason: 'Launch Hotels to every guest.', preview: true };
    await assert.rejects(verticalCommand(sql, admin, 'hotel', input), (error) => error.code === 'NOT_READY' && /8\+ photos/.test(error.message));
  });
});
