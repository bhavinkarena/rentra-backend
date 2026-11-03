import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';

test(
  'Story 5.2 review eligibility action: FormData in, refusals as state; payloads carry scope',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const sql = db.sql;
    try {
      globalThis.__rentraSql = sql;
      process.env.DATABASE_URL = db.url;
      process.env.SESSION_SECRET = 'review-eligibility-disposable-fixture-secret';
      process.env.NODE_ENV = 'test';
      const f = await seedReviewFixture(sql);
      const [u] =
        await sql`INSERT INTO "user"(email,phone,role,account_status,name) VALUES ('arrival-guest@fixture.invalid','9000000191','customer','active','Asha Guest') RETURNING id`;
      const [ses] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${u.id},now()+interval '1 day') RETURNING id`;
      const guest = { role: 'customer', userId: u.id, sessionId: ses.id };
      const visit = async () => {
        const [order] =
          await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash)
          VALUES (${`AA-${randomUUID()}`},${u.id},${f.listing},'confirmed','INR','Asia/Kolkata','v1','v1','{}','{}',100000,0,0,${randomUUID()},${'c'.repeat(64)}) RETURNING id`;
        const [b] =
          await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,state,visit_provenance)
          VALUES (${`R${randomUUID().slice(0, 12)}`},${f.listing},${u.id},${order.id},1,current_date - 2,'stay',2,now()-interval '3 days',now()-interval '1 day',now()-interval '3 days',now()-interval '1 day',true,'INR','Asia/Kolkata',100000,0,0,'cancelled','real') RETURNING id`;
        return { id: b.id, order: order.id };
      };
      const v = await visit(),
        stray = await visit();
      const key = randomUUID();
      const [c] =
        await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
        VALUES (${'SUP-' + key.slice(0, 12)},${u.id},${v.order},'stay_issue','Locked out',
        ${JSON.stringify({ stayIssue: { affected: [{ visitId: v.id }] } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',now(),false) RETURNING id`;

      const { runWithContext } = await import('../../src/runtime/context.js');
      const { createAdminSession } = await import('../../src/services/auth/admin.js');
      const { reviewEligibilityDecide } = await import('../../src/services/support/actions.js');
      const { submitReview } = await import('../../src/services/reviews/service.js');
      const { readSupportRequest } = await import('../../src/services/support/service.js');
      let token;
      await runWithContext(
        { req: { cookies: {} }, res: { cookie: (_n, value) => (token = value) } },
        () => createAdminSession(f.admin, true),
      );
      const call = (entries) => {
        const form = new FormData();
        for (const [k, val] of entries) form.append(k, val);
        return runWithContext(
          { req: { cookies: { rentra_admin: token } }, res: { cookie() {}, clearCookie() {} } },
          () => reviewEligibilityDecide(null, form),
        );
      };
      const reason = ['reason', 'Gate code never sent; guest waited outside.'];

      // NOT_AFFECTED comes back as state, not a throw.
      const refused = await call([
        ['id', c.id],
        ['bookingId', stray.id],
        ['decision', 'approved'],
        ['scope', 'arrival_access'],
        reason,
        ['requestKey', randomUUID()],
      ]);
      assert.deepEqual(
        { code: refused.code, status: refused.status, hasError: !!refused.error },
        { code: 'NOT_AFFECTED', status: 422, hasError: true },
      );
      // Deny with no scope field works.
      const denied = await call([
        ['id', c.id],
        ['bookingId', v.id],
        ['decision', 'denied'],
        reason,
        ['requestKey', randomUUID()],
      ]);
      assert.equal(denied.decision.decision, 'denied');
      const approved = await call([
        ['id', c.id],
        ['bookingId', v.id],
        ['decision', 'approved'],
        ['scope', 'arrival_early_stay'],
        reason,
        ['requestKey', randomUUID()],
      ]);
      assert.equal(approved.decision.scope, 'arrival_early_stay');

      // Guest payload carries orderId for the "Review your arrival" link.
      const mine = await readSupportRequest(sql, { kind: 'customer', session: guest }, c.id);
      assert.equal(mine.orderId, v.order);
      assert.equal(mine.reviewEligibility[0].decision.decision, 'approved');

      // Public listing payload: scope label only, no case material.
      const r = await submitReview(sql, guest, {
        visitId: v.id,
        rating: 3,
        body: 'Arrived fine but had to leave the next morning after the water failed.',
      });
      assert.equal(r.state, 'published');
      await sql`UPDATE rentable SET status='live' WHERE id=${f.listing}`;
      const { getListingByCode } = await import('../../src/services/db/queries.js');
      const listing = await getListingByCode('review01');
      if (listing) {
        const shown = listing.reviews.find((x) => x.id === r.id);
        assert.equal(shown.experienceScope, 'arrival_early_stay');
        const text = JSON.stringify(listing);
        assert.ok(!text.includes(c.id) && !text.includes('Gate code never sent'));
      } else assert.fail('fixture listing not public; listing payload unchecked');
    } finally {
      delete globalThis.__rentraSql;
      await db.drop();
    }
  },
);
