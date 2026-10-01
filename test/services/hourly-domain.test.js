import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHourlyVisit,
  candidateStarts,
  dayKind,
  operatingWindows,
  priceGaps,
  priceHourlyVisit,
} from '../../src/services/domain/hourly.js';
import { hourlyBookingConfigSchema } from '../../src/services/schemas/zod/booking-config.js';
import { cancellationEntitlement } from '../../src/services/domain/cancellation.js';
import { CANCELLATION_TIERS_HOURLY } from '../../src/services/domain/pricing.js';
import { parseDiscoveryQuery, discoveryQuery } from '../../src/services/domain/discovery.js';

/** Entertainment plan, Phase 4: the pure time-booking rules. 2030-01-07 is a Monday, 2030-01-12 a Saturday. */
const late = [{ open: '06:00', close: '01:00', closesNextDay: true }];
const config = {
  model: 'hourly',
  timeZone: 'Asia/Kolkata',
  leadTimeMinutes: 30,
  bookingHorizonDays: 60,
  stepMinutes: 60,
  minDurationMinutes: 60,
  maxDurationMinutes: 180,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  weeklyHours: { mon: late, tue: late, wed: late, thu: late, fri: late, sat: late, sun: [] },
};
const now = new Date('2030-01-01T00:00:00Z');
const bands = [
  { dayKind: 'weekday', startMinute: 360, endMinute: 1080, hourlyRateMinor: 80000 },
  { dayKind: 'weekday', startMinute: 1080, endMinute: 1500, hourlyRateMinor: 120000 },
  { dayKind: 'weekend', startMinute: 360, endMinute: 1500, hourlyRateMinor: 140000 },
];

test('operating windows and start grid follow weekly hours, step and closing after midnight', () => {
  assert.deepEqual(operatingWindows(config, '2030-01-07'), [{ startMin: 360, endMin: 1500 }]);
  assert.deepEqual(operatingWindows(config, '2030-01-13'), [], 'Sunday closed');
  const starts = candidateStarts(config, '2030-01-07', 120);
  assert.equal(starts[0], 360);
  assert.equal(starts.at(-1), 1380, 'last 2h start is 23:00, ending 01:00 next day');
  const split = {
    ...config,
    stepMinutes: 30,
    weeklyHours: {
      ...config.weeklyHours,
      mon: [
        { open: '06:00', close: '11:00' },
        { open: '16:00', close: '22:00' },
      ],
    },
  };
  assert.equal(
    candidateStarts(split, '2030-01-07', 60).some((m) => m > 600 && m < 960),
    false,
    'no starts in a split-shift gap',
  );
});

test('visit validation: duration, step, opening hours, lead time, horizon; instants in IST', () => {
  const visit = buildHourlyVisit({
    date: '2030-01-07',
    start: '23:00',
    durationMinutes: 120,
    config,
    now,
  });
  assert.equal(visit.startsAt, '2030-01-07T17:30:00.000Z');
  assert.equal(visit.endsAt, '2030-01-07T19:30:00.000Z');
  assert.equal(visit.endsNextDay, true);
  const code = (args) => {
    try {
      buildHourlyVisit({
        date: '2030-01-07',
        start: '18:00',
        durationMinutes: 60,
        config,
        now,
        ...args,
      });
      return null;
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(code({ durationMinutes: 90 }), 'DURATION_INVALID');
  assert.equal(code({ durationMinutes: 240 }), 'DURATION_INVALID');
  assert.equal(code({ start: '18:30' }), 'START_INVALID');
  assert.equal(code({ start: '05:00' }), 'OUTSIDE_OPENING_HOURS');
  assert.equal(
    code({ start: '00:30' }),
    'OUTSIDE_OPENING_HOURS',
    'V1: no starts after midnight of the operating day',
  );
  assert.equal(
    code({ start: '00:00', date: '2030-01-08', durationMinutes: 60 }),
    'OUTSIDE_OPENING_HOURS',
  );
  assert.equal(code({ date: '2030-01-13' }), 'OUTSIDE_OPENING_HOURS');
  assert.equal(
    code({ now: new Date('2030-01-07T12:15:00Z') }),
    'OUTSIDE_BOOKING_WINDOW',
    '18:00 IST is 12:30Z; inside the 30 min lead time',
  );
  assert.equal(code({ date: '2030-03-11' }), 'OUTSIDE_BOOKING_WINDOW');
  const buffered = buildHourlyVisit({
    date: '2030-01-07',
    start: '18:00',
    durationMinutes: 60,
    config: { ...config, bufferAfterMinutes: 15 },
    now,
  });
  assert.equal(buffered.blockedEndAt, '2030-01-07T13:45:00.000Z');
});

test('pricing splits at band edges, uses the operating day kind, rounds half up once, and fails closed', () => {
  assert.equal(
    priceHourlyVisit({ bands, date: '2030-01-07', startMinute: 1020, durationMinutes: 120 })
      .rentMinor,
    200000,
  );
  assert.equal(
    priceHourlyVisit({ bands, date: '2030-01-12', startMinute: 1380, durationMinutes: 120 })
      .rentMinor,
    280000,
    'Saturday 23:00–01:00 is all weekend',
  );
  assert.equal(dayKind('2030-01-12'), 'weekend');
  const odd = [{ dayKind: 'weekday', startMinute: 0, endMinute: 1440, hourlyRateMinor: 99900 }];
  assert.equal(
    priceHourlyVisit({ bands: odd, date: '2030-01-07', startMinute: 600, durationMinutes: 90 })
      .rentMinor,
    149850,
  );
  const third = [{ dayKind: 'weekday', startMinute: 0, endMinute: 1440, hourlyRateMinor: 1 }];
  assert.equal(
    priceHourlyVisit({ bands: third, date: '2030-01-07', startMinute: 600, durationMinutes: 30 })
      .rentMinor,
    1,
    '0.5 paise rounds up',
  );
  assert.throws(
    () =>
      priceHourlyVisit({
        bands: bands.slice(1),
        date: '2030-01-07',
        startMinute: 600,
        durationMinutes: 60,
      }),
    (e) => e.code === 'PRICE_MISSING',
  );
});

test('price gaps list the open minutes an activity leaves unpriced', () => {
  const gaps = priceGaps(config, bands.slice(0, 2));
  assert.deepEqual(
    new Set(gaps.map((g) => g.day)),
    new Set(['sat']),
    'weekday bands cover Mon–Fri; Saturday has no weekend band here',
  );
  assert.deepEqual(priceGaps(config, bands), []);
});

test('hourly config schema enforces step alignment, durations, shifts and the after-midnight overlap', () => {
  assert.equal(hourlyBookingConfigSchema.safeParse(config).success, true);
  const issues = (patch) =>
    hourlyBookingConfigSchema
      .safeParse({ ...config, ...patch })
      .error?.issues.map((i) => i.message) ?? [];
  assert.match(issues({ minDurationMinutes: 240 }).join(), /exceeds/);
  assert.match(issues({ maxDurationMinutes: 150 }).join(), /multiples of 60/);
  assert.match(
    issues({
      weeklyHours: { ...config.weeklyHours, tue: [{ open: '00:30', close: '10:00' }] },
    }).join(),
    /overlaps tue/,
  );
  assert.match(
    issues({
      weeklyHours: {
        ...config.weeklyHours,
        mon: [{ open: '06:00', close: '07:00', closesNextDay: true }],
      },
    }).join(),
    /by 06:00/,
  );
  assert.match(
    issues({
      weeklyHours: Object.fromEntries(Object.keys(config.weeklyHours).map((d) => [d, []])),
    }).join(),
    /at least one day/,
  );
  assert.equal(
    hourlyBookingConfigSchema.safeParse({ ...config, slots: {} }).success,
    false,
    'strict: no slot keys',
  );
});

test('cancellation bands in hours for venues; day snapshots unchanged', () => {
  const visit = (hoursAhead, cancellation) => ({
    policy_snapshot: { version: 'customer-v1', cancellationTier: 'moderate', cancellation },
    hours_known: true,
    starts_at: new Date(now.getTime() + hoursAhead * 3_600_000).toISOString(),
    amount_rent_minor: 100000,
    amount_fee_minor: 8000,
    amount_deposit_minor: 0,
  });
  const hourly = {
    bandUnit: 'hours',
    bands: CANCELLATION_TIERS_HOURLY.moderate.bands,
    noShow: 0,
    feeOnFullRefund: false,
  };
  assert.equal(cancellationEntitlement(visit(24, hourly), now).rate, 1);
  assert.equal(cancellationEntitlement(visit(23.99, hourly), now).rate, 0.5);
  assert.equal(cancellationEntitlement(visit(5, hourly), now).rate, 0);
  const daily = {
    bands: [
      [7, 1],
      [3, 0.5],
      [0, 0],
    ],
    noShow: 0,
    feeOnFullRefund: false,
  };
  assert.equal(
    cancellationEntitlement(visit(24 * 4, daily), now).rate,
    0.5,
    'no bandUnit = days, as before',
  );
});

test('discovery query: farmhouse untouched by default, venue parameters parsed and serialised', () => {
  const farm = parseDiscoveryQuery({ slot: 'day', guests: '4', date: '2030-01-07' }, '2030-01-01');
  assert.equal(farm.filters.vertical, 'farmhouse');
  assert.equal(
    discoveryQuery(farm.filters),
    'mode=single&slot=day&guests=4&sort=recommended&page=1&dates=2030-01-07',
  );
  const venue = parseDiscoveryQuery(
    {
      vertical: 'entertainment',
      slot: 'night',
      mode: 'separate',
      dates: '2030-01-07,2030-01-08',
      start: '18:00',
      duration: '120',
      players: '10',
    },
    '2030-01-01',
  );
  assert.deepEqual(venue.errors, []);
  assert.deepEqual(
    [venue.filters.dates, venue.filters.slot, venue.filters.duration, venue.filters.players],
    [['2030-01-07'], '', 120, 10],
  );
  assert.equal(
    discoveryQuery(venue.filters),
    'vertical=entertainment&date=2030-01-07&start=18%3A00&duration=120&players=10&sort=recommended&page=1',
  );
  assert.match(
    parseDiscoveryQuery({ vertical: 'entertainment', start: '6pm' }).errors.join(),
    /HH:mm/,
  );
});
