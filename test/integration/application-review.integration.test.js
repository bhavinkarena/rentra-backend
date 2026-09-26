import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';

// Explicit disposable server only (e.g. postgresql://postgres@127.0.0.1:55432/postgres).
test(
  'CP05 Gate 1 queue, assignment, version-guarded decisions and resubmission',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.SESSION_SECRET ??= 'cp05-disposable-fixture-signing-secret-only';
      const review = await import('@/services/admin/applications.js');
      const { profileCompletion } = await import('@/services/auth/profile.js');
      const { issuePortalSession, validPortalSession } =
        await import('@/services/auth/portal-sessions.js');

      const admin = async (email) =>
        (
          await sql`INSERT INTO admin_user(email,password_hash,name) VALUES (${email},'x',${email}) RETURNING id`
        )[0].id;
      const alice = await admin('alice@fixture.invalid');
      const bob = await admin('bob@fixture.invalid');
      const applicant = async (email, fields = {}) => {
        const [user] =
          await sql`INSERT INTO "user"(email,role,account_status,name,phone,client_type,email_verified_at,phone_verified_at)
          VALUES (${email},'client','pending_application','Asha Patel',${String(Math.random()).slice(2, 12)},'owner',now(),now()) RETURNING id`;
        const [app] =
          await sql`INSERT INTO client_application(user_id,status,legal_name,residential_address,pincode,submitted_at,
            payout_upi_id,payout_name_match,consent_at)
          VALUES (${user.id},${fields.status ?? 'submitted'},'Asha Patel','12 Ring Road','395007',now() - interval '60 hours',
            'asha@upi',${fields.payoutMatch ?? null},now()) RETURNING id`;
        return { userId: user.id, appId: app.id };
      };
      const one = await applicant('one@fixture.invalid');
      const two = await applicant('two@fixture.invalid');
      const mismatch = await applicant('three@fixture.invalid', { payoutMatch: false });
      await applicant('draft@fixture.invalid', { status: 'draft' });
      const session = {
        role: 'client',
        userId: one.userId,
        sessionId: await issuePortalSession(sql, 'client', one.userId, 3600),
      };

      // KYC uploads belong to the application; the client and admin lists must find them.
      const { listApplicationDocuments } = await import('@/services/auth/documents.js');
      await sql`INSERT INTO document(owner_type,owner_id,doc_type,side,storage_key,status)
        VALUES ('client_application',${two.appId},'pan_card','front','fixture/pan','uploaded')`;
      assert.equal((await listApplicationDocuments(two.userId)).length, 1);
      assert.equal((await listApplicationDocuments(one.userId)).length, 0, 'scoped to the owner');

      // Queue: submitted first, oldest first, authoritative counts, overdue, filters.
      const queue = await review.listApplications(sql, alice, {});
      assert.equal(queue.status, 'submitted');
      assert.equal(queue.total, 3);
      assert.equal(queue.counts.draft, 1);
      assert.equal(queue.counts.overdue, 3);
      assert.ok(queue.items.every((item) => item.overdue && item.ageHours >= 59));
      assert.equal(
        queue.items.find((i) => i.id === mismatch.appId).blocker,
        'payout name mismatch',
      );
      assert.equal((await review.listApplications(sql, alice, { q: 'three@' })).total, 1);

      // Assignment: claim, conflict, take over, release rules.
      await review.assignApplication(sql, {
        adminId: alice,
        applicationId: one.appId,
        action: 'claim',
      });
      await assert.rejects(
        review.assignApplication(sql, { adminId: bob, applicationId: one.appId, action: 'claim' }),
        { statusCode: 409, code: 'ASSIGNED_ELSEWHERE' },
      );
      assert.equal((await review.listApplications(sql, alice, { assignee: 'me' })).total, 1);
      assert.equal((await review.listApplications(sql, bob, { assignee: 'unassigned' })).total, 2);
      await review.assignApplication(sql, {
        adminId: bob,
        applicationId: one.appId,
        action: 'takeover',
      });
      await assert.rejects(
        review.assignApplication(sql, {
          adminId: alice,
          applicationId: one.appId,
          action: 'release',
        }),
        { statusCode: 409, code: 'NOT_ASSIGNED_TO_YOU' },
      );
      const decide = (adminId, applicationId, decision, input) =>
        review.decideApplication(sql, { adminId, applicationId, decision, input, ip: '127.0.0.1' });
      await assert.rejects(decide(alice, one.appId, 'approve', { expectedVersion: 1 }), {
        statusCode: 409,
        code: 'ASSIGNED_ELSEWHERE',
      });
      await review.assignApplication(sql, {
        adminId: bob,
        applicationId: one.appId,
        action: 'release',
      });

      // Two reviewers, contradictory decisions on the same version: exactly one commits.
      const race = await Promise.allSettled([
        decide(alice, one.appId, 'approve', { expectedVersion: 1 }),
        decide(bob, one.appId, 'reject', { reason: 'Documents unreadable', expectedVersion: 1 }),
      ]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      assert.equal(race.find((r) => r.status === 'rejected').reason.statusCode, 409);
      const winner = race.find((r) => r.status === 'fulfilled').value;
      const decisions = await sql`SELECT action, before::text AS before FROM audit_log
        WHERE entity='client_application' AND entity_id=${one.appId} AND action IN ('application_approved','application_rejected')`;
      assert.equal(decisions.length, 1, 'one decision record');
      assert.equal(decisions[0].before.includes('Asha'), false, 'fingerprint, not values');
      const [account] = await sql`SELECT account_status FROM "user" WHERE id=${one.userId}`;
      assert.equal(
        account.account_status,
        winner.status === 'approved' ? 'active' : 'pending_application',
      );
      if (winner.status === 'approved') {
        assert.equal(
          await validPortalSession(sql, session, 'client'),
          true,
          'approval keeps the session',
        );
      }
      await assert.rejects(decide(alice, one.appId, 'approve', { expectedVersion: 1 }), {
        statusCode: 409,
      });

      // Structured correction request → client stepper → resubmission → change detection.
      await assert.rejects(
        decide(alice, two.appId, 'more_info', { reason: 'Fix it', expectedVersion: 1 }),
        (error) => error.statusCode === 422 && Boolean(error.fields.flagged),
      );
      const sent = await decide(alice, two.appId, 'more_info', {
        reason: 'The name on your PAN differs from the bill.',
        flagged: ['details', 'kyc'],
        expectedVersion: 1,
      });
      assert.equal(sent.reviewVersion, 2);
      const [types] = await sql`SELECT jsonb_typeof(a.flagged_fields) AS flagged,
          (SELECT jsonb_typeof(before) FROM audit_log WHERE action='application_more_info') AS audit
        FROM client_application a WHERE a.id=${two.appId}`;
      assert.deepEqual(
        types,
        { flagged: 'array', audit: 'object' },
        'jsonb stored as structured values',
      );
      const [returned] = await sql`SELECT * FROM client_application WHERE id=${two.appId}`;
      const [owner] = await sql`SELECT * FROM "user" WHERE id=${two.userId}`;
      const steps = profileCompletion(
        {
          ...owner,
          emailVerifiedAt: owner.email_verified_at,
          phoneVerifiedAt: owner.phone_verified_at,
          clientType: owner.client_type,
          accountStatus: owner.account_status,
        },
        {
          status: returned.status,
          flaggedFields: returned.flagged_fields,
          residentialAddress: returned.residential_address,
          consentAt: returned.consent_at,
        },
        [],
      ).steps;
      assert.deepEqual(
        steps.filter((s) => s.flagged).map((s) => s.id),
        ['details', 'kyc'],
      );
      await sql`UPDATE client_application SET legal_name='Asha J. Patel' WHERE id=${two.appId}`;
      await sql`UPDATE client_application SET status='submitted', submitted_at=now(), flagged_fields=NULL,
        review_version=review_version+1 WHERE id=${two.appId} AND status IN ('draft','more_info_needed','rejected')`;
      await sql`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES ('client',${two.userId},'client_application',${two.appId},'application_submitted')`;
      const context = await review.readReviewContext(sql, two.appId, alice);
      assert.equal(context.reviewVersion, 3);
      assert.deepEqual(context.changedSinceLastDecision, ['legalName']);
      assert.equal(context.assignee.id, alice, 'resubmission returns to the reviewer who asked');
      await assert.rejects(
        decide(alice, two.appId, 'approve', { expectedVersion: 2 }),
        { statusCode: 409, code: 'APPLICATION_CHANGED' },
        'a decision from before the resubmission cannot commit',
      );
      const approved = await decide(alice, two.appId, 'approve', { expectedVersion: 3 });
      assert.equal(approved.status, 'approved');

      // Approval blockers.
      await assert.rejects(decide(alice, mismatch.appId, 'approve', { expectedVersion: 1 }), {
        statusCode: 409,
        code: 'APPROVAL_BLOCKED',
      });
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${mismatch.userId}`;
      await sql`UPDATE client_application SET payout_name_match=true WHERE id=${mismatch.appId}`;
      await assert.rejects(decide(alice, mismatch.appId, 'approve', { expectedVersion: 1 }), {
        statusCode: 409,
        code: 'ACCOUNT_NOT_PENDING',
      });

      // Third strike blocks the account and ends its sessions.
      await sql`UPDATE "user" SET account_status='pending_application' WHERE id=${mismatch.userId}`;
      await sql`UPDATE client_application SET strike_count=2 WHERE id=${mismatch.appId}`;
      const blockedSession = {
        role: 'client',
        userId: mismatch.userId,
        sessionId: await issuePortalSession(sql, 'client', mismatch.userId, 3600),
      };
      const third = await decide(bob, mismatch.appId, 'reject', {
        reason: 'Repeated mismatched identity',
        expectedVersion: 1,
      });
      assert.equal(third.accountBlocked, true);
      assert.equal(await validPortalSession(sql, blockedSession, 'client'), false);
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
