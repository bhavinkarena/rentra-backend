import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { seedFinanceFixture } from '../helpers/finance-fixture.js';
import { financeStatement } from '../../src/services/finance/statements.js';

test(
  'owner statements default to the gateway mode in use and never count the guest fee as owner money',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const db = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL),
      sql = db.sql;
    try {
      const f = await seedReviewFixture(sql),
        fixture = await seedFinanceFixture(sql, f),
        owner = { kind: 'owner', id: f.owner },
        admin = { kind: 'admin', id: f.admin };
      await sql`INSERT INTO payment_gateway_config(version,provider,environment,enabled,collection_purpose,changed_by)
        VALUES (1,'razorpay','test',true,'full',${f.admin})`;

      const byDefault = await financeStatement(sql, owner, { period: fixture.period });
      assert.equal(
        byDefault.filters.environment,
        'test',
        'Test-mode bookings are shown without choosing a filter',
      );
      assert.ok(byDefault.count > 0);

      const live = await financeStatement(sql, owner, {
        period: fixture.period,
        environment: 'live',
      });
      assert.deepEqual([...new Set(live.items.map((i) => i.component))], ['rent']);
      assert.equal(live.totals.collectedMinor, '100000', 'the ₹80 guest fee is not owner money');
      // Finance staff still see every component.
      const staff = await financeStatement(sql, admin, {
        period: fixture.period,
        environment: 'live',
      });
      assert.ok(staff.items.some((i) => i.component === 'fee'));
    } finally {
      await db.drop();
    }
  },
);
