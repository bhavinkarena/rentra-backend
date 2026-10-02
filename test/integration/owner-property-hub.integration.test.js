import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Phase 6 property hub: dated pause and auto-resume, needs-you list, strength, flags and review filter',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = fixture.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = fixture.url;
      process.env.SESSION_SECRET ??= 'owner-property-hub-disposable-secret-only';
      const f = await seedReviewFixture(sql);
      await sql`UPDATE rentable SET status='live',bedrooms=3,published_at=now() WHERE id=${f.listing}`;
      const { runWithContext } = await import('@/runtime/context.js');
      const { encryptSession } = await import('@/services/auth/session-crypto.js');
      const { issuePortalSession } = await import('@/services/auth/portal-sessions.js');
      const actions = await import('@/services/auth/listings.js');
      const { getClientListingsPage, getClientListingSummary } =
        await import('@/services/db/listing-queries.js');
      const { ownerPropertyOverview } = await import('@/services/auth/property-overview.js');
      const { reviewQueue } = await import('@/services/reviews/service.js');
      const { addLocalDays, propertyToday } = await import('@/services/domain/booking-dates.js');
      const token = await encryptSession({
        role: 'client',
        userId: f.owner,
        sessionId: await issuePortalSession(sql, 'client', f.owner, 3600),
      });
      const asOwner = (action, values) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(values)) form.append(key, String(value));
        return runWithContext({ req: { cookies: { rentra_session: token } } }, () =>
          action(null, form),
        );
      };
      const row = async () => (await sql`SELECT * FROM rentable WHERE id=${f.listing}`)[0];

      // Live with no open dates is waiting on the owner.
      let page = await getClientListingsPage(f.owner, { status: 'needs_you' });
      assert.deepEqual(
        page.items.map((i) => i.id),
        [f.listing],
      );
      assert.equal(page.items[0].bookable, false);
      assert.equal(typeof page.items[0].strength, 'number');
      assert.ok(page.items[0].cover?.url, 'the card carries its cover photo');
      assert.equal((await getClientListingSummary(f.owner)).needsYou, 1);

      // A dated pause stores its end without counting as a content edit.
      const before = await row();
      const bad = await asOwner(actions.toggleListingPause, {
        id: f.listing,
        until: propertyToday(),
      });
      assert.ok(bad.errors.until, 'today is not a future end date');
      const until = addLocalDays(propertyToday(), 3);
      const paused = await asOwner(actions.toggleListingPause, { id: f.listing, until });
      assert.equal(paused.ok, true);
      let now = await row();
      assert.equal(now.status, 'paused');
      assert.equal(now.paused_until, until);
      assert.equal(now.content_version, before.content_version);
      assert.equal((await ownerPropertyOverview(sql, f.owner, f.listing)).pausedUntil, until);

      // The worker resumes it on the end date, and only then.
      assert.deepEqual(await actions.resumeEndedPauses(sql), { resumed: 0 });
      await sql`UPDATE rentable SET paused_until=(now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id=${f.listing}`;
      assert.deepEqual(await actions.resumeEndedPauses(sql), { resumed: 1 });
      now = await row();
      assert.equal(now.status, 'live');
      assert.equal(now.paused_until, null);
      const [audit] =
        await sql`SELECT actor_type FROM audit_log WHERE entity_id=${f.listing} AND action='listing_resumed' ORDER BY at DESC LIMIT 1`;
      assert.equal(audit.actor_type, 'system');

      // Overview carries the timeline, stats and a strength list with fix targets.
      const overview = await ownerPropertyOverview(sql, f.owner, f.listing);
      assert.ok(overview.timeline.draft && overview.timeline.live);
      assert.equal(overview.stats.bookingsThisMonth, 0);
      assert.equal(overview.strength.total, overview.strength.items.length);
      const done = (key) => overview.strength.items.find((i) => i.key === key).done;
      assert.equal(done('photos'), false, 'six photos is below ten');
      assert.equal(done('prices'), true, 'the fixture prices both day types');
      assert.equal(done('review_replies'), true, 'no reviews means none unanswered');

      // An admin "changes requested" draft is the owner's to fix.
      await sql`UPDATE rentable SET status='draft' WHERE id=${f.listing}`;
      const [submission] =
        await sql`INSERT INTO listing_submission(rentable_id,content_version,pass_number,snapshot,submitted_by)
        VALUES (${f.listing},${now.content_version},1,'{}',${f.owner}) RETURNING id`;
      await sql`INSERT INTO listing_review(rentable_id,pass_number,submission_id,outcome,reason,flagged_fields,reviewed_by)
        VALUES (${f.listing},1,${submission.id},'changes_requested','Add a pool photo','["photos","basics"]',${f.admin})`;
      page = await getClientListingsPage(f.owner, { status: 'needs_you' });
      assert.equal(page.items[0].reviewOutcome, 'changes_requested');
      page = await getClientListingsPage(f.owner, { status: 'drafts' });
      assert.equal(page.items.length, 1);

      // Reviews can be read for one property.
      const reviews = await reviewQueue(sql, { kind: 'owner', id: f.owner }, 1, f.listing);
      assert.deepEqual(reviews.rows, []);
      await assert.rejects(reviewQueue(sql, { kind: 'owner', id: f.owner }, 1, 'not-a-uuid'));
    } finally {
      await fixture.drop();
    }
  },
);
