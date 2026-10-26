import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableDatabase } from '../helpers/disposable-db.js';
import { seedReviewFixture } from '../helpers/listing-review-fixture.js';
import { allocateOrderFee, priceVisitsMinor } from '../../src/services/domain/booking-money.js';

test('Story 2.2 order fee: rounded once, half up, parts always add up', () => {
  // 5% of 1,000.01 = 50.0005 → 50.00 (half up on the order, not per part).
  const parts = allocateOrderFee([33_333, 33_334, 33_334], 500);
  assert.equal(
    parts.reduce((sum, value) => sum + value, 0),
    Math.floor((100_001 * 500 + 5_000) / 10_000),
  );
  for (let i = 0; i < 200; i++) {
    const bases = Array.from(
      { length: 1 + (i % 7) },
      (_, k) => 1 + ((i * 7919 + k * 104729) % 250_000),
    );
    const total = bases.reduce((sum, value) => sum + value, 0);
    const fees = allocateOrderFee(bases, 500);
    assert.equal(
      fees.reduce((sum, value) => sum + value, 0),
      Math.floor((total * 500 + 5_000) / 10_000),
    );
    fees.forEach((fee, k) => assert.ok(Math.abs(fee - (bases[k] * 500) / 10_000) < 1));
  }
  const priced = priceVisitsMinor({
    dates: ['2030-01-01', '2030-01-02', '2030-01-03'],
    slot: 'day',
    guests: 2,
    rate: {
      weekdayMinor: 333_33,
      weekendMinor: 333_33,
      depositMinor: 0,
      includedGuests: 4,
      capacity: 4,
      extraGuestChargeMinor: 0,
    },
    feeBps: 500,
  });
  assert.equal(priced.totals.feeMinor, Math.floor((99_999 * 500 + 5_000) / 10_000));
  assert.equal(priced.totals.totalMinor, priced.totals.rentMinor + priced.totals.feeMinor);
});

test(
  'Story 2.2 service fee settings: global, owner override, 0%, future date, stale, audit',
  { skip: !process.env.PORTAL_TEST_DATABASE_URL },
  async () => {
    const fixture = await createDisposableDatabase(process.env.PORTAL_TEST_DATABASE_URL);
    const { sql } = fixture;
    try {
      Object.assign(process.env, { DATABASE_URL: fixture.url, NODE_ENV: 'test' });
      globalThis.__rentraSql = sql;
      const fees = await import('@/services/finance/service-fee.js');
      const f = await seedReviewFixture(sql);
      const change = (input) => fees.changeServiceFee(sql, { adminId: f.admin, input });

      // The migration seeds the 5% launch default.
      let current = await fees.resolveServiceFee(sql, f.owner);
      assert.deepEqual([current.bps, current.source], [500, 'global']);
      const globalId = current.settingId;

      // Validation, backdating and stale forms are refused.
      await assert.rejects(change({ ratePercent: '40', reason: 'Too high' }), { statusCode: 422 });
      await assert.rejects(
        change({
          ratePercent: '6',
          reason: 'Backdated',
          effectiveAt: '2020-01-01T00:00:00Z',
          expectedSettingId: globalId,
        }),
        { statusCode: 422 },
      );
      await assert.rejects(
        change({ ratePercent: '6', reason: 'Stale form', expectedSettingId: '' }),
        {
          code: 'FEE_SETTING_CHANGED',
        },
      );

      // An owner-wide override replaces the global rate for that owner only; 0% is allowed.
      await change({
        ownerEmail: 'property-owner@fixture.invalid',
        ratePercent: '0',
        reason: 'Founding partner',
        expectedSettingId: '',
      });
      current = await fees.resolveServiceFee(sql, f.owner);
      assert.deepEqual([current.bps, current.source], [0, 'owner']);
      assert.equal((await fees.resolveServiceFee(sql, f.other)).bps, 500);
      await assert.rejects(
        change({
          ownerEmail: 'property-owner@fixture.invalid',
          ratePercent: '3',
          reason: 'Replay of the same old form',
          expectedSettingId: '',
        }),
        { code: 'FEE_SETTING_CHANGED' },
      );

      // A future change does not apply until its time.
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await change({
        ratePercent: '7',
        reason: 'Planned increase',
        effectiveAt: future,
        expectedSettingId: globalId,
      });
      assert.equal((await fees.resolveServiceFee(sql, f.other)).bps, 500);
      assert.equal(
        (await fees.resolveServiceFee(sql, f.other, new Date(Date.now() + 7_200_000).toISOString()))
          .bps,
        700,
      );

      // History is append-only and every change is audited with old, new and reason.
      await assert.rejects(sql`UPDATE service_fee_setting SET rate_bps=1`);
      const audits =
        await sql`SELECT before, after, reason, actor_id FROM audit_log WHERE action='service_fee_changed' ORDER BY at`;
      assert.equal(audits.length, 2);
      assert.equal(audits[0].before, null);
      assert.equal(audits[0].after.rateBps, 0);
      assert.equal(audits[1].before.rateBps, 500);
      assert.equal(audits[1].after.rateBps, 700);
      assert.ok(audits.every((a) => a.reason && a.actor_id === f.admin));
      // No category or property scope exists.
      const columns =
        await sql`SELECT column_name FROM information_schema.columns WHERE table_name='service_fee_setting'`;
      assert.ok(!columns.some((c) => /category|rentable|city/.test(c.column_name)));
    } finally {
      await fixture.drop();
    }
  },
);
