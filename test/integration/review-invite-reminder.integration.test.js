// Needs a superuser local PG: the fixture time-travels scheduled_at via session_replication_role=replica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { submitReview, decideReviewEligibility } from '../../src/services/reviews/service.js';
import {
  processNotification,
  queueReviewReminders,
} from '../../src/services/notifications/jobs.js';
import { notificationMessage } from '../../src/services/domain/notifications.js';
import { customerNotifications } from '../../src/services/notifications/records.js';

const account = 'AC' + 'a'.repeat(32);
const env = {
  CUSTOMER_NOTIFICATION_DELIVERY: 'twilio',
  TWILIO_ACCOUNT_SID: account,
  TWILIO_AUTH_TOKEN: 'fake',
  TWILIO_FROM_NUMBER: '+15005550006',
  NEXT_PUBLIC_SITE_URL: 'https://rentra.test',
  NODE_ENV: 'test',
};
// Fake Twilio: echoes the message back as delivered and records the body.
const sent = [];
const fetcher = async (_url, init) => {
  const f = Object.fromEntries(new URLSearchParams(init.body.toString()));
  sent.push(f.Body);
  const sid = 'SM' + randomUUID().replaceAll('-', '');
  return new Response(
    JSON.stringify({
      sid,
      account_sid: account,
      to: f.To,
      from: f.From,
      body: f.Body,
      status: 'delivered',
    }),
  );
};

test(
  'Story 5.3: review invitation and one day-7 reminder',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql);
      const admin = { kind: 'admin', id: f.admin };
      let n = 10;
      const guest = async () => {
        n++;
        const [u] =
          await sql`INSERT INTO "user"(email,phone,phone_verified_at,role,account_status,name) VALUES (${`g${n}-${randomUUID()}@fixture.invalid`},${`90000002${n}`},now(),'customer','active','Guest') RETURNING id`;
        const [s] =
          await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${u.id},now()+interval '1 day') RETURNING id`;
        return { role: 'customer', userId: u.id, sessionId: s.id };
      };
      // ends: SQL interval relative to now (negative = past).
      const visit = async (s, state, ends) => {
        const [order] =
          await sql`INSERT INTO booking_order(reference,customer_id,rentable_id,state,currency,time_zone,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,amount_deposit_minor,idempotency_key,request_hash,visit_provenance)
          VALUES (${`RI-${randomUUID()}`},${s.userId},${f.listing},'confirmed','INR','Asia/Kolkata','v1','v1','{}','{}',100000,0,0,${randomUUID()},${'c'.repeat(64)},'real') RETURNING id`;
        const [b] =
          await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor,state,visit_provenance)
          VALUES (${`R${randomUUID().slice(0, 12)}`},${f.listing},${s.userId},${order.id},1,(now()+${ends}::interval)::date - 1,'stay',2,now()+${ends}::interval-interval '2 days',now()+${ends}::interval,now()+${ends}::interval-interval '2 days',now()+${ends}::interval,true,'INR','Asia/Kolkata',100000,0,0,${state},'real') RETURNING id`;
        return { id: b.id, order: order.id };
      };
      const complete = async (v) => {
        let id;
        for (const [kind, next] of [
          ['handover', 'handed_over'],
          ['return', 'returned'],
          ['complete', 'completed'],
        ]) {
          id = randomUUID();
          await sql`INSERT INTO visit_evidence(id,booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,recorded_at,request_key,request_hash,visit_version)
            VALUES(${id},${v.id},${kind},'actual','owner',${f.owner},'',(SELECT starts_at FROM booking WHERE id=${v.id})+interval '1 minute',now(),${id},${'d'.repeat(64)},1)`;
          await sql`UPDATE booking SET state=${next} WHERE id=${v.id}`;
        }
        await sql`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${v.order},${'visit_' + id.replaceAll('-', '')},${JSON.stringify({ visitId: v.id, evidenceId: id, phase: 'complete', nature: 'actual' })}::text::jsonb)`;
      };
      const row = async (bookingId, template) =>
        (
          await sql`SELECT * FROM notification_outbox WHERE booking_id=${bookingId} AND template=${template}`
        )[0];
      // Time travel: scheduled_at is immutable, so bypass the guard trigger for the fixture only.
      const due = (id) =>
        sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role=replica`;
          await tx`UPDATE notification_outbox SET scheduled_at=now()-interval '1 minute',next_attempt_at=now() WHERE id=${id}`;
        });
      const send = async (id) => {
        await due(id);
        await processNotification(sql, id, { env, fetcher });
        return (await sql`SELECT * FROM notification_outbox WHERE id=${id}`)[0];
      };
      const body = 'Lovely stay, the farm was clean and the caretaker was very helpful.';

      // Checkout in the future: invitation at checkout + 3h.
      const g1 = await guest();
      const future = await visit(g1, 'confirmed', '1 hour');
      await complete(future);
      const [{ ok }] =
        await sql`SELECT n.scheduled_at = rentra_review_invite_at(b.ends_at + interval '3 hours') ok FROM notification_outbox n JOIN booking b ON b.id=n.booking_id WHERE n.booking_id=${future.id} AND n.template='review_invitation'`;
      assert.ok(ok, 'invitation at checkout + 3h');

      // Completion recorded long after checkout: scheduled now.
      const g2 = await guest();
      const v = await visit(g2, 'confirmed', '-1 day');
      await complete(v);
      const inv = await row(v.id, 'review_invitation');
      assert.ok(Math.abs(new Date(inv.scheduled_at) - Date.now()) < 60000, 'scheduled now');

      // Pending invitation: no reminder yet.
      await queueReviewReminders(sql);
      assert.equal(await row(v.id, 'review_reminder'), undefined);

      // Fake adapter delivers; read_at stays null; in-app shows it unread.
      const delivered = await send(inv.id);
      assert.equal(delivered.state, 'delivered', delivered.failure_code);
      assert.equal(delivered.read_at, null);
      assert.match(
        sent.at(-1),
        /How was your visit at Review River Farm\? Review it by .+: https:\/\/rentra\.test\/bookings\/.+\/reviews Update /,
      );
      let list = await customerNotifications(sql, g2, env);
      assert.equal(list.find((x) => x.id === inv.id).read, false);

      // Reminder: 10:00 IST on invitation's IST date + 7; idempotent.
      assert.equal((await queueReviewReminders(sql)) >= 1, true);
      assert.equal(await queueReviewReminders(sql), 0);
      const rem = await row(v.id, 'review_reminder');
      const [{ expect }] =
        await sql`SELECT ((((${delivered.scheduled_at}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date + 7)::timestamp + time '10:00') AT TIME ZONE 'Asia/Kolkata') = ${rem.scheduled_at}::timestamptz expect`;
      assert.ok(expect);
      assert.equal(rem.event_key, `review-reminder:${v.id}`);

      // Guest reviews: reminder suppressed REVIEW_SUBMITTED; invite hidden in-app.
      await submitReview(sql, g2, { visitId: v.id, rating: 5, body });
      const r2 = await send(rem.id);
      assert.deepEqual([r2.state, r2.failure_code], ['suppressed', 'REVIEW_SUBMITTED']);
      list = await customerNotifications(sql, g2, env);
      assert.equal(
        list.some((x) => x.id === inv.id),
        false,
      );

      // Reminder past window end: no row.
      const g3 = await guest();
      const late = await visit(g3, 'confirmed', '-29 days');
      await complete(late);
      await send((await row(late.id, 'review_invitation')).id);
      await queueReviewReminders(sql);
      assert.equal(await row(late.id, 'review_reminder'), undefined);

      // Quiet hours, deterministic (future dates so "never before now" does not apply).
      const at = async (local) =>
        (
          await sql`SELECT to_char(rentra_review_invite_at((${local}::text::timestamp AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') v`
        )[0].v;
      assert.equal(await at('2099-01-10 08:59'), '2099-01-10 09:00');
      assert.equal(await at('2099-01-10 09:00'), '2099-01-10 09:00');
      assert.equal(await at('2099-01-10 20:59'), '2099-01-10 20:59');
      assert.equal(await at('2099-01-10 21:00'), '2099-01-11 09:00');
      assert.equal(await at('2099-01-10 23:30'), '2099-01-11 09:00');

      // A delivered reminder carries the reminder copy.
      const g7 = await guest();
      const rv = await visit(g7, 'confirmed', '-1 day');
      await complete(rv);
      await send((await row(rv.id, 'review_invitation')).id);
      await queueReviewReminders(sql);
      const rr = await send((await row(rv.id, 'review_reminder')).id);
      assert.equal(rr.state, 'delivered');
      assert.match(
        sent.at(-1),
        /Reminder: you can review Review River Farm until .+: https:\/\/rentra\.test\/bookings\/.+\/reviews Update /,
      );

      // Late delivery anchors the reminder; a past-due reminder is skipped; undelivered gets none.
      const anchored = async (shift, state = 'delivered') => {
        const g = await guest();
        const x = await visit(g, 'confirmed', '-1 day');
        await complete(x);
        const i = await row(x.id, 'review_invitation');
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role=replica`;
          await tx`UPDATE notification_outbox SET state=${state},delivered_at=now()+${shift}::interval,scheduled_at=now()-interval '20 days' WHERE id=${i.id}`;
        });
        await queueReviewReminders(sql);
        return { x, r: await row(x.id, 'review_reminder') };
      };
      const lateDel = await anchored('0 minutes');
      const [{ okDue }] =
        await sql`SELECT ${lateDel.r.scheduled_at}::timestamptz = ((((now() AT TIME ZONE 'Asia/Kolkata')::date + 7)::timestamp + time '10:00') AT TIME ZONE 'Asia/Kolkata') "okDue"`;
      assert.ok(okDue, 'anchored to delivery');
      assert.equal((await anchored('-8 days')).r, undefined);
      assert.equal((await anchored('0 minutes', 'undelivered')).r, undefined);

      // Copy without a site URL or window end.
      const plain = notificationMessage({
        template: 'review_reminder',
        id: 'u1',
        visit_provenance: 'real',
        review: { listing: 'Farm', windowEnd: null, link: null },
      });
      assert.equal(
        plain,
        'Rentra: Reminder: you can review Farm. Open your Rentra booking to review. Update u1.',
      );

      // Failed / suppressed invitations: no reminder.
      const g4 = await guest();
      const failed = await visit(g4, 'confirmed', '-1 day');
      await complete(failed);
      await sql`UPDATE notification_outbox SET state='failed' WHERE booking_id=${failed.id}`;
      await queueReviewReminders(sql);
      assert.equal(await row(failed.id, 'review_reminder'), undefined);

      // SMS not configured: blocked, still visible in-app.
      const g5 = await guest();
      const blocked = await visit(g5, 'confirmed', '-1 day');
      await complete(blocked);
      const bi = await row(blocked.id, 'review_invitation');
      await due(bi.id);
      await processNotification(sql, bi.id, { env: { NODE_ENV: 'test' }, fetcher });
      const b2 = (
        await sql`SELECT state,failure_code FROM notification_outbox WHERE id=${bi.id}`
      )[0];
      assert.deepEqual(b2, { state: 'blocked', failure_code: 'SMS_NOT_CONFIGURED' });
      assert.ok((await customerNotifications(sql, g5, env)).some((x) => x.id === bi.id));

      // Arrival exception: invitation on approval within 09:00-21:00 IST else next 09:00 IST.
      const g6 = await guest();
      const cv = await visit(g6, 'cancelled', '-1 day');
      const key = randomUUID();
      const [c] =
        await sql`INSERT INTO support_request(reference,customer_id,order_id,category,subject,context,policy_version,request_key,request_hash,priority,discovered_at,late)
        VALUES (${'SUP-' + key.slice(0, 12)},${g6.userId},${cv.order},'stay_issue','Locked out',${JSON.stringify({ stayIssue: { affected: [{ visitId: cv.id }] } })}::text::jsonb,'v1',${key},${'a'.repeat(64)},'normal',now(),false) RETURNING id`;
      const decide = (decision) =>
        decideReviewEligibility(sql, admin, {
          supportRequestId: c.id,
          bookingId: cv.id,
          decision,
          scope: decision === 'approved' ? 'arrival_access' : undefined,
          reason: 'Gate code never sent; guest waited outside.',
          requestKey: randomUUID(),
        });
      await decide('approved');
      // A later cancel event on the order keeps the exception invitation.
      await sql`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${cv.order},'cancel_guest','{}'::jsonb)`;
      assert.equal((await row(cv.id, 'review_invitation')).state, 'pending');
      const ei = await row(cv.id, 'review_invitation');
      const [{ h: hour, iso }] =
        await sql`SELECT extract(hour FROM ${ei.created_at}::timestamptz AT TIME ZONE 'Asia/Kolkata')::int h,
          to_char(${ei.scheduled_at}::timestamptz AT TIME ZONE 'Asia/Kolkata','HH24:MI') iso`;
      if (hour >= 9 && hour < 21)
        assert.ok(Math.abs(new Date(ei.scheduled_at) - new Date(ei.created_at)) < 5000);
      else assert.equal(iso, '09:00');
      // Second approval: still one invitation.
      await decide('approved');
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM notification_outbox WHERE booking_id=${cv.id} AND template='review_invitation'`
        )[0].n,
        1,
      );
      const sentArrival = await send(ei.id);
      assert.equal(sentArrival.state, 'delivered');
      assert.match(sent.at(-1), /How was your arrival at Review River Farm\?/);
      assert.ok(!sent.at(-1).includes('Gate code'));
      await queueReviewReminders(sql);
      const er = await row(cv.id, 'review_reminder');
      assert.ok(er, 'exception gets a reminder within its window');
      // Revoked before reminder send: REVIEW_INELIGIBLE.
      await decide('denied');
      const er2 = await send(er.id);
      assert.deepEqual([er2.state, er2.failure_code], ['suppressed', 'REVIEW_INELIGIBLE']);
    } finally {
      await db.drop();
    }
  },
);
