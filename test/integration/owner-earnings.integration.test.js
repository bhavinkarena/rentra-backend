import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { ownerEarnings, ownerEarningsCsv } from '../../src/services/finance/owner-earnings.js';
import {
  financeAllocation,
  financePayouts,
  financePayout,
} from '../../src/services/finance/statements.js';

test(
  'owner earnings reconcile rent, refunds, IST months, environments, paged exports and historical ownership',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        money = await seedFinanceFixture(sql, f),
        owner = { kind: 'owner', id: f.owner },
        other = { kind: 'owner', id: f.other };
      await sql`INSERT INTO payment_gateway_config(version,provider,environment,enabled,collection_purpose,changed_by) VALUES(1,'razorpay','test',true,'full',${f.admin})`;
      const testDefault = await ownerEarnings(sql, owner, { month: money.period });
      assert.equal(testDefault.filters.environment, 'test');
      assert.equal(testDefault.count, 1);
      assert.equal(testDefault.items[0].bookedRentMinor, '100000');
      assert.equal(testDefault.totals.bookedRentMinor, '100000', 'guest fee excluded');
      const live = await ownerEarnings(sql, owner, { month: money.period, environment: 'live' });
      assert.deepEqual(live.totals, {
        bookedRentMinor: '100000',
        refundedMinor: '20000',
        completedRentMinor: '100000',
      });
      assert.equal(live.items[0].refundPendingMinor, '10000');
      assert.equal(live.items[0].guestFirstName, 'Finance');
      assert.equal(live.payoutStatus.railAvailable, false);
      assert.equal(live.payoutStatus.kind, 'unavailable');
      assert.equal(live.items[0].earningLineIds.length, 1);
      assert.equal(
        (await financeAllocation(sql, owner, money.live.allocationId)).quotedRentMinor,
        '100000',
      );
      await assert.rejects(financeAllocation(sql, owner, money.live.feeAllocationId), {
        statusCode: 404,
      });
      await assert.rejects(financeAllocation(sql, other, money.live.allocationId), {
        statusCode: 404,
      });
      await assert.rejects(ownerEarnings(sql, owner, { month: '2026-13' }), { statusCode: 400 });
      const emptyOwner = await ownerEarnings(sql, other, { month: money.period });
      assert.equal(emptyOwner.count, 0);
      assert.equal(emptyOwner.payoutStatus.kind, 'missing');
      assert.equal((await ownerEarnings(sql, owner, { month: '2000-01' })).count, 0);
      const boundary = await money.add('test', { createdAt: '2026-09-30T19:00:00Z' });
      assert.ok(
        (await ownerEarnings(sql, owner, { month: '2026-10' })).items.some(
          (r) => r.id === boundary.bookingId,
        ),
      );
      assert.ok(
        !(await ownerEarnings(sql, owner, { month: '2026-09' })).items.some(
          (r) => r.id === boundary.bookingId,
        ),
      );
      // Test obligations stay distinguishable even before a funded payout engine exists.
      const payoutList = await financePayouts(sql, owner, {
        period: money.period,
        environment: 'test',
      });
      assert.equal(payoutList.count, 1);
      assert.equal((await financePayout(sql, owner, payoutList.items[0].id)).environment, 'test');
      // More than the old 1,000-allocation ceiling: all rows remain reachable and exportable.
      for (let i = 0; i < 1200; i += 6)
        await Promise.all(
          Array.from({ length: 6 }, () => money.add('test', { createdAt: '2001-07-15T06:00:00Z' })),
        );
      const first = await ownerEarnings(sql, owner, { month: '2001-07' }),
        last = await ownerEarnings(sql, owner, { month: '2001-07', page: 40 });
      assert.equal(first.count, 1200);
      assert.equal(first.pages, 40);
      assert.equal(first.items.length, 30);
      assert.equal(last.items.length, 30);
      assert.equal(first.totals.bookedRentMinor, '120000000');
      assert.equal(
        (await ownerEarnings(sql, owner, { month: '2001-07', page: 41 })).filters.page,
        40,
      );
      assert.ok(!last.items.some((r) => first.items.some((a) => a.id === r.id)));
      const csv = await ownerEarningsCsv(sql, owner, { month: '2001-07' });
      assert.equal(csv.split('\r\n').filter((r) => r.startsWith('"Finance Farm"')).length, 1200);
      assert.match(csv, /"1000\.00"/);
      assert.match(csv, /"Guest first name"/);
      assert.ok(!csv.includes(money.test.allocationId));
      assert.ok(!csv.includes('propertyId'));
      assert.equal(
        (
          await sql`SELECT count(*)::int count FROM audit_log WHERE action='finance_statement_downloaded' AND actor_id=${f.owner}`
        )[0].count,
        1,
      );
      await sql`UPDATE rentable SET client_id=${f.other} WHERE id=${f.listing}`;
      const history = await ownerEarnings(sql, owner, { month: '2001-07' });
      assert.equal(history.count, 1200);
      assert.equal(history.items[0].bookingLinkAvailable, false);
      assert.equal((await ownerEarnings(sql, other, { month: '2001-07' })).count, 0);
      await sql`UPDATE payout_destination SET state='failed',decided_at=now(),decided_by=${f.admin},failure_reason='The declared bank details need correction.' WHERE id=${money.destinationId}`;
      const failedMethod = (await ownerEarnings(sql, owner, { month: money.period })).payoutStatus;
      assert.equal(failedMethod.kind, 'failed');
      assert.match(failedMethod.failureReason, /bank details need correction/);
      assert.equal(failedMethod.railAvailable, false);
    } finally {
      await db.drop();
    }
  },
);
