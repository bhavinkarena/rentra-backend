import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { listBookingRecords, readBookingRecord } from '../../src/services/booking/records.js';
import { requestOwnerContactChange } from '../../src/services/auth/owner-security.js';
import { issuePortalSession } from '../../src/services/auth/portal-sessions.js';

/** Phase 14 (§14.2) edge cases that had code but no direct regression test. */
const options = { skip: !process.env.PORTAL_TEST_DATABASE_URL };

test('owner booking search by phone; guest contact masked 7 days after completion', options, async () => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const sql = fixture.sql;
  try {
    const f = await seedReviewFixture(sql);
    const booked = await seedConfirmedBooking(sql, f.listing);
    const owner = { kind: 'owner', id: f.owner };
    await sql`UPDATE booking_order SET listing_snapshot=listing_snapshot||'{"contact":{"name":"Riya Patel","phone":"9876543210"}}'::jsonb WHERE id=${booked.order}`;
    const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booked.order}`;

    // Search by part of the phone number finds the order; another number does not.
    const ids = async (q) =>
      (await listBookingRecords(sql, owner, { tab: 'all', q })).items.map((i) => i.id);
    assert.ok((await ids('98765')).includes(booked.order));
    assert.ok(!(await ids('91111')).includes(booked.order));

    // Completed with proof `daysAgo` days ago; triggers off for test-only time travel.
    const completedAgo = (days) =>
      sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role=replica`;
        await tx`DELETE FROM visit_evidence WHERE booking_id=${visit.id} AND kind='complete'`;
        await tx`INSERT INTO visit_evidence(booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,request_key,request_hash)
          VALUES(${visit.id},'complete','simulation','owner',${f.owner},'',now()-make_interval(days=>${days}),${randomUUID()},${'0'.repeat(64)})`;
        await tx`UPDATE booking SET state='completed' WHERE id=${visit.id}`;
      });
    const phone = async () => ({
      card: (await listBookingRecords(sql, owner, { tab: 'all' })).items.find((i) => i.id === booked.order)
        ?.contact.phone,
      detail: (await readBookingRecord(sql, owner, booked.order)).contact.phone,
    });

    await completedAgo(3);
    assert.deepEqual(await phone(), { card: '9876543210', detail: '9876543210' });
    await completedAgo(8);
    assert.deepEqual(await phone(), { card: null, detail: null });
  } finally {
    await fixture.drop();
  }
});

test('changing to a phone number another owner uses is refused before any code is sent', options, async () => {
  const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
  const sql = fixture.sql;
  try {
    const f = await seedReviewFixture(sql);
    const [other] = await sql`SELECT id FROM "user" WHERE role='client' AND id<>${f.owner} LIMIT 1`;
    const otherId =
      other?.id ??
      (await sql`INSERT INTO "user"(role,phone,name,account_status) VALUES('client','9822222222','Other owner','active') RETURNING id`)[0].id;
    await sql`UPDATE "user" SET phone='9822222222' WHERE id=${otherId}`;
    const sessionId = await issuePortalSession(sql, 'client', f.owner, 3600);
    let sent = false;
    await assert.rejects(
      requestOwnerContactChange(
        sql,
        { id: f.owner, sessionId },
        { channel: 'sms', identifier: '+91 98222 22222' },
        { ...process.env, NODE_ENV: 'test', SESSION_SECRET: 'edge-case-secret' },
        async () => {
          sent = true;
        },
      ),
      { code: 'CONTACT_IN_USE' },
    );
    assert.equal(sent, false);
    const [{ n }] = await sql`SELECT count(*)::int n FROM otp_challenge WHERE user_id=${f.owner}`;
    assert.equal(n, 0);
  } finally {
    await fixture.drop();
  }
});
