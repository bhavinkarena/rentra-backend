import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { issuePortalSession, validPortalSession } from '../../src/services/auth/portal-sessions.js';
import {
  requestPayoutStepUp,
  confirmPayoutStepUp,
} from '../../src/services/auth/payout-step-up.js';
import { recentAuthentication } from '../../src/services/auth/recent-auth.js';
import {
  saveClientDestination,
  submitClientDraft,
} from '../../src/services/payouts/destinations.js';
import { destinationPayoutSchema } from '../../src/services/schemas/zod/application.js';
const env = { NODE_ENV: 'production', SESSION_SECRET: 'owner-phase8-test-session-signing-secret' };
test(
  'payout step-up keeps the session, binds codes, limits attempts, preserves drafts and submits after confirmation',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql);
      await sql`UPDATE "user" SET email_verified_at=now() WHERE id=${f.owner}`;
      const sessionId = await issuePortalSession(sql, 'client', f.owner, 3600),
        second = await issuePortalSession(sql, 'client', f.owner, 3600),
        actor = { kind: 'owner', id: f.owner, sessionId };
      await sql`UPDATE auth_session SET created_at=now()-interval '1 hour' WHERE id=${sessionId}`;
      const valid = {
        method: 'bank',
        accountNumber: '1234 5678 9012',
        confirmAccountNumber: '1234-5678-9012',
        ifsc: 'sbin 0001234',
        holderName: 'Property Owner',
      };
      const input = () => ({
        ...valid,
        expectedLatest: 0,
        requestKey: randomUUID(),
        mode: 'submit',
      });
      assert.equal((await saveClientDestination(sql, actor, input())).state, 'draft');
      assert.equal(
        (await saveClientDestination(sql, actor, { ...input(), expectedLatest: 1 })).state,
        'draft',
      );
      const [draft] =
        await sql`SELECT id,account_last4 FROM payout_destination WHERE client_id=${f.owner} AND state='draft'`;
      assert.equal(draft.account_last4, '9012');
      const invalid = destinationPayoutSchema.safeParse({
        method: 'bank',
        accountNumber: 'bad',
        confirmAccountNumber: 'different',
        ifsc: 'bad',
        holderName: '',
      });
      assert.deepEqual(
        new Set(invalid.error.issues.map((i) => i.path[0])),
        new Set(['holderName', 'accountNumber', 'ifsc', 'confirmAccountNumber']),
      );
      const failed = await requestPayoutStepUp(sql, actor, env, async () => {
        throw new Error('Provider unavailable');
      });
      assert.equal(failed.code, 'OTP_DELIVERY_FAILED');
      let code;
      const requested = await requestPayoutStepUp(sql, actor, env, async (message) => {
        code = message.code;
      });
      assert.ok(requested.challengeId);
      assert.ok(!JSON.stringify(requested).includes(code));
      assert.equal(
        (await requestPayoutStepUp(sql, actor, env, async () => {})).code,
        'OTP_COOLDOWN',
      );
      assert.equal(
        (
          await confirmPayoutStepUp(
            sql,
            { ...actor, sessionId: second },
            { challengeId: requested.challengeId, code },
            env,
          )
        ).code,
        'CODE_EXPIRED',
      );
      assert.equal(
        (
          await confirmPayoutStepUp(
            sql,
            actor,
            { challengeId: requested.challengeId, code: code === '000000' ? '111111' : '000000' },
            env,
          )
        ).code,
        'WRONG_CODE',
      );
      const confirmed = await confirmPayoutStepUp(
        sql,
        actor,
        { challengeId: requested.challengeId, code },
        env,
      );
      assert.equal(confirmed.confirmed, true);
      assert.equal(
        (await recentAuthentication(sql, { kind: 'client', principalId: f.owner, sessionId }))
          .fresh,
        true,
      );
      assert.equal(
        await validPortalSession(sql, { role: 'client', userId: f.owner, sessionId }, 'client'),
        true,
      );
      assert.equal(
        (await submitClientDraft(sql, actor, { draftId: draft.id, expectedLatest: 2 })).state,
        'submitted',
      );
      assert.equal(
        (await confirmPayoutStepUp(sql, actor, { challengeId: requested.challengeId, code }, env))
          .code,
        'CODE_EXPIRED',
      );
      await sql`UPDATE otp_challenge SET created_at=now()-interval '2 minutes' WHERE id=${requested.challengeId}`;
      const newRequest = await requestPayoutStepUp(sql, actor, env, async (message) => {
        code = message.code;
      });
      for (let i = 0; i < 5; i++)
        await confirmPayoutStepUp(
          sql,
          actor,
          { challengeId: newRequest.challengeId, code: code === '000000' ? '111111' : '000000' },
          env,
        );
      assert.equal(
        (await confirmPayoutStepUp(sql, actor, { challengeId: newRequest.challengeId, code }, env))
          .code,
        'CODE_EXPIRED',
      );
      await sql`UPDATE auth_session SET revoked_at=now() WHERE id=${sessionId}`;
      await assert.rejects(
        requestPayoutStepUp(sql, actor, env, async () => {}),
        { statusCode: 403 },
      );
    } finally {
      await db.drop();
    }
  },
);
