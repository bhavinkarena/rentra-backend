import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

const DAY = 86400000;

test(
  'Stories 1.6/1.7 reviewer alerts: resubmission notice, day 7/15/30 milestones, delivery state, scoping',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      Object.assign(process.env, { DATABASE_URL: fixture.url, NODE_ENV: 'test' });
      globalThis.__rentraSql = sql;
      const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
      const alerts = await import('@/services/admin/admin-alerts.js');
      const f = await seedReviewFixture(sql),
        id = f.listing;
      const rows = (kind) =>
        sql`SELECT admin_id, event_key, submission_id, detail FROM admin_alert WHERE kind=${kind} ORDER BY event_key`;

      // First submission is not a response: no reviewer alert.
      const first = await submitProperty(sql, { id, clientId: f.owner });
      assert.equal((await rows('property_resubmitted')).length, 0);
      await decidePropertyReview(sql, {
        id,
        adminId: f.admin,
        input: {
          submissionId: first.submissionId,
          outcome: 'changes_requested',
          reason: 'Correct the map pin and add a pool photo.',
          flagged: ['location'],
        },
      });
      const [review] = await sql`SELECT reviewed_at FROM listing_review WHERE rentable_id=${id}`;
      const at = (days) => new Date(+new Date(review.reviewed_at) + days * DAY + 1000);

      // A draft save alone neither submits nor alerts nor stops milestones.
      await sql`UPDATE rentable SET content_version=content_version+1 WHERE id=${id}`;
      assert.equal((await sql`SELECT status FROM rentable WHERE id=${id}`)[0].status, 'draft');
      assert.equal(await alerts.scheduleCorrectionMilestones(sql, at(6)), 0);
      await alerts.scheduleCorrectionMilestones(sql, at(8));
      let unanswered = await rows('correction_unanswered');
      assert.deepEqual(
        unanswered.map((r) => [r.admin_id, r.detail.days]),
        [[f.admin, 7]],
        'only the assigned reviewer, day 7 only',
      );
      // A missed tick catches up each reached milestone once; replays add nothing.
      await alerts.scheduleCorrectionMilestones(sql, at(31));
      await alerts.scheduleCorrectionMilestones(sql, at(31));
      unanswered = await rows('correction_unanswered');
      assert.deepEqual(
        unanswered.map((r) => r.detail.days).sort((a, b) => a - b),
        [7, 15, 30],
      );
      assert.equal(
        (await sql`SELECT status FROM rentable WHERE id=${id}`)[0].status,
        'draft',
        'never rejected automatically',
      );

      // Explicit resubmission alerts once, names the submission, and stops milestones.
      const second = await submitProperty(sql, { id, clientId: f.owner });
      await assert.rejects(submitProperty(sql, { id, clientId: f.owner }), {
        code: 'ALREADY_SUBMITTED',
      });
      const resubmitted = await rows('property_resubmitted');
      assert.equal(resubmitted.length, 1);
      assert.equal(resubmitted[0].submission_id, second.submissionId);
      assert.equal(resubmitted[0].detail.previousOutcome, 'changes_requested');
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM listing_review WHERE rentable_id=${id}`)[0].n,
        1,
        'earlier correction history kept',
      );
      await alerts.scheduleCorrectionMilestones(sql, at(60));
      assert.equal((await rows('correction_unanswered')).length, 3);

      // Without an eligible assigned reviewer, every property reviewer is alerted (not records-only admins).
      await sql.begin((tx) =>
        alerts.raiseAdminAlert(tx, {
          kind: 'property_resubmitted',
          eventKey: 'fallback-check',
          rentableId: id,
          detail: { pass: 9, title: 'x' },
          assignedTo: null,
        }),
      );
      const fallback = await sql`SELECT admin_id FROM admin_alert WHERE event_key='fallback-check'`;
      assert.deepEqual(fallback.map((r) => r.admin_id).sort(), [f.admin, f.second].sort());

      // Email: unconfigured delivery is visible and never removes the portal alert.
      await alerts.deliverAdminAlertEmails(sql, { env: {} });
      const blocked =
        await sql`SELECT count(*)::int AS n FROM admin_alert WHERE email_state='blocked'`;
      assert.ok(blocked[0].n > 0);
      await sql`UPDATE admin_alert SET email_state='pending', email_next_at=now()`;
      const env = {
        OWNER_NOTIFICATION_DELIVERY: 'enabled',
        RESEND_API_KEY: 're_test',
        OTP_EMAIL_FROM: 'Rentra <alerts@rentra.test>',
        NEXT_PUBLIC_SITE_URL: 'https://rentra.test',
      };
      let calls = 0;
      await alerts.deliverAdminAlertEmails(sql, {
        env,
        adapter: () => ({
          send: async (row, body) => {
            calls++;
            assert.match(body, /https:\/\/rentra\.test\/admin\/properties\//);
            if (calls === 1) throw Object.assign(new Error('x'), { code: 'PROVIDER_RATE_LIMIT' });
            return { id: `email-${row.id}` };
          },
        }),
      });
      const states =
        await sql`SELECT email_state, count(*)::int AS n FROM admin_alert GROUP BY 1 ORDER BY 1`;
      assert.deepEqual(Object.fromEntries(states.map((s) => [s.email_state, s.n])), {
        retry: 1,
        sent: calls - 1,
      });

      // Inbox is scoped to the signed-in reviewer.
      const mine = await alerts.listAdminAlerts(sql, f.admin);
      const theirs = await alerts.listAdminAlerts(sql, f.second);
      assert.ok(mine.length > theirs.length);
      assert.ok(theirs.every((a) => a.propertyId === id));
      await assert.rejects(
        alerts.markAdminAlertRead(sql, { adminId: f.second, alertId: mine[0].id }),
        { statusCode: 404 },
      );
      await alerts.markAdminAlertRead(sql, { adminId: f.admin, alertId: mine[0].id });
      assert.equal(
        (await alerts.listAdminAlerts(sql, f.admin)).find((a) => a.id === mine[0].id).read,
        true,
      );
    } finally {
      await fixture.drop();
    }
  },
);
