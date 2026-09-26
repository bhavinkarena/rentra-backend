import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedConfirmedBooking, seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { ownerEditEffect, ownerPauseTarget } from '@/services/domain/listing-lifecycle.js';

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
const FINDINGS = 'Walked the property with the owner; photos, pool and access road match.';
const REASON = 'Guest safety report under investigation';

test(
  'CP08 admin restriction, owner pause separation, corrections and preserved history',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const f = await seedReviewFixture(sql);
      const id = f.listing;
      const { submitProperty, decidePropertyReview, readPropertyReview, propertyReviewContext } =
        await import('@/services/admin/listings.js');
      const v = await import('@/services/admin/verification.js');
      const lc = await import('@/services/admin/property-lifecycle.js');
      const { getListingByCode } = await import('@/services/db/queries.js');
      const { readBookingRecord } = await import('@/services/booking/records.js');

      const verify = async () => {
        const { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
        await decidePropertyReview(sql, {
          id,
          adminId: f.admin,
          input: { submissionId, outcome: 'approved_for_visit', reason: 'Ready for verification' },
        });
        const { visitId } = await v.scheduleVerification(sql, {
          adminId: f.admin,
          id,
          input: { submissionId, mode: 'video_call', scheduledAt: future(2) },
        });
        await v.recordVerificationOutcome(sql, {
          adminId: f.admin,
          id,
          visitId,
          input: { expectedVersion: 1, outcome: 'passed', findings: FINDINGS, checklist: ALL },
        });
        return submissionId;
      };
      const publish = (submissionId) =>
        v.publishProperty(sql, { adminId: f.admin, id, input: { submissionId } });
      const state = () => lc.lifecycleState(sql, id);
      const hide = (expectedVersion, reason = REASON) =>
        lc.hideProperty(sql, { adminId: f.admin, id, input: { expectedVersion, reason } });
      const restore = (expectedVersion) =>
        lc.restoreProperty(sql, {
          adminId: f.admin,
          id,
          input: { expectedVersion, reason: 'Investigation closed; no issue found' },
        });
      // The owner's pause/resume and edit paths apply these pure rules to the row under the
      // same conditional/locked update the server actions use.
      const ownerToggle = async () => {
        const [row] = await sql`SELECT status FROM rentable WHERE id=${id}`;
        const target = ownerPauseTarget(row.status);
        if (target.error) return target;
        const moved =
          await sql`UPDATE rentable SET status=${target.next}, prior_status=${row.status}
          WHERE id=${id} AND status=${row.status} RETURNING id`;
        return moved.length ? target : { error: 'changed' };
      };
      const ownerTrustEdit = (column, value) =>
        sql.begin(async (tx) => {
          const [row] =
            await tx`SELECT status, prior_status FROM rentable WHERE id=${id} FOR UPDATE`;
          const { patch } = ownerEditEffect(
            { status: row.status, priorStatus: row.prior_status },
            true,
          );
          await tx`UPDATE rentable SET ${tx({ [column]: value, status: patch.status ?? row.status, prior_status: patch.priorStatus ?? row.prior_status })} WHERE id=${id}`;
        });

      const [{ udt_name: geometryType }] =
        await sql`SELECT udt_name FROM information_schema.columns WHERE table_name='rentable' AND column_name='location'`;
      if (geometryType !== 'geometry') {
        // Local test clusters have no PostGIS; the booking record only reads coordinates.
        await sql`CREATE FUNCTION st_x(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
        await sql`CREATE FUNCTION st_y(text) RETURNS float8 LANGUAGE sql AS 'SELECT NULL::float8'`;
      }

      // 1. Published property with a confirmed upcoming visit.
      const firstSubmission = await verify();
      await publish(firstSubmission);
      const booked = await seedConfirmedBooking(sql, id);
      let s = await state();
      assert.equal(s.status, 'live');
      assert.equal(s.publiclyVisible, true);
      assert.equal(s.upcomingVisits, 1);
      assert.equal(s.hide.allowed, true);
      assert.equal(s.restore.allowed, false);

      // 2. Owner pause wins the race: the admin's hide prepared on "live" is refused.
      await assert.rejects(hide(s.version, 'short'), { statusCode: 422 });
      assert.deepEqual(await ownerToggle(), { next: 'paused' });
      await assert.rejects(hide(s.version), { statusCode: 409, code: 'LISTING_CHANGED' });
      s = await state();
      await hide(s.version);
      s = await state();
      assert.equal(s.status, 'hidden');
      assert.equal(s.priorStatus, 'paused');
      assert.equal(s.restriction.reason, REASON);
      await assert.rejects(hide(s.version), { code: 'ALREADY_HIDDEN' });

      // 3. The owner cannot undo the restriction; the public read is gone; bookings stand.
      assert.match((await ownerToggle()).error, /Only Rentra can restore it/);
      assert.equal((await sql`SELECT status FROM rentable WHERE id=${id}`)[0].status, 'hidden');
      assert.equal(await getListingByCode('review01'), null);
      await assert.rejects(submitProperty(sql, { id, clientId: f.owner }), {
        code: 'LISTING_NOT_SUBMITTABLE',
      });
      for (const actor of [
        { kind: 'admin', id: f.admin },
        { kind: 'owner', id: f.owner },
      ]) {
        const record = await readBookingRecord(sql, actor, booked.order);
        assert.equal(record.title, 'Review River Farm (as booked)');
        assert.equal(record.arrival.address, '12 Private Lane');
      }
      const context = await propertyReviewContext(sql, id);
      assert.equal(context.restriction.reason, REASON);

      // 4. Two restores race: one wins; the property returns to the owner's pause.
      const race = await Promise.allSettled([restore(s.version), restore(s.version)]);
      assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      s = await state();
      assert.equal(s.status, 'paused');
      assert.equal(s.restriction, null);
      assert.deepEqual(await ownerToggle(), { next: 'live' });

      // 5. A trust edit while hidden changes what restore returns to: never live unreviewed.
      s = await state();
      await hide(s.version);
      await ownerTrustEdit('capacity', 14);
      s = await state();
      assert.equal(s.status, 'hidden');
      assert.equal(s.priorStatus, 'pending_review');
      assert.equal(s.restore.target, 'pending_review');
      await restore(s.version);
      assert.equal((await state()).status, 'pending_review');
      assert.equal((await propertyReviewContext(sql, id)).needsResubmission, true);

      // 6. Hide blocks publication of a verified revision; restore returns it to verification.
      const second = await verify();
      s = await state();
      assert.equal(s.status, 'pending_verification');
      await hide(s.version);
      await assert.rejects(publish(second), { statusCode: 409, code: 'PUBLICATION_BLOCKED' });
      s = await state();
      await restore(s.version);
      assert.equal((await state()).status, 'pending_verification');
      // Publication racing a hide: exactly one of them commits against this state.
      s = await state();
      const contest = await Promise.allSettled([publish(second), hide(s.version)]);
      assert.equal(contest.filter((r) => r.status === 'fulfilled').length, 1);
      s = await state();
      if (s.status === 'hidden') {
        await restore(s.version);
        await publish(second);
      }
      assert.equal((await state()).status, 'live');

      // 7. A content change while hidden from verification invalidates that approval.
      await sql`UPDATE rentable SET status='pending_verification' WHERE id=${id}`;
      s = await state();
      await hide(s.version);
      await sql`UPDATE rentable_price SET weekday=1100 WHERE rentable_id=${id}`;
      s = await state();
      assert.equal(s.priorStatus, 'pending_review');
      await restore(s.version);
      assert.equal((await state()).status, 'pending_review');
      await sql`UPDATE rentable SET status='live', prior_status=NULL WHERE id=${id}`;

      // 8. Documented corrections: version-guarded, status-preserving, audited.
      s = await state();
      const correct = (input) => lc.correctProperty(sql, { adminId: f.admin, id, input });
      const correction = {
        expectedContentVersion: s.contentVersion,
        reason: 'Remove a discriminatory house rule',
        title: 'Review River Farm Corrected',
        description: s.correction.current.description,
        highlight: '',
        rulesNotes: 'Families and groups welcome.',
      };
      await assert.rejects(
        correct({ ...correction, expectedContentVersion: s.contentVersion - 1 }),
        {
          code: 'CONTENT_CHANGED',
        },
      );
      await assert.rejects(
        correct({ ...correction, title: s.correction.current.title, rulesNotes: '' }),
        {
          statusCode: 422,
        },
      );
      const corrected = await correct(correction);
      assert.deepEqual(corrected.changed.sort(), ['rulesNotes', 'title']);
      const [row] =
        await sql`SELECT status, slug, title, house_rules, published_submission_id FROM rentable WHERE id=${id}`;
      assert.equal(row.status, 'live');
      assert.equal(row.slug, 'review-river-farm-corrected-review01');
      assert.equal(row.house_rules.notes, 'Families and groups welcome.');
      assert.equal(row.published_submission_id, second);
      assert.ok(await getListingByCode('review01'));
      const [changedAudit] =
        await sql`SELECT before, after, reason FROM audit_log WHERE action='listing_corrected'`;
      assert.equal(changedAudit.before.title, 'Review River Farm');
      assert.equal(changedAudit.after.title, 'Review River Farm Corrected');
      assert.deepEqual((await propertyReviewContext(sql, id)).correction.fields.sort(), [
        'rulesNotes',
        'title',
      ]);
      await sql`UPDATE rentable SET status='pending_review' WHERE id=${id}`;
      await assert.rejects(
        correct({ ...correction, expectedContentVersion: (await state()).contentVersion }),
        { code: 'CORRECTION_NOT_ALLOWED' },
      );

      // 9. History is kept: the accepted booking snapshot, the activity and no cascade delete.
      const [order] =
        await sql`SELECT listing_snapshot FROM booking_order WHERE id=${booked.order}`;
      assert.equal(order.listing_snapshot.title, 'Review River Farm (as booked)');
      const detail = await readPropertyReview(sql, id);
      const actions = detail.activity.map((a) => a.action);
      for (const action of [
        'listing_hidden',
        'listing_restored',
        'listing_corrected',
        'listing_published',
      ])
        assert.ok(actions.includes(action), `activity has ${action}`);
      assert.ok(detail.lifecycle);
      await assert.rejects(sql`DELETE FROM rentable WHERE id=${id}`, /foreign key/);
      await sql`DELETE FROM booking WHERE order_id=${booked.order}`;
      await sql`DELETE FROM booking_order WHERE id=${booked.order}`;
      await assert.rejects(
        sql`DELETE FROM rentable WHERE id=${id}`,
        /foreign key/,
        'review history also blocks deletion',
      );
      assert.ok((await sql`SELECT id FROM listing_review WHERE rentable_id=${id}`).length >= 2);
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
