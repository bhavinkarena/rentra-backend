import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';
import {
  adminClientDestinations,
  clientDestinationPage,
  failDestination,
  recordOnboardingDestination,
  saveClientDestination,
  submitClientDraft,
} from '../../src/services/payouts/destinations.js';

test(
  'CP21 destination versions: private fields, recent sign-in, stale changes, pinning, failure and disbursement guard',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      const f = await seedReviewFixture(sql),
        booked = await seedConfirmedBooking(sql, f.listing);
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booked.order}`;
      await sql`UPDATE client_application SET kyc_name_on_doc='Property Owner' WHERE user_id=${f.owner}`;
      const fresh = async () => issuePortalSession(sql, 'client', f.owner, 3600);
      const age = (id) =>
        sql`UPDATE auth_session SET created_at=now()-interval '1 hour' WHERE id=${id}`;
      const owner = { kind: 'owner', id: f.owner, sessionId: await fresh() };
      const bank = {
        method: 'bank',
        accountNumber: '001234567896789',
        ifsc: 'sbin0001234',
        holderName: 'Property Owner',
      };
      const change = (actor, extra) =>
        saveClientDestination(sql, actor, {
          ...bank,
          expectedLatest: 0,
          mode: 'submit',
          requestKey: randomUUID(),
          ...extra,
        });

      const empty = await clientDestinationPage(sql, owner);
      assert.deepEqual(
        [
          empty.latestVersion,
          empty.current,
          empty.readiness.ready,
          empty.recentAuth.fresh,
          empty.verificationAvailable,
        ],
        [0, null, false, true, false],
      );
      await assert.rejects(
        change(owner, { ifsc: 'BAD' }),
        (e) => e.code === 'INVALID_DESTINATION' && Boolean(e.fields.ifsc),
      );

      // Preview writes nothing; submit keeps only the last four digits.
      const preview = await change(owner, { mode: 'preview' });
      assert.deepEqual(
        [
          preview.preview.version,
          preview.preview.masked,
          preview.preview.nameCheck,
          preview.preview.needsRecentAuth,
        ],
        [1, 'Bank •••• 6789 · SBIN0001234', 'same', false],
      );
      assert.equal((await sql`SELECT count(*)::int n FROM payout_destination`)[0].n, 0);
      const key = randomUUID();
      const v1 = await change(owner, { requestKey: key });
      assert.deepEqual([v1.state, v1.version], ['submitted', 1]);
      assert.equal((await change(owner, { requestKey: key })).replayed, true);
      await assert.rejects(change(owner, { requestKey: key, holderName: 'Someone Else' }), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      const everywhere = JSON.stringify([
        await sql`SELECT * FROM payout_destination`,
        await sql`SELECT "after","before" FROM audit_log WHERE entity='payout_destination'`,
        await sql`SELECT payout_account_ref FROM client_payout_current WHERE client_id=${f.owner}`,
      ]);
      assert.doesNotMatch(
        everywhere,
        /0012345678|1234567896789/,
        'the full account number is never stored',
      );
      assert.equal(
        (
          await sql`SELECT payout_account_ref FROM client_payout_current WHERE client_id=${f.owner}`
        )[0].payout_account_ref,
        '••••6789',
      );
      await assert.rejects(change(owner, { expectedLatest: 0 }), { code: 'DESTINATION_CHANGED' });

      // An obligation pinned to v1 is never redirected by later changes.
      const [pinned] =
        await sql`INSERT INTO payout(booking_id,client_id,gross_minor,commission_minor,net_minor,status,destination_id) VALUES (${visit.id},${f.owner},100000,8000,92000,'pending',(SELECT id FROM payout_destination WHERE client_id=${f.owner} AND version=1)) RETURNING id,destination_id`;

      // A stale sign-in turns a change into a draft; the draft needs a fresh sign-in to submit.
      await age(owner.sessionId);
      const drafted = await change(owner, {
        method: 'upi',
        upiId: 'PropertyOwner@okaxis',
        expectedLatest: 1,
      });
      assert.deepEqual(
        [drafted.state, drafted.version, drafted.reauthRequired],
        ['draft', 2, true],
      );
      const withDraft = await clientDestinationPage(sql, owner);
      assert.deepEqual(
        [withDraft.current.version, withDraft.draft.version, withDraft.recentAuth.fresh],
        [1, 2, false],
      );
      await assert.rejects(
        submitClientDraft(sql, owner, { draftId: withDraft.draft.id, expectedLatest: 2 }),
        { code: 'REAUTH_REQUIRED' },
      );
      const again = { ...owner, sessionId: await fresh() };
      const submitted = await submitClientDraft(sql, again, {
        draftId: withDraft.draft.id,
        expectedLatest: 2,
      });
      assert.deepEqual([submitted.state, submitted.version], ['submitted', 2]);
      assert.equal(
        (await submitClientDraft(sql, again, { draftId: withDraft.draft.id, expectedLatest: 2 }))
          .replayed,
        true,
      );
      const states =
        await sql`SELECT version,state,upi_id FROM payout_destination WHERE client_id=${f.owner} ORDER BY version`;
      assert.deepEqual(
        states.map((r) => `${r.version}:${r.state}`),
        ['1:superseded', '2:submitted'],
      );
      assert.equal(states[1].upi_id, 'propertyowner@okaxis');
      assert.equal(
        (await sql`SELECT destination_id FROM payout WHERE id=${pinned.id}`)[0].destination_id,
        pinned.destination_id,
      );
      await assert.rejects(
        sql`UPDATE payout SET destination_id=(SELECT id FROM payout_destination WHERE client_id=${f.owner} AND version=2) WHERE id=${pinned.id}`,
        /cannot be redirected/,
      );
      await assert.rejects(
        sql`UPDATE payout SET status='processing' WHERE id=${pinned.id}`,
        /verified payout destination/,
      );

      // "verified" needs provider evidence; with it, money may move; failure stops it again.
      await assert.rejects(
        sql`UPDATE payout_destination SET state='verified',updated_at=now() WHERE client_id=${f.owner} AND version=2`,
      );
      await sql`UPDATE payout_destination SET state='verified',verification_provider='provider-under-test',verification_reference='fa_TEST',
        verification_evidence_hash=${'a'.repeat(64)},verified_at=now(),updated_at=now() WHERE client_id=${f.owner} AND version=2`;
      const [second] =
        await sql`INSERT INTO payout(booking_id,client_id,gross_minor,commission_minor,net_minor,status,destination_id) VALUES (${visit.id},${f.owner},50000,4000,46000,'pending',(SELECT id FROM payout_destination WHERE client_id=${f.owner} AND version=2)) RETURNING id`;
      const [third] =
        await sql`INSERT INTO payout(booking_id,client_id,gross_minor,commission_minor,net_minor,status,destination_id) VALUES (${visit.id},${f.owner},50000,4000,46000,'pending',(SELECT id FROM payout_destination WHERE client_id=${f.owner} AND version=2)) RETURNING id`;
      await sql`UPDATE payout SET status='processing' WHERE id=${second.id}`;

      // Admin failure: impact preview, recent sign-in, reason, one effect, owner inbox update.
      const adminSession = await issuePortalSession(sql, 'admin', f.admin, 3600);
      const admin = { kind: 'admin', id: f.admin, sessionId: adminSession };
      const v2 = (await adminClientDestinations(sql, f.owner)).current;
      const fail = (actor, extra) =>
        failDestination(sql, actor, {
          destinationId: v2.id,
          expectedState: 'verified',
          reason: 'Bank returned the account as closed.',
          mode: 'apply',
          requestKey: randomUUID(),
          ...extra,
        });
      const impact = await fail(admin, { mode: 'preview' });
      assert.equal(impact.preview.pinnedPayouts, 2);
      await age(adminSession);
      await assert.rejects(fail(admin), { code: 'REAUTH_REQUIRED' });
      const freshAdmin = {
        ...admin,
        sessionId: await issuePortalSession(sql, 'admin', f.admin, 3600),
      };
      const failKey = randomUUID();
      const failed = await fail(freshAdmin, { requestKey: failKey });
      assert.deepEqual([failed.state, failed.pinnedPayouts], ['failed', 2]);
      assert.equal((await fail(freshAdmin, { requestKey: failKey })).replayed, true);
      await assert.rejects(fail(freshAdmin), { code: 'DESTINATION_CHANGED' });
      await assert.rejects(
        sql`UPDATE payout SET status='processing' WHERE id=${third.id}`,
        /verified payout destination/,
      );
      const [update] =
        await sql`SELECT kind,category FROM client_update WHERE client_id=${f.owner} AND action='payout_destination_failed'`;
      assert.deepEqual([update.kind, update.category], ['action', 'account']);
      const afterFail = await clientDestinationPage(sql, again);
      assert.equal(afterFail.current, null);
      assert.match(afterFail.readiness.reason, /failed review/);
      assert.equal(afterFail.history[0].failureReason, 'Bank returned the account as closed.');
      assert.equal(
        afterFail.history[0].decidedBy,
        undefined,
        'owners do not see operator identity',
      );
      assert.equal((await adminClientDestinations(sql, f.owner)).history[0].decidedBy, 'Reviewer');

      // Append-only history and allowed transitions only.
      await assert.rejects(
        sql`UPDATE payout_destination SET holder_name='Rewritten Name' WHERE client_id=${f.owner} AND version=1`,
      );
      await assert.rejects(
        sql`DELETE FROM payout_destination WHERE client_id=${f.owner} AND version=1`,
      );
      await assert.rejects(
        sql`UPDATE payout_destination SET state='submitted',updated_at=now() WHERE client_id=${f.owner} AND version=2`,
      );

      // Access: actors are checked; another owner reads only their own (empty) history.
      assert.equal(
        (
          await clientDestinationPage(sql, {
            kind: 'owner',
            id: f.other,
            sessionId: await issuePortalSession(sql, 'client', f.other, 3600),
          })
        ).latestVersion,
        0,
      );
      await assert.rejects(clientDestinationPage(sql, { kind: 'admin', id: f.admin }), {
        code: 'CLIENT_UNAVAILABLE',
      });
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.second}`;
      await assert.rejects(
        failDestination(
          sql,
          { kind: 'admin', id: f.second, sessionId: randomUUID() },
          {
            destinationId: v2.id,
            expectedState: 'failed'.replace('failed', 'submitted'),
            reason: 'Inactive admin attempt.',
            mode: 'preview',
            requestKey: randomUUID(),
          },
        ),
        { code: 'OPERATOR_REQUIRED' },
      );

      // Onboarding (pending application) records a version without the sign-in rule.
      const [pending] =
        await sql`INSERT INTO "user"(email,role,account_status,name) VALUES ('pending@fixture.invalid','client','pending_application','Pending Owner') RETURNING id`;
      const onboarded = await recordOnboardingDestination(sql, pending.id, {
        method: 'upi',
        upiId: 'pending@ybl',
        holderName: 'Pending Owner',
      });
      assert.deepEqual(
        [onboarded.version, onboarded.state, onboarded.source],
        [1, 'submitted', 'onboarding'],
      );

      // 0044 removed the legacy user/application payout columns: the view is the only read path.
      const legacyColumns =
        await sql`SELECT column_name FROM information_schema.columns WHERE table_name IN ('user','client_application') AND column_name LIKE 'payout%'`;
      assert.equal(legacyColumns.length, 0);
    } finally {
      await fixture.drop();
    }
  },
);
