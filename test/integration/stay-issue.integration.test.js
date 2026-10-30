import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import { createSupportRequest, readSupportRequest } from '../../src/services/support/service.js';
import { memoryEvidenceStore } from '../../src/services/uploads/evidence-store.js';

const png = () =>
  new File(
    [Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, 7)])],
    'photo.png',
    {
      type: 'image/png',
    },
  );

test(
  'Story 4.1 stay issue intake: matrix rows',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      // A stay that began two days ago with one hotel room line in its snapshot.
      await sql`UPDATE booking SET starts_at=now()-interval '4 days',ends_at=now()+interval '1 day',local_day=(now()-interval '4 days')::date,
      slot_snapshot='{"rooms":[{"roomTypeId":"rt-1","name":"Deluxe"}]}' WHERE order_id=${booking.order}`;
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booking.order}`;
      const [session] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`;
      const customer = {
        kind: 'customer',
        session: { role: 'customer', userId: booking.customer, sessionId: session.id },
      };
      const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
      const input = (issue = {}, extra = {}) => ({
        category: 'stay_issue',
        body: 'The bathroom was dirty on arrival.',
        orderId: booking.order,
        privacyRequestId: null,
        requestKey: randomUUID(),
        stayIssue: {
          issueType: 'cleanliness',
          discoveredAt: hoursAgo(2),
          affected: [{ visitId: visit.id, roomTypeId: 'rt-1' }],
          remedy: 'fix_during_stay',
          ...issue,
        },
        ...extra,
      });
      const snapshot = async () => [
        await sql`SELECT state,amount_rent_minor,amount_fee_minor FROM booking_order WHERE id=${booking.order}`,
        await sql`SELECT state,starts_at,ends_at,cancelled_at FROM booking WHERE order_id=${booking.order}`,
        (await sql`SELECT to_regclass('refund') r`)[0].r
          ? await sql`SELECT count(*)::int n FROM refund`
          : null,
      ];
      const before = await snapshot();

      // Happy: hotel room line, no photo, normal priority, durable reference, audit.
      const happyInput = input();
      const happy = await createSupportRequest(sql, customer, happyInput);
      const [row] = await sql`SELECT * FROM support_request WHERE id=${happy.id}`;
      assert.match(row.reference, /^SUP-/);
      assert.deepEqual(
        [row.category, row.priority, row.late, row.context.stayIssue.affected[0].roomName],
        ['stay_issue', 'normal', false, 'Deluxe'],
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM audit_log WHERE entity_id=${happy.id} AND action='stay_issue_reported'`
        )[0].n,
        1,
      );

      // One photo is stored as evidence on the opening message.
      const withPhoto = await createSupportRequest(
        sql,
        customer,
        input(),
        process.env,
        [png()],
        memoryEvidenceStore(),
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM support_attachment a JOIN support_message m ON m.id=a.message_id WHERE m.request_id=${withPhoto.id}`
        )[0].n,
        1,
      );

      // An owner cannot file a stay issue.
      await assert.rejects(createSupportRequest(sql, { kind: 'owner', id: f.owner }, input()), {
        code: 'INVALID_TOPIC',
      });

      // Access: urgent.
      const access = await createSupportRequest(
        sql,
        customer,
        input({ issueType: 'access', affected: [{ visitId: visit.id, roomTypeId: null }] }),
      );
      assert.equal(
        (await sql`SELECT priority FROM support_request WHERE id=${access.id}`)[0].priority,
        'urgent',
      );

      // Late with reason accepted; without reason refused.
      const late = await createSupportRequest(
        sql,
        customer,
        input({ discoveredAt: hoursAgo(80), lateReason: 'No signal at the farm until today.' }),
      );
      assert.equal((await sql`SELECT late FROM support_request WHERE id=${late.id}`)[0].late, true);
      await assert.rejects(
        createSupportRequest(sql, customer, input({ discoveredAt: hoursAgo(80) })),
        { code: 'LATE_REASON_REQUIRED', statusCode: 422 },
      );

      // Foreign visit, unknown room, future discovery.
      await assert.rejects(
        createSupportRequest(
          sql,
          customer,
          input({ affected: [{ visitId: randomUUID(), roomTypeId: null }] }),
        ),
        { code: 'AFFECTED_INVALID' },
      );
      await assert.rejects(
        createSupportRequest(
          sql,
          customer,
          input({ affected: [{ visitId: visit.id, roomTypeId: 'rt-x' }] }),
        ),
        { code: 'AFFECTED_INVALID' },
      );
      await assert.rejects(
        createSupportRequest(
          sql,
          customer,
          input({ discoveredAt: new Date(Date.now() + 3_600_000).toISOString() }),
        ),
        { code: 'DISCOVERY_INVALID', statusCode: 422 },
      );

      // Remedy "other" needs text.
      await assert.rejects(createSupportRequest(sql, customer, input({ remedy: 'other' })), {
        name: 'ZodError',
      });

      // Replay: same key + payload returns original; changed payload conflicts.
      assert.deepEqual(await createSupportRequest(sql, customer, happyInput), happy);
      await assert.rejects(
        createSupportRequest(sql, customer, {
          ...happyInput,
          body: 'A different description of it.',
        }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM support_request WHERE request_key=${happyInput.requestKey}`
        )[0].n,
        1,
      );

      // Another customer: 404 for filing and reading.
      const [other] =
        await sql`INSERT INTO "user"(email,phone,role,account_status,name,profile_completed_at,profile_version,consent_updated_at) VALUES ('other-guest@fixture.invalid','9000000078','customer','active','Other',now(),1,now()) RETURNING id`;
      const [otherSession] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${other.id},now()+interval '1 day') RETURNING id`;
      const stranger = {
        kind: 'customer',
        session: { role: 'customer', userId: other.id, sessionId: otherSession.id },
      };
      await assert.rejects(createSupportRequest(sql, stranger, input()), { statusCode: 404 });
      await assert.rejects(readSupportRequest(sql, stranger, happy.id), { statusCode: 404 });
      // The owner never sees a guest's case.
      await assert.rejects(readSupportRequest(sql, { kind: 'owner', id: f.owner }, happy.id), {
        statusCode: 404,
      });
      const mine = await readSupportRequest(sql, customer, happy.id);
      assert.equal(mine.priority, undefined);

      // Filing changed no order, booking or money.
      assert.deepEqual(await snapshot(), before);

      // Window closed: >30 days after checkout, and cancelled before arrival.
      await sql`UPDATE booking SET starts_at=now()-interval '40 days',ends_at=now()-interval '35 days' WHERE order_id=${booking.order}`;
      await assert.rejects(
        createSupportRequest(
          sql,
          customer,
          input({
            discoveredAt: hoursAgo(35 * 24),
            lateReason: 'Reporting much later than planned.',
          }),
        ),
        { code: 'ISSUE_WINDOW_CLOSED', statusCode: 409 },
      );
      // Time-based rules do not apply to a replay: the stored request returns even after the window closed.
      assert.deepEqual(await createSupportRequest(sql, customer, happyInput), happy);
      await sql`UPDATE booking SET starts_at=now()+interval '3 days',ends_at=now()+interval '4 days',state='cancelled',cancelled_at=now(),cancelled_by_kind='customer' WHERE order_id=${booking.order}`;
      await sql`UPDATE booking_order SET state='cancelled' WHERE id=${booking.order}`;
      await assert.rejects(createSupportRequest(sql, customer, input()), {
        code: 'ISSUE_WINDOW_CLOSED',
        statusCode: 409,
      });
    } finally {
      await db.drop();
    }
  },
);
