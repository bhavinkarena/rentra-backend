import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import {
  listOperators,
  readOperator,
  operatorCommand,
  enrollOperator,
} from '../../src/services/admin/operators.js';
import { issuePortalSession, validPortalSession } from '../../src/services/auth/portal-sessions.js';
import {
  generateTotpSecret,
  currentTotp,
  hashPassword,
  verifyPassword,
  verifyTotp,
} from '../../src/services/auth/admin-crypto.js';

test(
  'CP26 operator access, session revocation, enrollment and audited recovery',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      db = fixture.sql;
    const password = 'Fixture password 123!';
    const create = async (email, permissions = null) => {
      const secret = generateTotpSecret();
      const [r] =
        await db`INSERT INTO admin_user(email,name,password_hash,totp_secret,permissions) VALUES (${email},${email},${hashPassword(password)},${secret},${permissions === null ? null : db.json(permissions)}) RETURNING id`;
      return {
        ...r,
        secret,
        kind: 'admin',
        sessionId: await issuePortalSession(db, 'admin', r.id, 3600),
      };
    };
    const read = (id) => db`SELECT * FROM admin_user WHERE id=${id}`;
    try {
      const a = await create('a@fixture.invalid'),
        b = await create('b@fixture.invalid'),
        limited = await create('limited@fixture.invalid', ['admin.security.read']);
      const cmd = (actor, id, command, version = 1, extra = {}) =>
        operatorCommand(db, actor, id, {
          command,
          version,
          reason: 'Reviewed security change',
          confirmed: true,
          ...extra,
        });
      assert.equal((await listOperators(db, a)).total, 3);
      const detail = await readOperator(db, a, b.id);
      assert.equal(detail.sessions.length, 1);
      assert(!JSON.stringify(detail).includes(b.secret));
      assert(!JSON.stringify(detail).includes('password_hash'));
      await assert.rejects(cmd(limited, b.id, 'revoke'), { statusCode: 403 });
      await assert.rejects(cmd({ ...a, kind: 'owner' }, b.id, 'revoke'), { statusCode: 403 });
      await assert.rejects(cmd(a, a.id, 'access', 1, { active: false, permissions: null }), {
        code: 'SELF_LOCKOUT',
      });
      await db`UPDATE auth_session SET created_at=now()-interval '16 minutes' WHERE id=${a.sessionId}`;
      await assert.rejects(cmd(a, b.id, 'revoke'), { code: 'RECENT_AUTH_REQUIRED' });
      await db`UPDATE auth_session SET created_at=now() WHERE id=${a.sessionId}`;
      await cmd(a, b.id, 'access', 1, { active: true, permissions: ['admin.security.read'] });
      assert.equal(
        await validPortalSession(db, { adminId: b.id, sessionId: b.sessionId }, 'admin'),
        false,
      );
      await assert.rejects(cmd(a, b.id, 'access', 1, { active: false, permissions: [] }), {
        code: 'OPERATOR_CHANGED',
      });
      await assert.rejects(cmd(b, a.id, 'revoke'), { statusCode: 403 });
      const c = await create('c@fixture.invalid');
      const race = await Promise.allSettled([
        cmd(a, b.id, 'access', 2, { active: false, permissions: [] }),
        cmd(c, b.id, 'access', 2, { active: true, permissions: ['admin.records.read'] }),
      ]);
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      // Two concurrent Super Admin removals cannot remove both usable administrators.
      const safety = await Promise.allSettled([
        cmd(a, c.id, 'access', 1, { active: false, permissions: null }),
        cmd(c, a.id, 'access', 1, { active: false, permissions: null }),
      ]);
      assert.equal(safety.filter((r) => r.status === 'fulfilled').length, 1);
      const [survivor] =
        await db`SELECT id FROM admin_user WHERE is_active AND permissions IS NULL`;
      const manager = {
        kind: 'admin',
        id: survivor.id,
        sessionId: await issuePortalSession(db, 'admin', survivor.id, 3600),
      };
      const target = await create('target@fixture.invalid', ['admin.records.read']);
      const recovery = await cmd(manager, target.id, 'recover');
      assert.equal(
        await validPortalSession(db, { adminId: target.id, sessionId: target.sessionId }, 'admin'),
        false,
      );
      const [pending] = await read(target.id);
      assert.equal(pending.totp_secret, null);
      assert.notEqual(pending.enrollment_hash, recovery.enrollmentToken);
      assert.equal(verifyPassword(password, pending.password_hash), false);
      const preview = await enrollOperator(db, {
        token: recovery.enrollmentToken,
        command: 'preview',
      });
      const newSecret = new URL(preview.uri).searchParams.get('secret');
      assert.notEqual(newSecret, target.secret);
      await assert.rejects(
        enrollOperator(db, {
          token: recovery.enrollmentToken,
          command: 'complete',
          password,
          totp: '000000',
        }),
        { statusCode: 422 },
      );
      await enrollOperator(db, {
        token: recovery.enrollmentToken,
        command: 'complete',
        password,
        totp: currentTotp(newSecret),
      });
      await assert.rejects(
        enrollOperator(db, { token: recovery.enrollmentToken, command: 'preview' }),
        { code: 'ENROLLMENT_ENDED' },
      );
      const [enrolled] = await read(target.id);
      assert.equal(verifyPassword(password, enrolled.password_hash), true);
      assert.equal(
        verifyTotp({ secret: enrolled.totp_secret, token: currentTotp(target.secret) }),
        false,
      );
      assert.equal(
        verifyTotp({ secret: enrolled.totp_secret, token: currentTotp(newSecret) }),
        true,
      );
      const repeat = await cmd(manager, target.id, 'recover', 3);
      await cmd(manager, target.id, 'cancel_enrollment', 4);
      await assert.rejects(
        enrollOperator(db, { token: repeat.enrollmentToken, command: 'preview' }),
        { code: 'ENROLLMENT_ENDED' },
      );
      const newOp = await cmd(manager, null, 'create', undefined, {
        name: 'New operator',
        email: 'new@fixture.invalid',
        permissions: [],
      });
      await db`UPDATE admin_user SET enrollment_expires_at=now()-interval '1 minute' WHERE id=${newOp.id}`;
      await assert.rejects(
        enrollOperator(db, { token: newOp.enrollmentToken, command: 'preview' }),
        { code: 'ENROLLMENT_ENDED' },
      );
      await assert.rejects(
        cmd(manager, null, 'create', undefined, {
          name: 'Duplicate',
          email: 'new@fixture.invalid',
          permissions: [],
        }),
        { code: 'EMAIL_IN_USE' },
      );
      const delegated = await create('delegated@fixture.invalid', [
        'admin.security.read',
        'admin.security.write',
      ]);
      await assert.rejects(
        cmd(delegated, manager.id, 'access', 1, { active: false, permissions: [] }),
        { code: 'GRANT_NOT_PERMITTED' },
      );
      await assert.rejects(
        cmd(delegated, null, 'create', undefined, {
          name: 'Escalation',
          email: 'escalation@fixture.invalid',
          permissions: ['admin.payments.write'],
        }),
        { code: 'GRANT_NOT_PERMITTED' },
      );
      // Only the enrolled full Super Admin counts as a usable recovery operator.
      await assert.rejects(cmd(delegated, manager.id, 'recover'), { code: 'GRANT_NOT_PERMITTED' });
      const factorless = await create('factorless@fixture.invalid');
      await db`UPDATE admin_user SET totp_secret=NULL WHERE id=${factorless.id}`;
      factorless.sessionId = await issuePortalSession(db, 'admin', factorless.id, 3600);
      await assert.rejects(cmd(factorless, manager.id, 'recover'), { code: 'LAST_SUPER_ADMIN' });
      const higher = await create('higher@fixture.invalid', ['admin.payments.write']);
      await assert.rejects(cmd(delegated, higher.id, 'recover'), { code: 'GRANT_NOT_PERMITTED' });
      await assert.rejects(
        operatorCommand(db, manager, higher.id, {
          command: 'revoke',
          version: 1,
          reason: 'Missing explicit confirmation',
          confirmed: false,
        }),
        { statusCode: 422 },
      );
      const [audit] =
        await db`SELECT json_agg(after)::text data FROM audit_log WHERE action LIKE 'operator_%'`;
      for (const secret of [target.secret, newSecret, recovery.enrollmentToken, password])
        assert(!audit.data.includes(secret));
      const [receipt] =
        await db`SELECT count(*)::int n FROM audit_log WHERE entity_id=${target.id} AND action='operator_enrollment_completed'`;
      assert.equal(receipt.n, 1);
      const signed = await issuePortalSession(db, 'admin', manager.id, 3600);
      await cmd(manager, manager.id, 'revoke', 1, { sessionId: signed });
      assert.equal(
        await validPortalSession(db, { adminId: manager.id, sessionId: signed }, 'admin'),
        false,
      );
      assert.equal(
        await validPortalSession(
          db,
          { adminId: manager.id, sessionId: manager.sessionId },
          'admin',
        ),
        true,
      );
    } finally {
      await fixture.drop();
    }
  },
);
