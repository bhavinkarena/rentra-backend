import { test } from 'node:test';
import { insertFixtureOrder } from '../helpers/fixture-order.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import {
  financeStatement,
  financeAllocation,
  financePayouts,
  financePayout,
  financeCsv,
} from '../../src/services/finance/statements.js';

test(
  'CP22 scoped statements reconcile adjustments, environments, transfers and pinned payouts',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        fixture = await seedFinanceFixture(sql, f),
        owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin },
        other = { kind: 'owner', id: f.other };
      const query = { period: fixture.period, environment: 'live' };
      const s = await financeStatement(sql, owner, query);
      // Owners see their rent only; the guest's platform fee is Rentra's.
      assert.equal(s.count, 1);
      assert.equal(s.totals.quotedRentMinor, '100000');
      assert.equal(s.totals.collectedMinor, '100000');
      assert.equal(s.totals.refundedMinor, '20000');
      assert.equal(s.totals.rentNetMinor, '80000');
      assert.equal(s.totals.refundPendingMinor, '10000');
      assert.equal(s.totals.settledMinor, '30000');
      assert.equal(s.totals.eligibleMinor, '40000');
      assert.equal(s.disbursementAvailable, false);
      assert.equal(
        BigInt(s.totals.rentNetMinor),
        ['refundPendingMinor', 'pendingMinor', 'eligibleMinor', 'heldMinor', 'settledMinor'].reduce(
          (n, k) => n + BigInt(s.totals[k]),
          0n,
        ),
      );
      const detail = await financeAllocation(sql, owner, fixture.live.allocationId);
      assert.equal(detail.collectedMinor, '100000');
      assert.equal(detail.refunds.length, 3);
      assert.equal(detail.payout.destination.version, 1);
      const payouts = await financePayouts(sql, owner, query);
      assert.equal(payouts.count, 1);
      assert.equal(payouts.totalMinor, '30000');
      assert.equal((await financePayout(sql, owner, fixture.payoutId)).amountMinor, '30000');
      const csv = await financeCsv(sql, owner, query);
      assert.match(csv, /100000/);
      assert.doesNotMatch(csv, /,fee,/);
      assert.match(csv, /Current|current/);
      assert.doesNotMatch(csv, /upi_id|holder_name/);
      assert.equal(
        (
          await sql`SELECT count(*)::int n FROM audit_log WHERE action='finance_statement_downloaded'`
        )[0].n,
        1,
      );
      for (const environment of ['test', 'simulated', 'legacy_unknown']) {
        const x = await financeStatement(sql, owner, { ...query, environment });
        assert.equal(x.totals.eligibleMinor, '0');
        assert.equal(x.totals.settledMinor, '0');
      }
      const sim = await financeStatement(sql, owner, { ...query, environment: 'simulated' });
      assert.equal(sim.totals.simulatedMinor, '100000');
      assert.equal(sim.totals.collectedMinor, '0');
      assert.equal(
        (await financePayouts(sql, owner, { ...query, environment: 'legacy_unknown' })).totalMinor,
        '0',
      );
      assert.equal((await financeStatement(sql, other, query)).count, 0);
      assert.equal((await financeStatement(sql, admin, query)).count, 4);
      assert.equal((await financeStatement(sql, admin, query)).totals.heldMinor, '100000');
      await assert.rejects(financeAllocation(sql, other, fixture.live.allocationId), {
        statusCode: 404,
      });
      await assert.rejects(financePayout(sql, other, fixture.payoutId), { statusCode: 404 });
      await assert.rejects(financeCsv(sql, other, { ...query, ownerId: f.owner }), {
        statusCode: 404,
      });
      await assert.rejects(financeStatement(sql, { kind: 'admin', id: f.limited }, query), {
        statusCode: 403,
      });
      await assert.rejects(financeStatement(sql, { kind: 'staff', id: f.owner }, query), {
        statusCode: 403,
      });
      await assert.rejects(financeStatement(sql, owner, { period: '2026-13' }), {
        statusCode: 400,
      });
      await assert.rejects(financeStatement(sql, owner, { environment: 'all' }), {
        statusCode: 400,
      });
      assert.equal(
        (await financeStatement(sql, owner, { ...query, propertyId: randomUUID() })).count,
        0,
      );
      assert.equal((await financeStatement(sql, owner, { ...query, period: '2000-01' })).count, 0);
      // A pre-checkout visit: since 0047 it sits in a 'legacy' order.
      const [source] =
        await sql`SELECT rentable_id,customer_id FROM booking WHERE id=${fixture.live.bookingId}`;
      const legacyOrder = await insertFixtureOrder(sql, {
        customerId: source.customer_id,
        rentableId: source.rentable_id,
        state: 'legacy',
      });
      const [legacyVisit] =
        await sql`INSERT INTO booking(reference,rentable_id,customer_id,order_id,item_position,local_day,slot,state,currency,time_zone,amount_rent_minor,amount_fee_minor,amount_deposit_minor)
        VALUES (${randomUUID().slice(0, 16)},${source.rentable_id},${source.customer_id},${legacyOrder},1,current_date,'day','completed','INR','Asia/Kolkata',100000,8000,0) RETURNING id`;
      const [oldPayout] =
        await sql`INSERT INTO payout(booking_id,client_id,gross_minor,commission_minor,net_minor,status) VALUES (${legacyVisit.id},${f.owner},100000,8000,92000,'paid') RETURNING id`;
      const legacyDetail = await financePayout(sql, owner, oldPayout.id);
      assert.equal(legacyDetail.orderId, legacyOrder);
      assert.equal(legacyDetail.bookingLinkAvailable, true);
      assert.equal(legacyDetail.amountMinor, '0');
      assert.equal(
        (await financePayouts(sql, owner, { ...query, environment: 'legacy_unknown' })).count,
        1,
      );
      const heldSource = await fixture.add('live', { createdAt: '2000-01-01T00:00:00Z' });
      const [pendingPayout] =
        await sql`INSERT INTO payout(booking_id,client_id,funding_allocation_id,actual_net_minor,gross_minor,commission_minor,net_minor,status,destination_id,created_at) VALUES (${heldSource.bookingId},${f.owner},${heldSource.allocationId},60000,100000,8000,92000,'pending',${fixture.destinationId},'2000-01-01') RETURNING id`;
      let bucket = await financeAllocation(sql, owner, heldSource.allocationId);
      assert.equal(bucket.pendingMinor, '60000');
      assert.equal(bucket.eligibleMinor, '40000');
      await sql`UPDATE payout SET status='frozen' WHERE id=${pendingPayout.id}`;
      bucket = await financeAllocation(sql, owner, heldSource.allocationId);
      assert.equal(bucket.pendingMinor, '0');
      assert.equal(bucket.heldMinor, '60000');
      await sql`UPDATE payout SET status='failed' WHERE id=${pendingPayout.id}`;
      bucket = await financeAllocation(sql, owner, heldSource.allocationId);
      assert.equal(bucket.heldMinor, '0');
      assert.equal(bucket.eligibleMinor, '100000');
      assert.match(
        (await financePayout(sql, owner, pendingPayout.id)).recovery,
        /no automatic retry/,
      );
      await sql`UPDATE payout SET status='pending' WHERE id=${pendingPayout.id}`;
      // Property transfer cannot move historical receipts. Existing operational links are suppressed.
      await sql`UPDATE rentable SET client_id=${f.other} WHERE id=${f.listing}`;
      assert.equal((await financeStatement(sql, owner, query)).totals.collectedMinor, '100000');
      assert.equal((await financeStatement(sql, other, query)).count, 0);
      assert.equal(
        (await financeAllocation(sql, owner, fixture.live.allocationId)).bookingLinkAvailable,
        false,
      );
      assert.equal((await financePayout(sql, owner, fixture.payoutId)).destination.version, 1);
      // Destination change holds remaining funds and does not rewrite settlement/pinning.
      await sql`UPDATE payout_destination SET state='superseded' WHERE id=${fixture.destinationId}`;
      await sql`INSERT INTO payout_destination(client_id,version,method,holder_name,account_last4,ifsc,name_check,state,source,submitted_at) VALUES (${f.owner},2,'bank','Property Owner','1122','SBIN0001234','same','submitted','settings',now())`;
      const changed = await financeStatement(sql, owner, query);
      assert.equal(changed.totals.eligibleMinor, '0');
      assert.equal(changed.totals.heldMinor, '40000');
      assert.equal(changed.totals.settledMinor, '30000');
      assert.equal(
        (await financeAllocation(sql, owner, heldSource.allocationId)).heldMinor,
        '100000',
      );
      const pin = await financePayout(sql, owner, fixture.payoutId);
      assert.equal(pin.destination.version, 1);
      assert.match(pin.destination.masked, /6789/);
      assert.equal(pin.destination.state, 'superseded');
      await sql`UPDATE "user" SET account_status='suspended' WHERE id=${f.owner}`;
      await assert.rejects(financeStatement(sql, owner, query), { statusCode: 403 });
    } finally {
      await db.drop();
    }
  },
);
