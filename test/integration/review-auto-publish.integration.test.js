import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { seedReviewModeration } from '../helpers/review-moderation-fixture.js';
import { submitReview, moderateReview, reviewQueue } from '../../src/services/reviews/service.js';

test(
  'Story 5.1: clean eligible reviews auto-publish; flagged wait; published reviews outlive the writing window',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      // First visit: real handover/return/complete evidence, reviewed with clean 1-star text.
      const harsh =
        'Terrible visit. The garden was dirty and nobody answered our questions all day.';
      const first = await seedReviewModeration(sql, f, booking, { body: harsh, pending: false });
      const s = first.customer;
      const totals = async () =>
        (await sql`SELECT review_count,rating_avg FROM rentable WHERE id=${f.listing}`)[0];
      const [r1] = await sql`SELECT * FROM review WHERE id=${first.reviewId}`;
      assert.equal(r1.moderation_state, 'published', 'harsh-but-clean 1★ publishes');
      assert.equal(r1.moderated_by, null);
      assert.equal(r1.moderation_reason, 'auto:clean');
      assert.deepEqual(await totals(), { review_count: 1, rating_avg: 1 });
      const audits = async (id) =>
        (await sql`SELECT action FROM audit_log WHERE entity='review' AND entity_id=${id}`).map(
          (a) => a.action,
        );
      assert.deepEqual(await audits(r1.id), ['review_auto_published']);

      // Duplicate identical: no-op with current state; different text: ALREADY_REVIEWED.
      const again = await submitReview(sql, s, { visitId: first.visitId, rating: 1, body: harsh });
      assert.deepEqual(again, { id: r1.id, state: 'published' });
      await assert.rejects(
        submitReview(sql, s, { visitId: first.visitId, rating: 2, body: harsh }),
        { code: 'ALREADY_REVIEWED' },
      );

      // More completed stays for the same guest (stay slot: completion + real provenance).
      const visit = async (state = 'completed', endedDaysAgo = 1) => {
        const [order] =
          await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash)
          VALUES (${`AP-${randomUUID()}`},${s.userId},${f.listing},'confirmed','INR','Asia/Kolkata','v1','v1','{}','{}',100000,0,0,${randomUUID()},${'c'.repeat(64)}) RETURNING id`;
        const ends = typeof endedDaysAgo === 'number' ? `${endedDaysAgo} days` : endedDaysAgo;
        const [b] =
          await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,state,visit_provenance)
          VALUES (${`R${randomUUID().slice(0, 12)}`},${f.listing},${s.userId},${order.id},1,(now()-${ends}::interval)::date - 1,'stay',2,now()-${ends}::interval-interval '2 days',now()-${ends}::interval,now()-${ends}::interval-interval '2 days',now()-${ends}::interval,true,'INR','Asia/Kolkata',100000,0,0,${state},'real') RETURNING id`;
        return b.id;
      };
      const clean = await submitReview(sql, s, {
        visitId: await visit(),
        rating: 4,
        body: 'Lovely lawn, helpful caretaker and the pool was clean.',
      });
      assert.equal(clean.state, 'published');
      assert.deepEqual(await totals(), { review_count: 2, rating_avg: 2.5 });

      const flagged = {};
      for (const [key, body] of Object.entries({
        phone: 'Nice place but call the caretaker on 98765 43210 for cheaper rates.',
        email: 'Nice place but write to caretaker.direct@gmail.com for a better deal.',
        url: 'Nice place but book via https://cheap-stays.example instead of here.',
        abuse: 'The caretaker is a total bastard and should not run this place.',
      })) {
        const r = await submitReview(sql, s, { visitId: await visit(), rating: 3, body });
        assert.equal(r.state, 'pending', key);
        flagged[key] = r.id;
      }
      const reasons = Object.fromEntries(
        await Promise.all(
          Object.entries(flagged).map(async ([k, id]) => [
            k,
            (await sql`SELECT moderation_reason FROM review WHERE id=${id}`)[0].moderation_reason,
          ]),
        ),
      );
      assert.deepEqual(reasons, {
        phone: 'auto:private_information',
        email: 'auto:private_information',
        url: 'auto:spam',
        abuse: 'auto:harassment',
      });
      assert.deepEqual(await audits(flagged.phone), ['review_auto_flagged']);
      assert.deepEqual(await totals(), { review_count: 2, rating_avg: 2.5 }, 'flagged not counted');
      const queue = await reviewQueue(sql, { kind: 'admin', id: f.admin });
      assert.equal(
        queue.rows.find((r) => r.id === flagged.phone).moderation_reason,
        'auto:private_information',
      );

      // Admin publishes a flagged review: moderated_by set, audited, counted.
      const input = {
        id: flagged.phone,
        version: 0,
        state: 'published',
        category: 'meets_policy',
        reason: 'Number belongs to the public front desk; allowed.',
      };
      const p = await moderateReview(sql, f.admin, { ...input, preview: true });
      await moderateReview(sql, f.admin, { ...input, previewToken: p.preview.token });
      const [mod] =
        await sql`SELECT moderated_by,moderation_state FROM review WHERE id=${flagged.phone}`;
      assert.deepEqual(mod, { moderated_by: f.admin, moderation_state: 'published' });
      assert.ok((await audits(flagged.phone)).includes('review_moderated'));
      assert.equal((await totals()).review_count, 3);

      // Refusals insert nothing.
      const before = (await sql`SELECT count(*)::int n FROM review`)[0].n;
      for (const state of ['confirmed', 'cancelled', 'no_show'])
        await assert.rejects(
          submitReview(sql, s, {
            visitId: await visit(state),
            rating: 5,
            body: 'Lovely lawn and a helpful caretaker.',
          }),
          { code: 'NOT_ELIGIBLE' },
        );
      await assert.rejects(
        submitReview(sql, s, {
          visitId: await visit('completed', 31),
          rating: 5,
          body: 'Lovely lawn and a helpful caretaker.',
        }),
        { code: 'NOT_ELIGIBLE' },
      );
      const [other] =
        await sql`INSERT INTO "user"(email,phone,role,account_status,name) VALUES ('other-guest@fixture.invalid','9000000078','customer','active','Other') RETURNING id`;
      const [os] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${other.id},now()+interval '1 day') RETURNING id`;
      await assert.rejects(
        submitReview(
          sql,
          { role: 'customer', userId: other.id, sessionId: os.id },
          { visitId: await visit(), rating: 5, body: 'Lovely lawn and a helpful caretaker.' },
        ),
        { code: 'NOT_ELIGIBLE' },
      );
      assert.equal((await sql`SELECT count(*)::int n FROM review`)[0].n, before);

      // Published review stays public and counted 40 days after checkout; owner can still reply.
      await sql`UPDATE booking SET starts_at=now()-interval '42 days',ends_at=now()-interval '40 days',blocked_start_at=now()-interval '42 days',blocked_end_at=now()-interval '40 days' WHERE id=(SELECT booking_id FROM review WHERE id=${clean.id})`;
      await sql`UPDATE rentable SET review_count=review_count WHERE id=${f.listing}`;
      assert.ok((await sql`SELECT 1 FROM public_customer_review WHERE id=${clean.id}`).length);
      assert.equal((await totals()).review_count, 3);
      await sql`UPDATE review SET owner_reply='Thanks for staying!',version=version+1 WHERE id=${clean.id}`;

      // A published review leaves the view and the count when its stay stops being genuine.
      const cleanVisit = (await sql`SELECT booking_id FROM review WHERE id=${clean.id}`)[0]
        .booking_id;
      await sql`UPDATE booking SET visit_provenance='test' WHERE id=${cleanVisit}`;
      // Provenance changes do not fire the refresh trigger; recompute the cached totals.
      await sql`UPDATE rentable SET review_count=review_count WHERE id=${f.listing}`;
      assert.equal(
        (await sql`SELECT 1 FROM public_customer_review WHERE id=${clean.id}`).length,
        0,
      );
      assert.equal((await totals()).review_count, 2, 'non-real provenance drops out');
      await sql`UPDATE booking SET visit_provenance='real' WHERE id=${cleanVisit}`;
      await sql`UPDATE rentable SET review_count=review_count WHERE id=${f.listing}`;
      assert.equal((await totals()).review_count, 3);

      // Owner reply still works on an admin-published review after its moderator is deactivated.
      await sql`UPDATE admin_user SET is_active=false WHERE id=${f.admin}`;
      await sql`UPDATE review SET owner_reply='Thanks, see you again.',version=version+1 WHERE id=${flagged.phone}`;
      await sql`UPDATE admin_user SET is_active=true WHERE id=${f.admin}`;

      // Admin hides an auto-published review; republishing then needs a moderator.
      const hideInput = {
        id: r1.id,
        version: (await sql`SELECT version FROM review WHERE id=${r1.id}`)[0].version,
        state: 'hidden',
        category: 'spam',
        reason: 'Spot-check found this to be a duplicate posting.',
      };
      const hp = await moderateReview(sql, f.admin, { ...hideInput, preview: true });
      await moderateReview(sql, f.admin, { ...hideInput, previewToken: hp.preview.token });
      await assert.rejects(
        sql`UPDATE review SET moderation_state='published',published_at=now(),moderated_by=NULL,moderated_at=NULL,moderation_reason='auto:clean' WHERE id=${r1.id}`,
        /Active moderator required/,
      );
      const repub = {
        ...hideInput,
        version: hideInput.version + 1,
        state: 'published',
        category: 'meets_policy',
        reason: 'Second look: not a duplicate, restoring it.',
      };
      const rp = await moderateReview(sql, f.admin, { ...repub, preview: true });
      await moderateReview(sql, f.admin, { ...repub, previewToken: rp.preview.token });
      assert.equal(
        (await sql`SELECT moderated_by FROM review WHERE id=${r1.id}`)[0].moderated_by,
        f.admin,
      );
      assert.equal(
        (await reviewQueue(sql, { kind: 'admin', id: f.admin }, 1, null, 'auto_published')).rows
          .map((r) => r.id)
          .includes(clean.id),
        true,
      );

      // 30-day boundary: just inside day 30 may write; day 31 may not (above).
      const day30 = await submitReview(sql, s, {
        visitId: await visit('completed', '29 days 23 hours'),
        rating: 5,
        body: 'Lovely lawn and a helpful caretaker.',
      });
      assert.equal(day30.state, 'published');

      const before30 = (await totals()).review_count;
      const day30Visit = (await sql`SELECT booking_id FROM review WHERE id=${day30.id}`)[0]
        .booking_id;
      await sql`UPDATE booking SET state='disputed' WHERE id=${day30Visit}`;
      assert.equal(
        (await sql`SELECT 1 FROM public_customer_review WHERE id=${day30.id}`).length,
        0,
      );
      assert.equal((await totals()).review_count, before30 - 1, 'no longer completed drops out');

      // Guard: direct publish without a moderator and without the auto reason is refused.
      await assert.rejects(
        sql`UPDATE review SET moderation_state='published',published_at=now(),moderation_reason='manual' WHERE id=${flagged.url}`,
        /Active moderator required/,
      );
      await assert.rejects(
        sql`UPDATE review SET moderation_state='published',published_at=now(),moderation_reason='auto:clean' WHERE id=${flagged.url}`,
        /Active moderator required/,
        'auto:clean only on insert',
      );
    } finally {
      await db.drop();
    }
  },
);
