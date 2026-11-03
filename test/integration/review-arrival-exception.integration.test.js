import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import {
  submitReview,
  reviewOrder,
  decideReviewEligibility,
  moderateReview,
  reviewQueue,
  reviewDetail,
} from '../../src/services/reviews/service.js';
import { readSupportRequest } from '../../src/services/support/service.js';

test(
  'Story 5.2: arrival review exceptions are admin-decided, scoped and revocable',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql);
      const admin = { kind: 'admin', id: f.admin };
      const guest = async (n) => {
        const [u] =
          await sql`INSERT INTO "user"(email,phone,role,account_status,name) VALUES (${`g${n}-${randomUUID()}@fixture.invalid`},${`90000001${n}`},'customer','active','Guest') RETURNING id`;
        const [s] =
          await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${u.id},now()+interval '1 day') RETURNING id`;
        return { role: 'customer', userId: u.id, sessionId: s.id };
      };
      const g = await guest(10),
        other = await guest(11);
      const visit = async (state, s = g, endedDaysAgo = 1) => {
        const [order] =
          await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash)
          VALUES (${`AX-${randomUUID()}`},${s.userId},${f.listing},'confirmed','INR','Asia/Kolkata','v1','v1','{}','{}',100000,0,0,${randomUUID()},${'c'.repeat(64)}) RETURNING id`;
        const ends = `${endedDaysAgo} days`;
        const [b] =
          await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,state,visit_provenance)
          VALUES (${`R${randomUUID().slice(0, 12)}`},${f.listing},${s.userId},${order.id},1,(now()-${ends}::interval)::date - 1,'stay',2,now()-${ends}::interval-interval '2 days',now()-${ends}::interval,now()-${ends}::interval-interval '2 days',now()-${ends}::interval,true,'INR','Asia/Kolkata',100000,0,0,${state},'real') RETURNING id`;
        return { id: b.id, order: order.id };
      };
      const stayCase = async (v, s = g, affected = [v.id], discovered = 'now') => {
        const key = randomUUID();
        const [c] =
          await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
          VALUES (${'SUP-' + key.slice(0, 12)},${s.userId},${v.order},'stay_issue','Locked out',
          ${JSON.stringify({ stayIssue: { affected: affected.map((visitId) => ({ visitId })) } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',${discovered === 'now' ? new Date().toISOString() : null},false) RETURNING id`;
        return c.id;
      };
      const decide = (caseId, bookingId, extra = {}) =>
        decideReviewEligibility(sql, admin, {
          supportRequestId: caseId,
          bookingId,
          decision: 'approved',
          scope: 'arrival_access',
          reason: 'Gate code never sent; guest waited outside.',
          requestKey: randomUUID(),
          ...extra,
        });
      const body = 'Arrived on time but the gate stayed locked and nobody answered.';
      const totals = async () =>
        (await sql`SELECT review_count,rating_avg FROM rentable WHERE id=${f.listing}`)[0];

      // No-show, no exception: refused as before.
      const ns = await visit('no_show');
      await assert.rejects(submitReview(sql, g, { visitId: ns.id, rating: 2, body }), {
        code: 'NOT_ELIGIBLE',
      });

      // Approve on a cancelled affected visit; reviews page offers the arrival review.
      const cv = await visit('cancelled');
      const caseId = await stayCase(cv);
      const key = randomUUID();
      const d1 = await decide(caseId, cv.id, { requestKey: key });
      assert.equal(d1.scope, 'arrival_access');
      const [{ w }] =
        await sql`SELECT (window_ends_at - (SELECT greatest(b.ends_at,s.discovered_at) FROM booking b, support_request s WHERE b.id=${cv.id} AND s.id=${caseId})) = interval '30 days' w FROM review_eligibility_exception WHERE id=${d1.id}`;
      assert.ok(w, 'window = later of ends_at/discovered_at + 30 days');
      const page = await reviewOrder(sql, g, cv.order);
      assert.equal(page.visits[0].eligible, true);
      assert.equal(page.visits[0].experience_scope, 'arrival_access');

      // Replay returns the original; same key different payload 409.
      assert.equal((await decide(caseId, cv.id, { requestKey: key })).id, d1.id);
      await assert.rejects(
        decide(caseId, cv.id, { requestKey: key, scope: 'arrival_early_stay' }),
        {
          code: 'REQUEST_REUSED',
        },
      );
      const audits =
        await sql`SELECT action FROM audit_log WHERE entity='support_request' AND entity_id=${caseId} AND action='review_eligibility_decided'`;
      assert.equal(audits.length, 1);

      // Sub-scores refused; stars+text publish with the scope and count.
      await assert.rejects(
        submitReview(sql, g, { visitId: cv.id, rating: 2, body, cleanliness: 3 }),
        { code: 'SCOPED_REVIEW', statusCode: 422 },
      );
      const r = await submitReview(sql, g, { visitId: cv.id, rating: 2, body });
      assert.equal(r.state, 'published');
      const [row] = await sql`SELECT experience_scope,cleanliness FROM review WHERE id=${r.id}`;
      assert.deepEqual(row, { experience_scope: 'arrival_access', cleanliness: null });
      assert.deepEqual(await totals(), { review_count: 1, rating_avg: 2 });
      // Guard: scope must match; immutable afterwards.
      await assert.rejects(
        sql`UPDATE review SET experience_scope='arrival_early_stay' WHERE id=${r.id}`,
        /immutable/,
      );
      // Already reviewed: approve refused.
      await assert.rejects(decide(caseId, cv.id), { code: 'ALREADY_ELIGIBLE' });

      // Guest sees decision; public review payload carries no case material.
      const guestView = await readSupportRequest(sql, { kind: 'customer', session: g }, caseId);
      assert.equal(guestView.reviewEligibility[0].decision.decision, 'approved');
      const [pub] = await sql`SELECT * FROM public_customer_review WHERE id=${r.id}`;
      assert.equal(pub.experience_scope, 'arrival_access');
      assert.ok(!JSON.stringify(pub).includes(caseId));
      const adminView = await readSupportRequest(sql, admin, caseId);
      assert.equal(adminView.reviewEligibility[0].reviewPublic, true);

      // Denial revokes: review leaves public view and the count, not deleted.
      const den = await decide(caseId, cv.id, {
        decision: 'denied',
        scope: undefined,
        reason: 'Host logs show guest entered and stayed.',
      });
      assert.equal(den.decision, 'denied');
      assert.equal((await sql`SELECT 1 FROM public_customer_review WHERE id=${r.id}`).length, 0);
      assert.equal((await sql`SELECT 1 FROM review WHERE id=${r.id}`).length, 1);
      assert.deepEqual(await totals(), { review_count: 0, rating_avg: null });
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM review_eligibility_exception WHERE booking_id=${cv.id} AND revoked_at IS NULL`
        )[0].n,
        1,
      );
      assert.equal(
        (await readSupportRequest(sql, admin, caseId)).reviewEligibility[0].reviewPublic,
        false,
      );
      const g2 = await readSupportRequest(sql, { kind: 'customer', session: g }, caseId);
      assert.equal(
        g2.reviewEligibility[0].decision.reason,
        'Host logs show guest entered and stayed.',
      );

      // Denied without a review: not eligible.
      const dv = await visit('cancelled');
      const dCase = await stayCase(dv);
      await decide(dCase, dv.id, { decision: 'denied', scope: undefined });
      await assert.rejects(submitReview(sql, g, { visitId: dv.id, rating: 3, body }), {
        code: 'NOT_ELIGIBLE',
      });

      // Not in the case's affected list: 422; other customer's booking: 404.
      const extra = await visit('cancelled');
      await assert.rejects(decide(dCase, extra.id), { code: 'NOT_AFFECTED', statusCode: 422 });
      const ov = await visit('cancelled', other);
      await assert.rejects(decide(dCase, ov.id), { code: 'NOT_FOUND', statusCode: 404 });

      // Normally eligible: 409.
      const okv = await visit('completed');
      await assert.rejects(decide(await stayCase(okv), okv.id), { code: 'ALREADY_ELIGIBLE' });

      // After window_ends_at: submit refused.
      const ev = await visit('cancelled');
      const eCase = await stayCase(ev);
      const ex = await decide(eCase, ev.id, { scope: 'arrival_early_stay' });
      await sql`ALTER TABLE review_eligibility_exception DISABLE TRIGGER review_eligibility_exception_immutable`;
      await sql`UPDATE review_eligibility_exception SET window_ends_at=now()-interval '1 minute' WHERE id=${ex.id}`;
      await sql`ALTER TABLE review_eligibility_exception ENABLE TRIGGER review_eligibility_exception_immutable`;
      await assert.rejects(submitReview(sql, g, { visitId: ev.id, rating: 3, body }), {
        code: 'NOT_ELIGIBLE',
      });

      // Append-only: no delete, no edit except revoke.
      await assert.rejects(sql`DELETE FROM review_eligibility_exception WHERE id=${ex.id}`);
      await assert.rejects(
        sql`UPDATE review_eligibility_exception SET reason='changed reason here' WHERE id=${ex.id}`,
      );

      // Admin without support.write: 404/403; read-only still sees the panel data.
      const [ro] =
        await sql`INSERT INTO admin_user(email,name,password_hash,permissions) VALUES (${randomUUID() + '@fixture.invalid'},'RO','x','["admin.support.read"]'::jsonb) RETURNING id`;
      await assert.rejects(
        decideReviewEligibility(
          sql,
          { kind: 'admin', id: ro.id },
          {
            supportRequestId: eCase,
            bookingId: ev.id,
            decision: 'denied',
            reason: 'Read-only should not decide.',
            requestKey: randomUUID(),
          },
        ),
        { statusCode: 404 },
      );
      // Flagged scoped text waits like 5.1.
      const fv = await visit('no_show');
      await decide(await stayCase(fv), fv.id);
      const flagged = await submitReview(sql, g, {
        visitId: fv.id,
        rating: 1,
        body: 'Gate locked; call the caretaker on 98765 43210 instead.',
      });
      assert.equal(flagged.state, 'pending');
      // Flagged scoped review published by a moderator after window_ends_at: genuine is enough.
      const [fx] =
        await sql`SELECT id FROM review_eligibility_exception WHERE booking_id=${fv.id} AND revoked_at IS NULL`;
      await sql`ALTER TABLE review_eligibility_exception DISABLE TRIGGER review_eligibility_exception_immutable`;
      await sql`UPDATE review_eligibility_exception SET window_ends_at=now()-interval '1 minute' WHERE id=${fx.id}`;
      await sql`ALTER TABLE review_eligibility_exception ENABLE TRIGGER review_eligibility_exception_immutable`;
      const pubIn = {
        id: flagged.id,
        version: 0,
        state: 'published',
        category: 'meets_policy',
        reason: 'Number is the public front desk line.',
      };
      const pp = await moderateReview(sql, f.admin, { ...pubIn, preview: true });
      await moderateReview(sql, f.admin, { ...pubIn, previewToken: pp.preview.token });
      assert.ok((await sql`SELECT 1 FROM public_customer_review WHERE id=${flagged.id}`).length);
      // Owner/admin read models carry the scope.
      const q = await reviewQueue(sql, admin);
      assert.equal(q.rows.find((x) => x.id === flagged.id).experience_scope, 'arrival_access');
      assert.equal((await reviewDetail(sql, admin, flagged.id)).experienceScope, 'arrival_access');

      // Un-revoke refused.
      const [revoked] =
        await sql`SELECT id FROM review_eligibility_exception WHERE revoked_at IS NOT NULL LIMIT 1`;
      await assert.rejects(
        sql`UPDATE review_eligibility_exception SET revoked_at=NULL WHERE id=${revoked.id}`,
        /revoked once/,
      );

      // Completed visit past its window: still refused (normal review path only).
      const late = await visit('completed', g, 40);
      await assert.rejects(decide(await stayCase(late), late.id), {
        code: 'ALREADY_ELIGIBLE',
        message: 'Completed stays use the normal review.',
      });

      // Guard: NULL scope on an exception-only visit, and a scope on a completed visit, both refused.
      const raw = (bid, scope) =>
        sql`INSERT INTO review(booking_id,rentable_id,author_id,author_role,rating,body,experience_scope,moderation_state)
          VALUES(${bid},${f.listing},${g.userId},'customer',3,${body},${scope},'pending')`;
      const xv = await visit('cancelled');
      await decide(await stayCase(xv), xv.id);
      await assert.rejects(raw(xv.id, null), /Review scope must match/);
      const cmp = await visit('completed');
      await assert.rejects(raw(cmp.id, 'arrival_access'), /Review scope must match/);

      // Another admin replaying a key: REQUEST_REUSED. Concurrent same key: one decision, no 500.
      const [a2] =
        await sql`INSERT INTO admin_user(email,name,password_hash) VALUES (${randomUUID() + '@fixture.invalid'},'A2','x') RETURNING id`;
      const cc = await visit('cancelled');
      const ccCase = await stayCase(cc);
      const k = randomUUID();
      const both = await Promise.all([
        decide(ccCase, cc.id, { requestKey: k }),
        decide(ccCase, cc.id, { requestKey: k }),
      ]);
      assert.equal(both[0].id, both[1].id);
      await assert.rejects(
        decideReviewEligibility(
          sql,
          { kind: 'admin', id: a2.id },
          {
            supportRequestId: ccCase,
            bookingId: cc.id,
            decision: 'approved',
            scope: 'arrival_access',
            reason: 'Gate code never sent; guest waited outside.',
            requestKey: k,
          },
        ),
        { code: 'REQUEST_REUSED' },
      );
      // Concurrent different keys on the same visit serialize: both succeed, one stays active.
      await Promise.all([
        decide(ccCase, cc.id),
        decide(ccCase, cc.id, { decision: 'denied', scope: undefined }),
      ]);
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM review_eligibility_exception WHERE booking_id=${cc.id} AND revoked_at IS NULL`
        )[0].n,
        1,
      );

      // Active decision from another case is shown and flagged.
      const otherCase = await stayCase(cc);
      const ov2 = (await readSupportRequest(sql, admin, otherCase)).reviewEligibility[0];
      assert.equal(ov2.fromOtherCase, true);
      assert.ok(ov2.caseReference.startsWith('SUP-'));
      assert.ok(ov2.decision);

      // support_request_valid_chk requires discovered_at on stay issues, so the window is never NULL.
      await assert.rejects(
        stayCase(await visit('cancelled'), g, undefined, null),
        /support_request_valid_chk/,
      );

      // Case and booking state untouched by decisions.
      assert.equal((await sql`SELECT state FROM booking WHERE id=${cv.id}`)[0].state, 'cancelled');
    } finally {
      await db.drop();
    }
  },
);
