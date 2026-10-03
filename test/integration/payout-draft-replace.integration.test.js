import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';
import {
  recordOnboardingDestination,
  saveClientDestination,
} from '../../src/services/payouts/destinations.js';

test(
  'a second payout change replaces an unsubmitted draft instead of failing',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql);
      await sql`UPDATE client_application SET kyc_name_on_doc='Property Owner' WHERE user_id=${f.owner}`;
      const sessionId = await issuePortalSession(sql, 'client', f.owner, 3600);
      // A stale sign-in, so every settings change is saved as a draft.
      await sql`UPDATE auth_session SET created_at=now()-interval '1 hour' WHERE id=${sessionId}`;
      const owner = { kind: 'owner', id: f.owner, sessionId };
      const change = (expectedLatest, upiId) =>
        saveClientDestination(sql, owner, {
          method: 'upi',
          upiId,
          holderName: 'Property Owner',
          expectedLatest,
          mode: 'submit',
          requestKey: randomUUID(),
        });

      assert.equal((await change(0, 'first@okaxis')).state, 'draft');
      const second = await change(1, 'second@okaxis');
      assert.deepEqual([second.state, second.version], ['draft', 2]);
      assert.deepEqual(
        (
          await sql`SELECT version,state FROM payout_destination WHERE client_id=${f.owner} ORDER BY version`
        ).map((r) => [r.version, r.state]),
        [
          [1, 'superseded'],
          [2, 'draft'],
        ],
      );

      // Onboarding also replaces any draft in one step.
      const row = await recordOnboardingDestination(sql, f.owner, {
        method: 'upi',
        upiId: 'third@okaxis',
        holderName: 'Property Owner',
      });
      assert.equal(row.state, 'submitted');
    } finally {
      await fixture.drop();
    }
  },
);
