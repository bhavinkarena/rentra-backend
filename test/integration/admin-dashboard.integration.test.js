import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { readAdminDashboard, readDecisionHistory } from '../../src/services/admin/dashboard.js';
import { dashboardScope, dashboardQuery } from '../../src/services/admin/dashboard-scope.js';
import { listBookingRecords } from '../../src/services/booking/records.js';
import { listPaymentOrders } from '../../src/services/payments/investigation.js';
import { listRefunds } from '../../src/services/payments/refund-operations.js';
import { listPropertyReviews, submitProperty } from '../../src/services/admin/listings.js';
import { createSupportRequest, listSupportRequests } from '../../src/services/support/service.js';
import { listApplications } from '../../src/services/admin/applications.js';
import { propertyToday } from '../../src/services/domain/booking-dates.js';

test('dashboard IST scope validates dates and zero-fill boundaries', () => {
  const scope = dashboardScope({ period: '7d' }, new Date('2026-10-04T18:30:00Z'));
  assert.equal(scope.today, '2026-10-05');
  assert.equal(scope.from, '2026-09-29');
  assert.equal(scope.startInclusive, '2026-09-28T18:30:00.000Z');
  assert.equal(scope.endExclusive, '2026-10-05T18:30:00.000Z');
  assert.equal(scope.days.length, 7);
  assert.equal(scope.environment, 'live');
  assert.equal(dashboardQuery.safeParse({ period: '1y' }).success, false);
  assert.equal(dashboardQuery.safeParse({ environment: 'all' }).success, false);
});

test(
  'authorized dashboard aggregates, evidence and matching drill-downs',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const db = fixture.sql;
    try {
      const f = await seedReviewFixture(db);
      const finance = await seedFinanceFixture(db, f);
      await submitProperty(db, { id: f.listing, clientId: f.owner });
      const support = await createSupportRequest(
        db,
        { kind: 'owner', id: f.owner },
        {
          category: 'other',
          subject: 'Fixture assistance',
          body: 'Please review this question.',
          requestKey: randomUUID(),
          orderId: null,
          propertyId: null,
          privacyRequestId: null,
        },
      );
      await db`UPDATE support_request SET priority='urgent',state='waiting_customer' WHERE id=${support.id}`;
      const now = new Date(),
        today = propertyToday(now);
      const scope = dashboardScope({ period: '7d' }, now);
      const actor = { kind: 'admin', id: f.admin };
      await db`UPDATE booking SET starts_at=(${today}::date-1) AT TIME ZONE 'Asia/Kolkata', ends_at=(${today}::date-1) AT TIME ZONE 'Asia/Kolkata'+interval '9 hours'`;
      const cloneOrder = async (at, state = 'completed') => {
        const id = randomUUID();
        await db`INSERT INTO booking_order SELECT (jsonb_populate_record(NULL::booking_order,to_jsonb(o)||jsonb_build_object('id',${id}::text,'reference',${id}::text,'idempotency_key',${id}::text,'created_at',${at}::text,'hold_expires_at',${new Date(now.getTime() + 3600000).toISOString()}::text,'state',${state}::text))).* FROM booking_order o WHERE id=${finance.live.orderId}`;
        return id;
      };
      const cloneVisit = async (order, state = 'completed', position = 1, hoursKnown = true) => {
        const id = randomUUID();
        await db`INSERT INTO booking SELECT (jsonb_populate_record(NULL::booking,to_jsonb(v)||jsonb_build_object('id',${id}::text,'reference',${id.slice(0, 16)}::text,'order_id',${order}::text,'item_position',${position}::int,'slot',${['day', 'night', 'full_day'][position - 1]}::text,'state',${state}::text,'hours_known',${hoursKnown}::boolean,'local_day',${today}::text,'blocked_start_at',${`${today}T09:00:00+05:30`}::text,'blocked_end_at',${`${today}T18:00:00+05:30`}::text,'starts_at',${`${today}T09:00:00+05:30`}::text,'ends_at',${`${today}T18:00:00+05:30`}::text))).* FROM booking v WHERE id=${finance.live.bookingId}`;
        return id;
      };
      // The original two Live orders are inside this period. 26 more exceed a list page.
      for (let i = 0; i < 26; i++) {
        const id = await cloneOrder(scope.startInclusive);
        await cloneVisit(id, 'completed', 1, i !== 0);
      }
      const multi = await cloneOrder(scope.startInclusive);
      await cloneVisit(multi);
      await cloneVisit(multi, 'completed', 2);
      await cloneVisit(multi, 'cancelled', 3);
      const cancelled = await cloneOrder(scope.startInclusive, 'cancelled');
      await cloneVisit(cancelled, 'cancelled');
      await cloneOrder(new Date(new Date(scope.startInclusive).getTime() - 1).toISOString());
      await cloneOrder(scope.endExclusive);
      const _app =
        await db`INSERT INTO client_application(user_id,status,legal_name,submitted_at) VALUES (${f.other},'submitted','Waiting owner',now()-interval '50 hours') RETURNING id`;
      const reviewed =
        await db`INSERT INTO client_application(user_id,status,legal_name,reviewed_at) VALUES (${f.owner},'approved','Reviewed owner',now()) RETURNING id`;
      for (const action of ['application_more_info', 'application_approved'])
        await db`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,at) VALUES ('admin',${f.admin},'client_application',${reviewed[0].id},${action},${scope.startInclusive})`;
      await db`INSERT INTO service_health(service,healthy,checked_at) VALUES ('payments',true,now())`;
      let result = await readAdminDashboard(db, f.admin, { period: '7d' }, { now });
      assert.deepEqual(Object.keys(result.modules).sort(), [
        'applications',
        'bookings',
        'finance',
        'health',
        'properties',
        'support',
      ]);
      for (const [key, module] of Object.entries(result.modules))
        assert.equal(module.availability, 'available', `${key} must load`);
      const metric = (key) =>
        Object.values(result.modules)
          .flatMap((m) => m.metrics ?? [])
          .find((m) => m.key === key);
      assert.equal(metric('bookings').value, '30'); // 2 + 26 + multi + cancelled; boundary orders excluded.
      assert.equal(metric('rent').value, '3000000'); // 2+26+2 visits; cancelled order/visit excluded.
      assert.equal(result.modules.bookings.visits.arrivals, 27);
      assert.equal(result.modules.bookings.visits.departures, 27);
      assert.equal(result.modules.bookings.visits.hours_unknown, 1);
      assert.equal(metric('visits').value, '28'); // 26+2; not 27 orders, not 29 including cancelled.
      assert.equal(
        metric('visits').startInclusive,
        new Date(`${today}T00:00:00+05:30`).toISOString(),
      );
      assert.equal(metric('captured').value, '216000');
      assert.equal(metric('refunded').value, '20000');
      assert.equal(metric('refundPending').value, '10000');
      assert.equal(metric('applications').value, '1');
      assert.equal(metric('properties').value, '1');
      assert.equal(metric('support').value, '1');
      assert.equal((await listSupportRequests(db, actor, metric('support').filters)).total, 1);
      assert.equal(result.modules.applications.counts.overdue, 1);
      assert.equal(
        result.modules.applications.throughput.reduce((n, r) => n + r.decisions, 0),
        2,
      );
      assert.equal(result.modules.bookings.dailySeries.length, 7);
      assert.ok(
        result.modules.bookings.dailySeries.some((r) => r.bookings === 0 && r.rentMinor === '0'),
      );
      assert.equal((await listApplications(db, f.admin, metric('applications').filters)).total, 1);
      assert.equal(
        (await listPropertyReviews(db, f.admin, metric('properties').filters)).total,
        Number(metric('properties').value),
      );
      const orders = await listBookingRecords(db, actor, metric('bookings').filters);
      assert.equal(orders.total, 30);
      assert.equal(orders.items.length, 20);
      const rent = await listBookingRecords(db, actor, metric('rent').filters);
      assert.equal(rent.total, 29);
      const visits = await listBookingRecords(db, actor, metric('visits').filters);
      assert.equal(visits.total, 28);
      assert.equal(new Set(visits.items.map((r) => r.visitId)).size, visits.items.length);
      assert.equal(
        (await listBookingRecords(db, actor, { ...metric('visits').filters, q: multi })).total,
        2,
      );
      const captures = await listPaymentOrders(db, actor, metric('captured').filters);
      assert.equal(
        captures.totals.reduce((n, r) => n + r.capturedMinor, 0),
        216000,
      );
      assert.equal(
        (await listRefunds(db, actor, metric('refunded').filters)).totals.reduce(
          (n, r) => n + r.refundedMinor,
          0,
        ),
        20000,
      );
      const history = await readDecisionHistory(db, { from: scope.from, to: scope.to });
      assert.equal(history.total, 2);
      assert.equal(new Set(history.items.map((r) => r.application_id)).size, 1);
      const testData = await readAdminDashboard(
        db,
        f.admin,
        { period: '7d', environment: 'test' },
        { now },
      );
      assert.equal(testData.modules.bookings.metrics.find((m) => m.key === 'bookings').value, '1');
      assert.equal(
        testData.modules.finance.metrics.find((m) => m.key === 'captured').value,
        '108000',
      );
      const simulated = await readAdminDashboard(
        db,
        f.admin,
        { period: '7d', environment: 'simulated' },
        { now },
      );
      assert.equal(
        simulated.modules.finance.metrics.find((m) => m.key === 'captured').availability,
        'unavailable',
      );
      assert.equal(simulated.modules.bookings.metrics.find((m) => m.key === 'bookings').value, '1');
      assert.deepEqual(
        Object.keys((await readAdminDashboard(db, f.limited, { period: '7d' }, { now })).modules),
        ['bookings'],
      );
      await db`UPDATE admin_user SET permissions='["admin.payments.read"]'::jsonb WHERE id=${f.second}`;
      assert.deepEqual(Object.keys((await readAdminDashboard(db, f.second)).modules), ['finance']);
      await db`UPDATE admin_user SET permissions='["admin.customers.read"]'::jsonb WHERE id=${f.second}`;
      assert.deepEqual((await readAdminDashboard(db, f.second)).modules, {});
      await db`UPDATE admin_user SET permissions='[]'::jsonb WHERE id=${f.second}`;
      assert.deepEqual((await readAdminDashboard(db, f.second)).modules, {});
      await assert.rejects(readAdminDashboard(db, f.owner));
      await assert.rejects(
        listPaymentOrders(db, actor, { basis: 'capture', from: '2026-02-30', to: today }),
      );
      // Provider verification date, not order creation date, controls captured money.
      const before = new Date(new Date(scope.startInclusive).getTime() - 1).toISOString();
      for (const verifiedAt of [
        before,
        scope.startInclusive,
        new Date(new Date(scope.endExclusive).getTime() - 1).toISOString(),
        scope.endExclusive,
      ]) {
        await finance.add('live', { orderCreatedAt: before, verifiedAt });
      }
      const held = await cloneOrder(scope.startInclusive, 'held');
      await cloneVisit(held, 'requested');
      result = await readAdminDashboard(db, f.admin, { period: '7d' }, { now });
      const refreshedMetrics = Object.values(result.modules).flatMap((m) => m.metrics ?? []);
      assert.equal(refreshedMetrics.find((m) => m.key === 'captured').value, '432000');
      assert.equal(refreshedMetrics.find((m) => m.key === 'bookings').value, '31');
      assert.equal(refreshedMetrics.find((m) => m.key === 'rent').value, '3000000');
      assert.equal(refreshedMetrics.find((m) => m.key === 'visits').value, '28');
      assert.equal(
        (await listPaymentOrders(db, actor, metric('captured').filters)).totals.reduce(
          (n, r) => n + r.capturedMinor,
          0,
        ),
        432000,
      );
      await db`ALTER TABLE service_health RENAME TO fixture_hidden_health`;
      result = await readAdminDashboard(db, f.admin, { period: '7d' }, { now });
      assert.deepEqual(result.modules.health, { availability: 'unavailable' });
      assert.equal(result.modules.bookings.availability, 'available');
      assert.equal(JSON.stringify(result).includes('fixture_hidden_health'), false);
      // Representative query plan at 1,000 orders; no migration assumed from a small fixture.
      for (let i = 0; i < 970; i++) await cloneOrder(scope.startInclusive);
      await db`ANALYZE booking_order`;
      const plan =
        await db`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT count(*),sum(CASE WHEN o.state IN ('draft','held','expired','cancelled') THEN 0 ELSE coalesce((SELECT sum(v.amount_rent_minor) FROM booking v WHERE v.order_id=o.id AND v.state NOT IN ('requested','cancelled')),0) END) FROM booking_order o WHERE o.visit_provenance='real' AND o.created_at>=${scope.startInclusive}::timestamptz AND o.created_at<${scope.endExclusive}::timestamptz`;
      if (process.env.ADMIN_DASHBOARD_EVIDENCE_DIR) {
        await mkdir(process.env.ADMIN_DASHBOARD_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          `${process.env.ADMIN_DASHBOARD_EVIDENCE_DIR}/query-plan.json`,
          JSON.stringify({ orders: 1009, plan: plan[0]['QUERY PLAN'] }, null, 2) + '\n',
        );
      }
    } finally {
      await fixture.drop();
    }
  },
);
