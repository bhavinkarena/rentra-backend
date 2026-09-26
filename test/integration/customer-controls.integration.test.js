import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';

// Explicit disposable server only (e.g. postgresql://postgres@127.0.0.1:55432/postgres).
test(
  'CP04 customer directory, minimization, corrections, restriction and session revocation',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const customers = await import('@/services/admin/customers.js');
      const { validCustomerSession } = await import('@/services/auth/customer-identity.js');

      const [admin] =
        await sql`INSERT INTO admin_user(email,password_hash,name) VALUES ('cp04@fixture.invalid','x','CP04') RETURNING id`;
      const person = async (phone, name, email, status = 'active') =>
        (
          await sql`INSERT INTO "user"(phone,role,account_status,name,email,phone_verified_at)
          VALUES (${phone},'customer',${status},${name},${email},now()) RETURNING id`
        )[0].id;
      const riya = await person('9876543210', 'Riya Shah', 'riya@fixture.invalid');
      const other = await person('9123456789', 'Other Guest', 'taken@fixture.invalid');
      const blocked = await person('9000000000', 'Blocked Guest', null, 'blocked');
      await sql`INSERT INTO customer_profile(user_id) VALUES (${riya})`;

      const [owner] =
        await sql`INSERT INTO "user"(email,role,account_status) VALUES ('owner4@fixture.invalid','client','active') RETURNING id`;
      const [city] =
        await sql`INSERT INTO city(slug,name,state) VALUES ('surat','Surat','Gujarat') RETURNING id`;
      const [area] =
        await sql`INSERT INTO area(city_id,slug,name) VALUES (${city.id},'dumas','Dumas') RETURNING id`;
      const [category] =
        await sql`INSERT INTO category(slug,name) VALUES ('farmhouse','Farmhouse') RETURNING id`;
      const [listing] =
        await sql`INSERT INTO rentable(client_id,slug,title,category_id,city_id,area_id,public_code,status)
        VALUES (${owner.id},'farm','Riverside Farm',${category.id},${city.id},${area.id},'CP04A','live') RETURNING id`;
      const [order] =
        await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,currency,time_zone,pricing_version,
          policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,
          idempotency_key,request_hash,state)
        VALUES ('ORD-CP04',${riya},${listing.id},'INR','Asia/Kolkata','v1','v1','{}','{"title":"Riverside Farm"}',100000,8000,0,
          ${randomUUID()},'hash','confirmed') RETURNING id`;
      await sql`INSERT INTO booking(reference,rentable_id,customer_id,day,slot,amount_rent,amount_fee,state,starts_at,ends_at,
          order_id,item_position,local_day,currency,time_zone,guests,units_booked,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
        VALUES ('V-CP04',${listing.id},${riya},(now()+interval '4 days')::date,'day',1000,80,'confirmed',
          now()+interval '4 days', now()+interval '4 days 8 hours',${order.id},1,(now()+interval '4 days')::date,'INR','Asia/Kolkata',2,1,100000,8000,0)`;
      await sql`INSERT INTO customer_privacy_request(customer_id,kind) VALUES (${riya},'access')`;
      const session = async (userId) => ({
        role: 'customer',
        userId,
        sessionId: (
          await sql`INSERT INTO customer_session(user_id,expires_at) VALUES (${userId},now()+interval '1 day') RETURNING id`
        )[0].id,
      });
      const first = await session(riya);
      const second = await session(riya);
      const otherSession = await session(other);

      // Directory: counts, search by phone digits, masked phone, no raw phone in lists.
      const all = await customers.listCustomers(sql, {});
      assert.deepEqual(all.counts, { all: 3, active: 2, suspended: 0, blocked: 1 });
      const found = await customers.listCustomers(sql, { q: '43210' });
      assert.equal(found.items.length, 1);
      assert.equal(found.items[0].phoneMasked, '••••••3210');
      assert.equal(
        JSON.stringify(found).includes('9876543210'),
        false,
        'list never carries the full phone',
      );
      assert.equal(
        (await customers.listCustomers(sql, { q: '_' })).total,
        0,
        'wildcards are literal',
      );

      // Detail: linked records, no secrets.
      const detail = await customers.readCustomer(sql, riya);
      assert.equal(detail.bookings.total, 1);
      assert.equal(detail.privacy[0].kind, 'access');
      assert.equal(detail.sessions.open, 2);
      assert.deepEqual(detail.lifecycle.effects, {
        openSessions: 2,
        upcomingVisits: 1,
        activeHolds: 0,
        openSupport: 0,
      });
      const text = JSON.stringify(detail);
      for (const secret of [first.sessionId, 'code_hash', 'photo_public_id', 'token'])
        assert.equal(text.includes(secret), false, `detail leaks ${secret}`);
      for (const id of [randomUUID(), 'not-a-uuid', owner.id])
        await assert.rejects(customers.readCustomer(sql, id), { statusCode: 404 });

      const cmd = (fn, customerId, input, action) =>
        fn(sql, { adminId: admin.id, customerId, input, action, ip: '127.0.0.1' });
      const base = {
        reason: 'Customer called support',
        expectedVersion: 1,
        expectedProfileVersion: 1,
      };

      // Corrections: invalid, duplicate email, no-op, stale, success with field-only audit.
      await assert.rejects(
        cmd(customers.correctCustomerProfile, riya, {
          ...base,
          name: 'R',
          email: 'bad',
          preferredLocale: 'en',
        }),
        (error) => error.statusCode === 422 && Boolean(error.fields.name && error.fields.email),
      );
      await assert.rejects(
        cmd(customers.correctCustomerProfile, riya, {
          ...base,
          name: 'Riya Shah',
          email: 'taken@fixture.invalid',
          preferredLocale: 'en',
        }),
        (error) => error.statusCode === 422 && Boolean(/already uses/.test(error.fields.email)),
      );
      await assert.rejects(
        cmd(customers.correctCustomerProfile, riya, {
          ...base,
          name: 'Riya Shah',
          email: 'riya@fixture.invalid',
          preferredLocale: 'en',
        }),
        (error) => error.statusCode === 422 && Boolean(error.fields._),
      );
      await assert.rejects(
        cmd(customers.correctCustomerProfile, riya, {
          ...base,
          expectedProfileVersion: 0,
          name: 'Riya S. Shah',
          email: '',
          preferredLocale: 'en',
        }),
        { statusCode: 409, code: 'PROFILE_CONFLICT' },
      );
      const corrected = await cmd(customers.correctCustomerProfile, riya, {
        ...base,
        name: 'Riya S. Shah',
        email: 'riya.shah@fixture.invalid',
        preferredLocale: 'gu',
      });
      assert.deepEqual(corrected.fields, ['name', 'email', 'preferredLocale']);
      assert.deepEqual([corrected.lifecycleVersion, corrected.profileVersion], [2, 2]);
      const [row] = await sql`SELECT phone, email_verified_at FROM "user" WHERE id=${riya}`;
      assert.equal(row.phone, '9876543210', 'credential untouched');
      assert.equal(row.email_verified_at, null, 'changed email needs verification again');
      const [correctionAudit] =
        await sql`SELECT after::text AS after, reason FROM audit_log WHERE action='customer_profile_corrected'`;
      assert.equal(
        correctionAudit.after.includes('riya.shah'),
        false,
        'audit holds field names, not values',
      );
      assert.equal(
        await validCustomerSession(sql, first),
        true,
        'identity correction is not a sign-out',
      );
      await assert.rejects(
        cmd(customers.correctCustomerProfile, riya, {
          ...base,
          name: 'Twice',
          email: '',
          preferredLocale: 'en',
        }),
        { statusCode: 409, code: 'ACCOUNT_CONFLICT' },
        'duplicate submit with the old version',
      );

      // Session revocation while active: both sessions end, account stays active.
      const revoked = await cmd(customers.revokeCustomerSessions, riya, {
        reason: 'Lost phone',
        expectedVersion: 2,
      });
      assert.equal(revoked.revoked, 2);
      assert.equal(await validCustomerSession(sql, first), false);
      assert.equal(await validCustomerSession(sql, second), false);
      assert.equal(
        await validCustomerSession(sql, otherSession),
        true,
        'other customers unaffected',
      );
      const again = await cmd(customers.revokeCustomerSessions, riya, {
        reason: 'Lost phone',
        expectedVersion: 3,
      });
      assert.equal(again.revoked, 0, 'repeat is a no-op');

      // Restriction and reinstatement: version guarded, sessions stay revoked.
      const third = await session(riya);
      await assert.rejects(
        cmd(
          customers.changeCustomerLifecycle,
          riya,
          { reason: 'Chargeback', expectedVersion: 1 },
          'suspend',
        ),
        { statusCode: 409, code: 'ACCOUNT_CONFLICT' },
      );
      const race = await Promise.allSettled([
        cmd(
          customers.changeCustomerLifecycle,
          riya,
          { reason: 'Chargeback', expectedVersion: 3 },
          'suspend',
        ),
        cmd(
          customers.changeCustomerLifecycle,
          riya,
          { reason: 'Chargeback', expectedVersion: 3 },
          'suspend',
        ),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(await validCustomerSession(sql, third), false);
      const back = await cmd(
        customers.changeCustomerLifecycle,
        riya,
        { reason: 'Resolved', expectedVersion: 4 },
        'reinstate',
      );
      assert.equal(back.accountStatus, 'active');
      assert.equal(
        await validCustomerSession(sql, third),
        false,
        'reinstatement never revives sessions',
      );
      await assert.rejects(
        cmd(
          customers.changeCustomerLifecycle,
          blocked,
          { reason: 'try it', expectedVersion: 1 },
          'reinstate',
        ),
        { statusCode: 409, code: 'LIFECYCLE_NOT_ALLOWED' },
      );
      const history = (await customers.readCustomer(sql, riya)).history.map((h) => h.action);
      for (const action of [
        'customer_profile_corrected',
        'customer_sessions_revoked',
        'customer_restricted',
        'customer_reinstated',
      ])
        assert.ok(history.includes(action), action);
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
