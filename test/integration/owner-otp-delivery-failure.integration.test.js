import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';

test(
  'a code that cannot be sent is reported to the owner, not thrown, and leaves no challenge behind',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      // Production with no email provider configured.
      Object.assign(process.env, { NODE_ENV: 'production', DEV_OTP_BYPASS: 'false' });
      delete process.env.RESEND_API_KEY;
      const { issueOtp } = await import('@/services/auth/otp.js');
      const result = await issueOtp({
        identifier: 'owner@example.test',
        channel: 'email',
        purpose: 'login',
      });
      assert.deepEqual(result, { ok: false, reason: 'delivery_failed' });
      assert.equal(
        (await sql`SELECT count(*)::int n FROM otp_challenge`)[0].n,
        0,
        'a retry is not blocked by a code that never went out',
      );
    } finally {
      await fixture.drop();
    }
  },
);
