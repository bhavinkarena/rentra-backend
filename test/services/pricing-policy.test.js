import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuote } from '../../src/services/booking/quotes.js';
import { cancellationEntitlement } from '../../src/services/domain/cancellation.js';
import { visitOperation } from '../../src/services/domain/booking-operations.js';
import { historyFilters } from '../../src/services/booking/records.js';

const slot = {
  enabled: true,
  startTime: '09:00',
  endTime: '18:00',
  endDayOffset: 0,
  bufferBeforeMinutes: 30,
  bufferAfterMinutes: 30,
  capacity: 12,
  includedGuests: 2,
  extraGuestChargeMinor: 10000,
};
const listing = {
  status: 'live',
  total_units: 1,
  capacity: 12,
  booking_config_version: 3,
  cancellation_tier: 'flexible',
  house_rules: ['Quiet hours'],
  deposit_amount: 500,
  booking_config: {
    inventoryReady: true,
    timeZone: 'Asia/Kolkata',
    leadTimeMinutes: 60,
    bookingHorizonDays: 90,
    slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } },
  },
};
const payment = {
  version: 1,
  provider: 'razorpay',
  environment: 'test',
  mode: 'real',
  enabled: true,
  collectionPurpose: 'full',
};
const quote = (dates, overrides = []) =>
  prepareQuote(
    { rentableId: '00000000-0000-4000-8000-000000000001', dates, slot: 'day', guests: 3 },
    listing,
    [{ slot: 'day', weekday: 1000, weekend: 2000 }],
    overrides,
    payment,
    new Date('2030-01-01T00:00:00Z'),
  );

test('CP11 quotes use India-local weekend boundaries, explicit overrides and exact integer totals', () => {
  const q = quote(['2030-01-04', '2030-01-05']);
  assert.deepEqual(
    q.visits.map((v) => v.priceSource),
    ['weekday', 'weekend'],
  );
  assert.equal(q.totals.rentMinor, 320000);
  assert.equal(q.totals.feeMinor, 25600);
  assert.equal(q.totals.totalMinor, 345600);
  const override = quote(
    ['2030-01-05'],
    [
      { day: '2030-01-05', slot: 'day', price_override: 1500 },
      { day: '2030-01-05', slot: 'day', rent_minor: 175050 },
    ],
  );
  assert.equal(override.totals.rentMinor, 185050);
  assert.equal(override.visits[0].priceSource, 'override');
  assert.equal(override.policy.pricing.platformFeeBps, 800);
  assert.equal(override.policy.pricing.depositCollectedOnline, false);
  assert.equal(override.policy.listingConfigVersion, 3);
  assert.notEqual(q.hash, override.hash);
});

test('CP11 accepted cancellation snapshots govern exact cutoff and survive later current-policy differences', () => {
  const policy = quote(['2030-01-05']).policy;
  const visit = {
    policy_snapshot: policy,
    hours_known: true,
    starts_at: '2030-01-05T03:30:00Z',
    amount_rent_minor: 100000,
    amount_fee_minor: 8000,
    amount_deposit_minor: 0,
  };
  assert.equal(cancellationEntitlement(visit, new Date('2030-01-02T03:30:00Z')).rent, 100000);
  assert.equal(cancellationEntitlement(visit, new Date('2030-01-02T03:30:00.001Z')).rent, 50000);
  assert.equal(cancellationEntitlement(visit, new Date('2030-01-02T03:30:00Z')).fee, 8000);
  const accepted = {
    ...visit,
    policy_snapshot: {
      ...policy,
      cancellation: { bands: [[0, 0.25]], noShow: 0, feeOnFullRefund: false },
    },
  };
  assert.equal(cancellationEntitlement(accepted, new Date('2030-01-02T03:30:00Z')).rent, 25000);
  assert.throws(() => cancellationEntitlement(visit, new Date(visit.starts_at)), /VISIT_STARTED/);
  const legacy = {
    ...visit,
    policy_snapshot: { version: 'customer-v1', cancellationTier: 'flexible' },
  };
  assert.equal(cancellationEntitlement(legacy, new Date('2030-01-02T03:30:00Z')).rent, 100000);
});

test('CP12 operational queues do not expand customer filters and action cues follow each visit', () => {
  assert.equal(historyFilters({ tab: 'today' }).tab, 'all');
  assert.equal(historyFilters({ tab: 'today' }, true).tab, 'today');
  assert.equal(historyFilters({ tab: 'action_needed' }, true).tab, 'action_needed');
  const v = {
    state: 'confirmed',
    hours_known: true,
    starts_at: '2030-01-05T03:30:00Z',
    ends_at: '2030-01-05T12:30:00Z',
  };
  assert.equal(visitOperation(v, new Date('2030-01-04')).action, null);
  assert.equal(visitOperation(v, new Date(v.starts_at)).action, 'handover');
  assert.equal(visitOperation(v, v.starts_at).action, 'handover');
  assert.equal(
    visitOperation({ ...v, state: 'handed_over' }, new Date('2030-01-06')).action,
    'return',
  );
  assert.equal(visitOperation({ ...v, state: 'returned' }).action, 'complete');
  for (const state of ['cancelled', 'completed', 'requested', 'disputed'])
    assert.equal(visitOperation({ ...v, state }).action, null);
  assert.equal(visitOperation({ ...v, hours_known: false }).action, null);
});
