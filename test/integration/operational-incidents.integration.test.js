import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { readIncident, commandIncident } from '../../src/services/operations/incidents.js';
import {
  notificationDetail,
  retryNotification,
  reconcileUnknownNotification,
} from '../../src/services/notifications/records.js';
import { bodyHash } from '../../src/services/notifications/delivery.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';

const server = process.env.CP01_TEST_DATABASE_URL;
test(
  'CP29 incident evidence, stale heartbeat, versioning and duplicate commands',
  { skip: !server },
  async () => {
    const db = await createDisposableDatabase(server);
    try {
      const actor = randomUUID();
      const colleague = randomUUID();
      await db.sql`INSERT INTO admin_user(id,email,password_hash,name) VALUES
      (${actor},'cp29-operator@example.test','fixture','CP29 Operator'),
      (${colleague},'cp29-colleague@example.test','fixture','CP29 Colleague')`;
      const code = 'payments_worker_unhealthy';
      const first = await readIncident(db.sql, actor, code);
      assert.equal(first.count, 1);
      assert.equal(first.health, null);
      assert.equal(first.incident, null);
      const key = randomUUID();
      const open = {
        code,
        action: 'open',
        note: 'Missing worker heartbeat requires investigation.',
        requestKey: key,
        expectedVersion: 0,
      };
      assert.deepEqual(await commandIncident(db.sql, actor, open), { replayed: false });
      assert.deepEqual(await commandIncident(db.sql, actor, open), { replayed: true });
      await assert.rejects(
        commandIncident(db.sql, actor, {
          ...open,
          note: 'Changed evidence with reused request key.',
        }),
        /already used/i,
      );
      await assert.rejects(
        commandIncident(db.sql, actor, { ...open, requestKey: randomUUID() }),
        /already exists/i,
      );
      let detail = await readIncident(db.sql, actor, code);
      assert.equal(detail.incident.version, 1);
      assert.equal(detail.events.length, 1);
      const assign = {
        code,
        action: 'assign',
        note: 'Assigning investigation to the on-call colleague.',
        requestKey: randomUUID(),
        expectedVersion: 1,
        assigneeId: colleague,
      };
      await commandIncident(db.sql, actor, assign);
      await assert.rejects(
        commandIncident(db.sql, actor, { ...assign, requestKey: randomUUID() }),
        /changed/i,
      );
      detail = await readIncident(db.sql, actor, code);
      assert.equal(detail.incident.assignee_id, colleague);
      assert.equal(detail.events[0].details.assigneeId, colleague);
      await commandIncident(db.sql, actor, {
        code,
        action: 'acknowledge',
        note: 'Investigation accepted; signal remains active.',
        requestKey: randomUUID(),
        expectedVersion: 2,
      });
      detail = await readIncident(db.sql, actor, code);
      assert.equal(detail.count, 1);
      assert.equal(detail.incident.status, 'acknowledged');
      await assert.rejects(
        commandIncident(db.sql, actor, {
          code,
          action: 'resolve',
          note: 'Attempting premature resolution of active signal.',
          requestKey: randomUUID(),
          expectedVersion: 3,
        }),
        /remains active/i,
      );
      await db.sql`INSERT INTO service_health(service,healthy,checked_at,last_success_at) VALUES
      ('payments',true,clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '5 minutes')`;
      detail = await readIncident(db.sql, actor, code);
      assert.equal(detail.count, 1);
      assert.equal(detail.health.stale, true);
      await db.sql`UPDATE service_health SET checked_at=clock_timestamp(),last_success_at=clock_timestamp() WHERE service='payments'`;
      detail = await readIncident(db.sql, actor, code);
      assert.equal(detail.count, 0);
      await commandIncident(db.sql, actor, {
        code,
        action: 'resolve',
        note: 'Fresh successful heartbeat confirms measured recovery.',
        requestKey: randomUUID(),
        expectedVersion: 3,
      });
      detail = await readIncident(db.sql, actor, code);
      assert.equal(detail.incident.status, 'resolved');
      assert.equal(detail.events[0].signal_count, 0);
      await assert.rejects(
        db.sql`DELETE FROM operational_incident_event WHERE code=${code}`,
        /append-only/i,
      );
      await assert.rejects(
        db.sql`UPDATE operational_incident_event SET note='altered evidence' WHERE code=${code}`,
        /append-only/i,
      );
      await db.sql`UPDATE admin_user SET is_active=false WHERE id=${actor}`;
      await assert.rejects(readIncident(db.sql, actor, code), /active admin/i);
    } finally {
      await db.drop();
    }
  },
);

test(
  'CP29 delivery detail, duplicate retry and uncertain POST reconciliation',
  { skip: !server },
  async () => {
    const db = await createDisposableDatabase(server);
    try {
      const fixture = await seedReviewFixture(db.sql);
      const booking = await seedConfirmedBooking(db.sql, fixture.listing);
      const [blocked] =
        await db.sql`INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at,state,recipient)
      VALUES(${booking.order},${booking.customer},'cp29-blocked','confirmation',clock_timestamp(),'blocked','+919000000077') RETURNING id`;
      const before = await notificationDetail(db.sql, fixture.admin, blocked.id);
      assert.equal(before.recipient, '••••0077');
      assert.equal(before.state, 'blocked');
      const deliveryIncident = await readIncident(db.sql, fixture.admin, 'delivery_backlog');
      assert.equal(deliveryIncident.count, 1);
      assert.equal(deliveryIncident.records[0].href, `/admin/notifications/${blocked.id}`);
      const retries = await Promise.allSettled([
        retryNotification(db.sql, fixture.admin, blocked.id),
        retryNotification(db.sql, fixture.admin, blocked.id),
      ]);
      assert.equal(retries.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal((await notificationDetail(db.sql, fixture.admin, blocked.id)).state, 'pending');

      const account = `AC${'a'.repeat(32)}`;
      const sid = `SM${'b'.repeat(32)}`;
      const message = {
        sid,
        account_sid: account,
        to: '+919000000077',
        from: '+919000000088',
        body: 'Fixture body',
        status: 'delivered',
      };
      const [unknown] =
        await db.sql`INSERT INTO notification_outbox(order_id,customer_id,event_key,template,scheduled_at,state,recipient,sender,provider_account,body_hash)
      VALUES(${booking.order},${booking.customer},'cp29-unknown','confirmation',clock_timestamp(),'unknown',${message.to},${message.from},${account},${bodyHash(message.body)}) RETURNING id`;
      await assert.rejects(
        retryNotification(db.sql, fixture.admin, unknown.id),
        /definitely undispatched/i,
      );
      const options = {
        env: {
          CUSTOMER_NOTIFICATION_DELIVERY: 'twilio',
          TWILIO_ACCOUNT_SID: account,
          TWILIO_AUTH_TOKEN: 'fixture-token',
          TWILIO_FROM_NUMBER: message.from,
        },
        fetcher: async () => ({ ok: true, json: async () => message }),
      };
      await reconcileUnknownNotification(db.sql, fixture.admin, unknown.id, sid, options);
      assert.equal(
        (await notificationDetail(db.sql, fixture.admin, unknown.id)).state,
        'delivered',
      );
      await assert.rejects(
        reconcileUnknownNotification(db.sql, fixture.admin, unknown.id, sid, options),
        /No uncertain dispatch/i,
      );
    } finally {
      await db.drop();
    }
  },
);
