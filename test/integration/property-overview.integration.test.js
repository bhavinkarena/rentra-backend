import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedConfirmedBooking, seedReviewFixture } from '../helpers/listing-review-fixture.js';

const future = (days) => {
  const date = new Date(Date.now() + days * 86400000 + 5.5 * 3600000);
  return `${date.toISOString().slice(0, 10)}T11:00`;
};
const ALL = [
  'ownerIdentity',
  'matchesPhotos',
  'amenitiesPresent',
  'locationMatches',
  'ownershipOriginal',
  'safeForGuests',
];
const FINDINGS = 'Private verification findings that must never reach the owner.';

test(
  'CP09 owner overview: scoped, saleable inventory, upcoming visits and client-safe activity',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const f = await seedReviewFixture(sql);
      const id = f.listing;
      const { submitProperty, decidePropertyReview, assignPropertyReview } =
        await import('@/services/admin/listings.js');
      const v = await import('@/services/admin/verification.js');
      const { ownerPropertyOverview } = await import('@/services/auth/property-overview.js');
      const { getClientListingSummary } = await import('@/services/db/listing-queries.js');

      // Another owner, a malformed id and a missing id all read as nothing.
      assert.equal(await ownerPropertyOverview(sql, f.other, id), null);
      assert.equal(await ownerPropertyOverview(sql, f.owner, 'not-a-uuid'), null);
      assert.equal(
        await ownerPropertyOverview(sql, f.owner, '00000000-0000-4000-8000-000000000000'),
        null,
      );

      const { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
      await assignPropertyReview(sql, { id, adminId: f.admin, submissionId, action: 'claim' });
      await decidePropertyReview(sql, {
        id,
        adminId: f.admin,
        input: {
          submissionId,
          outcome: 'approved_for_visit',
          reason: 'Ready for your verification call',
        },
      });
      const { visitId } = await v.scheduleVerification(sql, {
        adminId: f.admin,
        id,
        input: {
          submissionId,
          mode: 'video_call',
          scheduledAt: future(2),
          note: 'Internal scheduling note',
        },
      });
      await v.recordVerificationOutcome(sql, {
        adminId: f.admin,
        id,
        visitId,
        input: { expectedVersion: 1, outcome: 'passed', findings: FINDINGS, checklist: ALL },
      });
      await v.publishProperty(sql, { adminId: f.admin, id, input: { submissionId } });

      // Live but not bookable: hours unconfirmed, no open dates.
      let overview = await ownerPropertyOverview(sql, f.owner, id);
      assert.equal(overview.inventory.bookable, false);
      assert.equal(overview.inventory.nextOpenDate, null);
      assert.equal(overview.publicPath, '/listing/review-farm-review01');
      let summary = await getClientListingSummary(f.owner);
      assert.equal(summary.live, 1);
      assert.equal(summary.bookable, 0, 'live is not bookable');

      // Confirmed hours and opened dates make it bookable; the visit is listed.
      await sql`UPDATE rentable SET booking_config='{"inventoryReady":true}'::jsonb WHERE id=${id}`;
      await sql`INSERT INTO availability(rentable_id,day,slot,units_available,blocked_by_client)
        VALUES (${id},(now() AT TIME ZONE 'Asia/Kolkata')::date + 3,'day',1,false)`;
      const booked = await seedConfirmedBooking(sql, id);
      overview = await ownerPropertyOverview(sql, f.owner, id);
      assert.equal(overview.inventory.bookable, true);
      assert.ok(overview.inventory.nextOpenDate);
      assert.equal(overview.upcomingVisits.total, 1);
      assert.equal(overview.upcomingVisits.items[0].orderId, booked.order);
      assert.equal(overview.upcomingVisits.items[0].reference, 'V-CP08');
      summary = await getClientListingSummary(f.owner);
      assert.equal(summary.bookable, 1);

      // Activity: owner and Rentra events, never internal notes, findings or assignment.
      const actions = overview.activity.map((a) => a.action);
      for (const action of [
        'listing_submitted',
        'listing_review_decided',
        'verification_scheduled',
        'verification_recorded',
        'listing_published',
      ])
        assert.ok(actions.includes(action), `activity has ${action}`);
      assert.equal(actions.includes('listing_review_assigned'), false);
      const text = JSON.stringify(overview);
      for (const secret of [
        FINDINGS,
        'Internal scheduling note',
        'reviewer@fixture.invalid',
        f.admin,
      ])
        assert.equal(text.includes(secret), false, `overview leaks ${secret}`);
      const decision = overview.activity.find((a) => a.action === 'listing_review_decided');
      assert.equal(decision.reason, 'Ready for your verification call');
      assert.equal(decision.actor, 'rentra');
      assert.equal(
        overview.activity.find((a) => a.action === 'verification_recorded').outcome,
        'passed',
      );
      assert.equal(overview.activity.find((a) => a.action === 'listing_submitted').actor, 'you');
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
