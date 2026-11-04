import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture, seedConfirmedBooking } from '../helpers/listing-review-fixture.js';
import {
  createSupportRequest,
  replySupportRequest,
  addSupportNote,
  readSupportRequest,
  listSupportRequests,
} from '../../src/services/support/service.js';
import {
  scheduleSupportMilestones,
  deliverAdminAlertEmails,
  raiseAdminAlert,
} from '../../src/services/admin/admin-alerts.js';

test(
  'Story 4.2 urgent routing: matrix rows',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        booking = await seedConfirmedBooking(sql, f.listing);
      await sql`UPDATE booking SET starts_at=now()-interval '2 days',ends_at=now()+interval '1 day',local_day=(now()-interval '2 days')::date WHERE order_id=${booking.order}`;
      const [visit] = await sql`SELECT id FROM booking WHERE order_id=${booking.order}`;
      const [session] =
        await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`;
      const customer = {
        kind: 'customer',
        session: { role: 'customer', userId: booking.customer, sessionId: session.id },
      };
      const admin = { kind: 'admin', id: f.admin };
      const support = (
        await sql`SELECT id FROM admin_user WHERE permissions IS NULL AND is_active ORDER BY id`
      ).map((r) => r.id);
      const [limited] = await sql`SELECT id FROM admin_user WHERE email='limited@fixture.invalid'`;
      const discoveredAt = new Date(Date.now() - 3_600_000).toISOString();
      const file = (issueType, requestKey = randomUUID()) =>
        createSupportRequest(sql, customer, {
          category: 'stay_issue',
          body: 'Something is wrong with the stay.',
          orderId: booking.order,
          privacyRequestId: null,
          requestKey,
          stayIssue: {
            issueType,
            discoveredAt,
            affected: [{ visitId: visit.id, roomTypeId: null }],
            remedy: 'fix_during_stay',
          },
        });
      const alertsFor = (id) =>
        sql`SELECT admin_id,kind,event_key,email_state FROM admin_alert WHERE support_request_id=${id} ORDER BY event_key,admin_id`;

      // Access: one pending support_urgent alert per support admin; the non-support admin gets none.
      const key = randomUUID();
      const access = await file('access', key);
      const rows = await alertsFor(access.id);
      assert.deepEqual(rows.map((r) => r.admin_id).sort(), [...support].sort());
      assert.ok(rows.every((r) => r.kind === 'support_urgent' && r.email_state === 'pending'));
      assert.ok(!rows.some((r) => r.admin_id === limited.id));
      // Replay: no new alerts.
      assert.equal((await file('access', key)).id, access.id);
      assert.equal((await alertsFor(access.id)).length, support.length);
      // Normal issue: no immediate alert. Stranded: urgent + alert.
      const clean = await file('cleanliness');
      assert.equal((await alertsFor(clean.id)).length, 0);
      const stranded = await file('stranded');
      assert.equal(
        (await sql`SELECT priority FROM support_request WHERE id=${stranded.id}`)[0].priority,
        'urgent',
      );
      assert.equal((await alertsFor(stranded.id)).length, support.length);

      // Internal note does not count; a public reply sets first_response_at once.
      const reply = async (id, internal) => {
        const [r] = await sql`SELECT version FROM support_request WHERE id=${id}`;
        const input = {
          id,
          body: 'Looking into it.',
          state: 'in_progress',
          version: r.version,
          requestKey: randomUUID(),
        };
        await (internal
          ? addSupportNote(sql, admin, { id, body: input.body, requestKey: input.requestKey })
          : replySupportRequest(sql, admin, input));
        return (await sql`SELECT first_response_at FROM support_request WHERE id=${id}`)[0]
          .first_response_at;
      };
      assert.equal(await reply(stranded.id, true), null);
      const first = await reply(stranded.id, false);
      assert.ok(first);
      assert.deepEqual(await reply(stranded.id, false), first);

      // 1 h job: one 1h alert for the unanswered urgent case only; rerun adds nothing.
      const created = (await sql`SELECT created_at FROM support_request WHERE id=${access.id}`)[0]
        .created_at;
      const at = (h) => new Date(+created + h * 3_600_000 + 1000);
      assert.equal(await scheduleSupportMilestones(sql, at(1)), support.length);
      assert.equal(await scheduleSupportMilestones(sql, at(1)), 0, 'rerun raises nothing');
      const unanswered = () =>
        sql`SELECT support_request_id id,event_key FROM admin_alert WHERE kind='support_unanswered' AND admin_id=${f.admin} ORDER BY event_key`;
      assert.deepEqual(
        (await unanswered()).map((r) => r.event_key),
        [`support_unanswered:1h:${access.id}`],
      );

      // A resolved case never alerts or ages.
      const resolved = await file('other');
      await sql`UPDATE support_request SET state='resolved',version=version+1 WHERE id=${resolved.id}`;
      // Safety is urgent with an immediate alert; first seen by the job at >=12 h it gets only the 12h alert.
      const safety = await file('safety');
      assert.equal((await alertsFor(safety.id)).length, support.length);
      const safetyAt = (await sql`SELECT created_at FROM support_request WHERE id=${safety.id}`)[0]
        .created_at;
      const late = new Date(+safetyAt + 12 * 3_600_000 + 1000);
      // 12 h job: 12h alerts for unanswered, unresolved cases only; replied/resolved none.
      assert.ok((await scheduleSupportMilestones(sql, late)) > 0);
      assert.equal(await scheduleSupportMilestones(sql, late), 0, 'rerun raises nothing');
      const keys = (await unanswered()).map((r) => r.event_key);
      assert.ok(keys.includes(`support_unanswered:12h:${safety.id}`));
      assert.ok(!keys.includes(`support_unanswered:1h:${safety.id}`));
      assert.ok(keys.includes(`support_unanswered:12h:${access.id}`));
      assert.ok(keys.includes(`support_unanswered:12h:${clean.id}`));
      assert.ok(!keys.some((k) => k.endsWith(stranded.id) || k.endsWith(resolved.id)));
      assert.equal(keys.length, 4);

      // Email bodies link the support case, never a property.
      const bodies = [];
      const env = {
        OWNER_NOTIFICATION_DELIVERY: 'enabled',
        RESEND_API_KEY: 're_test',
        OTP_EMAIL_FROM: 'Rentra <alerts@rentra.test>',
        NEXT_PUBLIC_SITE_URL: 'https://rentra.test',
      };
      const adapter = () => ({
        send: async (row, body) => (bodies.push(body), { id: `email-${row.id}` }),
      });
      while ((await deliverAdminAlertEmails(sql, { env, adapter })) > 0);
      assert.ok(bodies.length > 0);
      assert.ok(
        bodies.every((b) => /https:\/\/rentra\.test\/admin\/support\/[0-9a-f-]{36}/.test(b)),
      );
      assert.ok(!bodies.some((b) => b.includes('/admin/properties/')));

      // Aged view: move creation back 13 h; replied and resolved are not aged; urgent sorts first.
      // Fixture-only backdating: creation time is otherwise immutable.
      await sql`ALTER TABLE support_request DISABLE TRIGGER support_request_terms_immutable`;
      await sql`UPDATE support_request SET created_at=created_at-interval '13 hours' WHERE order_id=${booking.order}`;
      await sql`ALTER TABLE support_request ENABLE TRIGGER support_request_terms_immutable`;
      const ids = async (view) =>
        (await listSupportRequests(sql, admin, { view })).items.map((i) => i.id);
      const agedIds = await ids('aged');
      assert.deepEqual(new Set(agedIds), new Set([access.id, safety.id, clean.id]));
      assert.equal(agedIds[2], clean.id, 'urgent first within aged');
      const urgentIds = await ids('urgent');
      assert.deepEqual(new Set(urgentIds), new Set([access.id, safety.id, stranded.id]));
      assert.equal(urgentIds[2], stranded.id, 'aged first within urgent');
      // Resolved urgent cases leave the urgent view.
      await sql`UPDATE support_request SET state='resolved',version=version+1 WHERE id=${stranded.id}`;
      assert.equal((await ids('urgent')).includes(stranded.id), false);
      assert.equal((await ids('unassigned')).includes(resolved.id), false);
      // Failed delivery.
      assert.deepEqual(await ids('failed_delivery'), []);
      await sql`UPDATE admin_alert SET email_state='failed' WHERE support_request_id=${clean.id}`;
      assert.deepEqual(await ids('failed_delivery'), [clean.id]);
      const listed = (await listSupportRequests(sql, admin, { view: 'all' })).items.find(
        (i) => i.id === clean.id,
      );
      assert.equal(listed.alertFailed, true);
      // 0099: customer cases carry their booking's property, and admins can filter by it.
      assert.equal(listed.propertyId, f.listing);
      const byProperty = (await listSupportRequests(sql, admin, { property: f.listing })).items;
      assert.ok(byProperty.length > 0 && byProperty.every((i) => i.propertyId === f.listing));
      assert.equal(
        (await listSupportRequests(sql, admin, { property: randomUUID() })).items.length,
        0,
      );
      // A customer case can never name a property other than its own booking's.
      await assert.rejects(
        sql`INSERT INTO support_request(id,reference,customer_id,property_id,order_id,category,subject,context,policy_version,request_key,request_hash)
          SELECT ${randomUUID()},'SUP-QA0099MISMATCH',customer_id,${randomUUID()},order_id,category,subject,context,policy_version,${randomUUID()},request_hash
          FROM support_request WHERE id=${clean.id}`,
        { code: '23514' },
      );
      const detail = await readSupportRequest(sql, admin, stranded.id);
      assert.ok(detail.firstResponseAt);
      assert.equal(detail.alerts.length, support.length);
      // Support list stays permission-gated for a non-support admin.
      await assert.rejects(listSupportRequests(sql, { kind: 'admin', id: limited.id }, {}), {
        code: 'NOT_FOUND',
      });
      // The guest never sees alerts.
      assert.equal((await readSupportRequest(sql, customer, access.id)).alerts, undefined);
      // No support admin at all: the alert falls back to every active admin.
      await sql`UPDATE admin_user SET permissions='["admin.records.read"]'::jsonb`;
      await sql.begin((tx) =>
        raiseAdminAlert(tx, {
          kind: 'support_urgent',
          eventKey: 'fallback',
          supportRequestId: clean.id,
          detail: {},
        }),
      );
      const active = (await sql`SELECT count(*)::int n FROM admin_user WHERE is_active`)[0].n;
      assert.equal(
        (await sql`SELECT count(*)::int n FROM admin_alert WHERE event_key='fallback'`)[0].n,
        active,
      );
    } finally {
      await db.drop();
    }
  },
);
