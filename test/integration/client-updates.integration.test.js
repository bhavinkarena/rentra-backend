import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const FINDINGS = 'Private findings that must never reach the owner inbox.';
const NOTE = 'Internal scheduling note for operators only';

test(
  'CP15 client updates: trigger-written, idempotent, scoped, muted info and tasks that match their lists',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      const f = await seedReviewFixture(sql);
      const id = f.listing;
      const { submitProperty, decidePropertyReview } = await import('@/services/admin/listings.js');
      const v = await import('@/services/admin/verification.js');
      const lc = await import('@/services/admin/property-lifecycle.js');
      const inbox = await import('@/services/auth/client-inbox.js');
      const { lifecycle } = await import('@/services/booking/checkout.js');
      const cases = await import('@/services/booking/booking-cases.js');
      const { getClientListingsPage } = await import('@/services/db/listing-queries.js');
      const list = (input = {}) => inbox.listClientUpdates(sql, f.owner, input);
      const actions = async () => (await list()).items.map((u) => u.action);

      // Client actions and pre-existing history produce nothing.
      let { submissionId } = await submitProperty(sql, { id, clientId: f.owner });
      assert.equal((await list()).total, 0);

      // A correction request is required work with its client-facing reason.
      await decidePropertyReview(sql, {
        id,
        adminId: f.admin,
        input: {
          submissionId,
          outcome: 'changes_requested',
          reason: 'Please fix the house rules.',
          flagged: ['rules'],
        },
      });
      let page = await list();
      assert.equal(page.total, 1);
      assert.equal(page.items[0].kind, 'action');
      assert.equal(page.items[0].category, 'property');
      assert.equal(page.items[0].detail.reason, 'Please fix the house rules.');
      assert.equal(page.items[0].detail.outcome, 'changes_requested');
      assert.equal(page.items[0].propertyTitle, 'Review River Farm');
      assert.equal(page.unread, 1);
      assert.equal(page.action, 1);
      assert.equal(
        (await inbox.listClientUpdates(sql, f.other, {})).total,
        0,
        'another owner sees nothing',
      );

      // Tasks agree with the lists they open.
      let tasks = Object.fromEntries(
        (await inbox.clientTasks(sql, f.owner)).tasks.map((t) => [t.key, t]),
      );
      assert.equal(tasks.properties_attention.count, 1);
      assert.equal(
        tasks.properties_attention.count,
        (await getClientListingsPage(f.owner, { status: 'attention' })).total,
      );
      assert.equal(tasks.updates_action.count, (await list({ filter: 'action' })).total);

      // Approval, verification (with private notes and findings) and publication.
      ({ submissionId } = await submitProperty(sql, { id, clientId: f.owner }));
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
        input: { submissionId, mode: 'video_call', scheduledAt: future(2), note: NOTE },
      });
      await v.recordVerificationOutcome(sql, {
        adminId: f.admin,
        id,
        visitId,
        input: { expectedVersion: 1, outcome: 'passed', findings: FINDINGS, checklist: ALL },
      });
      await v.publishProperty(sql, { adminId: f.admin, id, input: { submissionId } });
      for (const action of [
        'listing_review_decided',
        'verification_scheduled',
        'verification_recorded',
        'listing_published',
      ])
        assert.ok((await actions()).includes(action), `inbox has ${action}`);
      const text = JSON.stringify(await list());
      for (const secret of [FINDINGS, NOTE, 'reviewer@fixture.invalid', f.admin])
        assert.equal(text.includes(secret), false, `inbox leaks ${secret}`);
      tasks = Object.fromEntries(
        (await inbox.clientTasks(sql, f.owner)).tasks.map((t) => [t.key, t]),
      );
      assert.equal(tasks.properties_unbookable.count, 1, 'live without hours is not bookable');
      assert.equal(
        tasks.properties_unbookable.count,
        (await getClientListingsPage(f.owner, { status: 'unbookable' })).total,
      );

      // Repeat delivery: the same lifecycle event twice is one update.
      const booked = await seedConfirmedBooking(sql, id);
      await sql.begin((tx) => lifecycle(tx, booked.order, 'confirmed'));
      await sql.begin((tx) => lifecycle(tx, booked.order, 'confirmed'));
      const confirmations = (await list({ category: 'booking' })).items;
      assert.equal(confirmations.length, 1);
      assert.equal(confirmations[0].detail.reference, 'ORD-CP08');
      assert.equal(confirmations[0].detail.simulation, true, 'non-real provenance is marked');
      assert.equal(confirmations[0].orderId, booked.order);

      // Preferences: info categories only, version-guarded, applied to new events.
      let prefs = await inbox.readClientPreferences(sql, f.owner);
      assert.equal(prefs.version, 0);
      await assert.rejects(
        inbox.saveClientPreferences(sql, f.owner, { expectedVersion: 0, muted: ['account'] }),
        {
          statusCode: 422,
        },
      );
      prefs = await inbox.saveClientPreferences(sql, f.owner, {
        expectedVersion: 0,
        muted: ['booking', 'property'],
      });
      assert.equal(prefs.version, 1);
      await assert.rejects(
        inbox.saveClientPreferences(sql, f.owner, { expectedVersion: 0, muted: [] }),
        {
          code: 'PREFERENCES_CHANGED',
        },
      );
      const before = (await list()).unread;
      await sql.begin((tx) => lifecycle(tx, booked.order, `cancel_${'a'.repeat(32)}`));
      const cancelled = (await list({ category: 'booking' })).items.find(
        (u) => u.action === 'visits_cancelled',
      );
      assert.equal(cancelled.read, true, 'muted information arrives already read');
      assert.equal((await list()).unread, before);
      // Required work is never muted, even in a muted category.
      const state = await lc.lifecycleState(sql, id);
      await lc.hideProperty(sql, {
        adminId: f.admin,
        id,
        input: {
          expectedVersion: state.version,
          reason: 'Guest safety report under investigation',
        },
      });
      const hidden = (await list({ filter: 'action' })).items.find(
        (u) => u.action === 'listing_hidden',
      );
      assert.ok(hidden, 'hide is required work');
      assert.equal(hidden.read, false);
      assert.equal(hidden.detail.reason, 'Guest safety report under investigation');

      // Case messages: Rentra's owner-visible messages only.
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booked.order}`;
      const opened = await cases.createBookingCase(
        sql,
        { kind: 'owner', id: f.owner },
        {
          orderId: booked.order,
          type: 'operational',
          visitIds: [visit.id],
          reason: 'The gate code does not work for guests.',
          requestKey: randomUUID(),
        },
      );
      const caseCount = async () => (await list({ category: 'case' })).total;
      const afterOpen = await caseCount();
      await cases.addCaseUpdate(
        sql,
        { kind: 'owner', id: f.owner },
        { caseId: opened.id, body: 'Adding a photo later.', requestKey: randomUUID() },
      );
      await cases.addCaseUpdate(
        sql,
        { kind: 'admin', id: f.admin },
        {
          caseId: opened.id,
          audience: 'internal',
          body: 'Internal triage note.',
          requestKey: randomUUID(),
        },
      );
      assert.equal(await caseCount(), afterOpen, 'owner and internal messages create nothing');
      await cases.addCaseUpdate(
        sql,
        { kind: 'admin', id: f.admin },
        {
          caseId: opened.id,
          audience: 'client',
          body: 'We have reset the gate code.',
          requestKey: randomUUID(),
        },
      );
      assert.equal(await caseCount(), afterOpen + 1);
      assert.equal(
        JSON.stringify(await list({ category: 'case' })).includes('Internal triage note'),
        false,
      );

      // Read state: scoped, persisted, idempotent.
      const target = (await list({ filter: 'unread' })).items[0];
      await assert.rejects(inbox.markClientUpdatesRead(sql, f.other, { id: target.id }), {
        statusCode: 404,
      });
      assert.equal((await inbox.markClientUpdatesRead(sql, f.owner, { id: target.id })).updated, 1);
      assert.equal((await inbox.markClientUpdatesRead(sql, f.owner, { id: target.id })).updated, 0);
      assert.equal((await list()).items.find((u) => u.id === target.id).read, true);
      await inbox.markClientUpdatesRead(sql, f.owner, { all: '1' });
      page = await list();
      assert.equal(page.unread, 0);
      assert.equal(page.action, 0);
      assert.equal((await list({ filter: 'action' })).total, 0);
      tasks = await inbox.clientTasks(sql, f.owner);
      assert.equal(tasks.unread, 0);
      assert.equal(
        Object.fromEntries(tasks.tasks.map((t) => [t.key, t])).properties_hidden.count,
        1,
      );
    } finally {
      delete globalThis.__rentraSql;
      await fixture.drop();
    }
  },
);
