import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HotelError,
  hotelRefund,
  noShowCharge,
  planNightRate,
  priceRoomStay,
  roomOccupancy,
  roomTypeAvailability,
  stayInstants,
  stayNights,
  taxBpsFor,
} from '../../src/services/domain/hotel.js';

/** Hotel plan, Phase 2: the pure stay rules. 2030-01-11 is a Friday; Fri and Sat nights are weekend. */
const now = new Date('2030-01-01T06:30:00Z');
const slabs = [
  {
    minRateMinor: 0,
    maxRateMinor: 750000,
    taxBps: 500,
    effectiveFrom: '2025-09-22',
    effectiveTo: null,
  },
  {
    minRateMinor: 750001,
    maxRateMinor: null,
    taxBps: 1800,
    effectiveFrom: '2025-09-22',
    effectiveTo: null,
  },
];
const hotel = { weekendNights: [5, 6], childFreeAge: 6 };
const deluxe = {
  id: 'deluxe',
  name: 'Deluxe',
  maxAdults: 3,
  maxChildren: 2,
  maxOccupancy: 4,
  baseOccupancy: 2,
  roomCount: 12,
  extraAdultMinor: 70000,
  extraChildMinor: 40000,
  beds: [{ type: 'king', count: 1 }],
  extraPlaces: [{ type: 'extra_bed', count: 1 }],
};
const base = { id: 'base', derivedFrom: null, weekdayMinor: 260000, weekendMinor: 300000 };
const breakfast = { id: 'bf', derivedFrom: 'base', derivedPctBps: 0, derivedPerGuestMinor: 25000 };
const nonRefundable = {
  id: 'nr',
  derivedFrom: 'base',
  derivedPctBps: -1000,
  derivedPerGuestMinor: 0,
};
const rejects = (fn, code) =>
  assert.throws(fn, (error) => error instanceof HotelError && error.code === code);

test('a stay occupies the nights from check-in up to check-out, inside the booking window', () => {
  assert.deepEqual(stayNights('2030-01-10', '2030-01-13', now), [
    '2030-01-10',
    '2030-01-11',
    '2030-01-12',
  ]);
  rejects(() => stayNights('2030-01-10', '2030-01-10', now), 'DATES_INVALID');
  rejects(() => stayNights('2030-01-10', '2030-02-10', now), 'DATES_INVALID');
  rejects(() => stayNights('2029-12-31', '2030-01-02', now), 'OUTSIDE_BOOKING_WINDOW');
  assert.equal(stayNights('2030-01-01', '2030-01-02', now).length, 1, 'tonight is bookable');
  assert.deepEqual(
    stayInstants({
      checkIn: '2030-01-10',
      checkOut: '2030-01-12',
      checkInMinute: 720,
      checkOutMinute: 660,
    }),
    {
      startsAt: '2030-01-10T06:30:00.000Z',
      endsAt: '2030-01-12T05:30:00.000Z',
    },
  );
});

test('occupancy: children under the free age are free; base occupancy covers adults first', () => {
  assert.deepEqual(roomOccupancy(deluxe, { adults: 2, childAges: [4] }, 6), {
    guests: 3,
    chargedGuests: 2,
    extraAdults: 0,
    extraChildren: 0,
    childMinor: 0,
    cots: 0,
  });
  assert.deepEqual(roomOccupancy(deluxe, { adults: 3, childAges: [8] }, 6), {
    guests: 4,
    chargedGuests: 4,
    extraAdults: 1,
    extraChildren: 1,
    childMinor: deluxe.extraChildMinor,
    cots: 0,
  });
  assert.deepEqual(roomOccupancy(deluxe, { adults: 1, childAges: [10, 12] }, 6), {
    guests: 3,
    chargedGuests: 3,
    extraAdults: 0,
    extraChildren: 1,
    childMinor: deluxe.extraChildMinor,
    cots: 0,
  });
  rejects(() => roomOccupancy(deluxe, { adults: 4 }, 6), 'OCCUPANCY');
  rejects(() => roomOccupancy(deluxe, { adults: 3, childAges: [2, 3] }, 6), 'COT_UNAVAILABLE');
  rejects(() => roomOccupancy(deluxe, { adults: 3, childAges: [7, 8] }, 6), 'OCCUPANCY');
  rejects(() => roomOccupancy(deluxe, { adults: 2, childAges: [18] }, 6), 'OCCUPANCY');
});

test('plan rates: weekday, weekend, date override, derived plans', () => {
  const rate = (plan, night, overrides = {}, chargedGuests = 2) =>
    planNightRate({
      plan,
      basePlan: base,
      overrides,
      night,
      weekendNights: hotel.weekendNights,
      chargedGuests,
    });
  assert.deepEqual(rate(base, '2030-01-10'), {
    rateMinor: 260000,
    roomOnlyMinor: 260000,
    source: 'weekday',
  });
  assert.deepEqual(rate(base, '2030-01-11'), {
    rateMinor: 300000,
    roomOnlyMinor: 300000,
    source: 'weekend',
  });
  assert.deepEqual(rate(base, '2030-01-10', { '2030-01-10': 340000 }), {
    rateMinor: 340000,
    roomOnlyMinor: 340000,
    source: 'override',
  });
  assert.equal(rate(breakfast, '2030-01-10').rateMinor, 310000, 'breakfast adds per charged guest');
  assert.equal(
    rate(breakfast, '2030-01-10', { '2030-01-10': 340000 }).rateMinor,
    390000,
    'derived plans follow overrides',
  );
  assert.equal(rate(nonRefundable, '2030-01-10').rateMinor, 234000);
  assert.equal(
    planNightRate({
      plan: nonRefundable,
      basePlan: { ...base, weekdayMinor: 99999 },
      night: '2030-01-10',
      weekendNights: [5, 6],
      chargedGuests: 1,
    }).rateMinor,
    89999,
    'the discount rounds half up (₹99.999 off)',
  );
  rejects(
    () =>
      planNightRate({
        plan: breakfast,
        basePlan: { ...breakfast, id: 'base' },
        night: '2030-01-10',
        weekendNights: [],
        chargedGuests: 2,
      }),
    'PRICE_MISSING',
  );
});

test('tax slab boundary: ₹7,500 is 5%, ₹7,500.01 is 18%; no slab means no quote', () => {
  assert.equal(taxBpsFor(750000, '2030-01-10', slabs), 500);
  assert.equal(taxBpsFor(750001, '2030-01-10', slabs), 1800);
  assert.equal(taxBpsFor(0, '2030-01-10', slabs), 500);
  rejects(() => taxBpsFor(100000, '2025-09-21', slabs), 'TAX_UNCONFIGURED');
});

test('a derived plan or extra guest can push one night across the slab', () => {
  const nights = ['2030-01-10', '2030-01-11'];
  const near = { ...base, weekdayMinor: 720000, weekendMinor: 760000 };
  const stay = priceRoomStay({
    nights,
    roomType: deluxe,
    plan: base,
    basePlan: base,
    overrides: {},
    hotel,
    slabs,
    adults: 2,
    childAges: [],
  });
  assert.deepEqual(
    stay.nights.map((n) => [n.rateMinor, n.taxBps, n.taxMinor]),
    [
      [260000, 500, 13000],
      [300000, 500, 15000],
    ],
  );
  assert.equal(stay.totalMinor, stay.roomMinor + stay.taxMinor);
  assert.equal(
    stay.roomMinor,
    stay.nights.reduce((sum, n) => sum + n.rateMinor, 0),
  );
  const extra = priceRoomStay({
    nights,
    roomType: deluxe,
    plan: near,
    basePlan: near,
    overrides: {},
    hotel,
    slabs,
    adults: 3,
    childAges: [],
  });
  assert.deepEqual(
    extra.nights.map((n) => [n.rateMinor, n.taxBps]),
    [
      [790000, 1800],
      [830000, 1800],
    ],
    'extra adult moves ₹7,200 to ₹7,900 → 18%',
  );
  const plain = priceRoomStay({
    nights,
    roomType: deluxe,
    plan: near,
    basePlan: near,
    overrides: {},
    hotel,
    slabs,
    adults: 2,
    childAges: [],
  });
  assert.deepEqual(
    plain.nights.map((n) => n.taxBps),
    [500, 1800],
    'one stay can mix slabs night by night',
  );
});

test('property: quote totals always equal the sum of nights, tax never above 18%', () => {
  let seed = 7;
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % max;
  };
  for (let run = 0; run < 500; run += 1) {
    const plan = {
      id: 'p',
      derivedFrom: null,
      weekdayMinor: 30000 + random(1500000),
      weekendMinor: 30000 + random(1500000),
    };
    const length = 1 + random(10);
    const nights = Array.from({ length }, (_, i) => `2030-02-${String(1 + i).padStart(2, '0')}`);
    const overrides = random(2) ? { [nights[0]]: 30000 + random(1500000) } : {};
    const stay = priceRoomStay({
      nights,
      roomType: deluxe,
      plan,
      basePlan: plan,
      overrides,
      hotel,
      slabs,
      adults: 1 + random(3),
      childAges: random(2) ? [random(18)] : [],
    });
    assert.equal(
      stay.roomMinor,
      stay.nights.reduce((sum, n) => sum + n.rateMinor, 0),
    );
    assert.equal(
      stay.taxMinor,
      stay.nights.reduce((sum, n) => sum + n.taxMinor, 0),
    );
    for (const n of stay.nights) {
      assert.equal(n.taxBps, n.rateMinor <= 750000 ? 500 : 1800);
      assert.ok(n.taxMinor <= Math.ceil(n.rateMinor * 0.18));
    }
  }
});

test('cancellation: free before the deadline, late charge after, nothing once the stay starts', () => {
  const line = {
    totalMinor: 651000,
    nights: [
      { rateMinor: 310000, taxMinor: 15500 },
      { rateMinor: 310000, taxMinor: 15500 },
    ],
  };
  const checkIn = '2030-01-10T06:30:00.000Z';
  const flexible = {
    ...line,
    plan: { freeCancelHours: 48, lateCharge: 'first_night', noShow: 'first_night' },
  };
  assert.deepEqual(hotelRefund(flexible, checkIn, '2030-01-08T06:30:00.000Z'), {
    refundMinor: 651000,
    chargeMinor: 0,
    free: true,
  });
  assert.deepEqual(hotelRefund(flexible, checkIn, '2030-01-08T06:30:00.001Z'), {
    refundMinor: 325500,
    chargeMinor: 325500,
    free: false,
  });
  const strict = {
    ...line,
    plan: { freeCancelHours: null, lateCharge: 'full_stay', noShow: 'full_stay' },
  };
  assert.deepEqual(hotelRefund(strict, checkIn, '2030-01-01T00:00:00.000Z'), {
    refundMinor: 0,
    chargeMinor: 651000,
    free: false,
  });
  rejects(() => hotelRefund(flexible, checkIn, checkIn), 'STAY_STARTED');
  assert.equal(noShowCharge(flexible), 325500);
  assert.equal(noShowCharge(strict), 651000);
});

test('availability is the tightest night; stop-sell, arrival rules and minimum nights', () => {
  const nights = ['2030-01-10', '2030-01-11', '2030-01-12'];
  const row = (night, extra) => ({
    night,
    allotment: 12,
    sold: 0,
    held: 0,
    stopSell: false,
    closedToArrival: false,
    minNights: null,
    ...extra,
  });
  assert.deepEqual(roomTypeAvailability({ roomCount: 12, nights, nightRows: [] }), {
    available: 12,
    reason: null,
  });
  assert.deepEqual(
    roomTypeAvailability({
      roomCount: 12,
      nights,
      nightRows: [row('2030-01-11', { sold: 9, held: 1 })],
    }),
    { available: 2, reason: null },
  );
  assert.deepEqual(
    roomTypeAvailability({
      roomCount: 12,
      nights,
      nightRows: [row('2030-01-12', { allotment: 4, sold: 4 })],
    }),
    { available: 0, reason: 'SOLD_OUT' },
  );
  assert.deepEqual(
    roomTypeAvailability({
      roomCount: 12,
      nights,
      nightRows: [row('2030-01-11', { stopSell: true })],
    }),
    { available: 0, reason: 'CLOSED' },
  );
  assert.deepEqual(
    roomTypeAvailability({
      roomCount: 12,
      nights,
      nightRows: [row('2030-01-10', { closedToArrival: true })],
    }).reason,
    'CLOSED_TO_ARRIVAL',
  );
  assert.equal(
    roomTypeAvailability({
      roomCount: 12,
      nights,
      nightRows: [row('2030-01-11', { closedToArrival: true })],
    }).available,
    12,
    'only the arrival night',
  );
  assert.equal(
    roomTypeAvailability({
      roomCount: 12,
      nights,
      nightRows: [row('2030-01-10', { minNights: 4 })],
    }).reason,
    'MIN_NIGHTS',
  );
  assert.equal(
    roomTypeAvailability({ roomCount: 12, nights, nightRows: [], minNights: 4 }).reason,
    'MIN_NIGHTS',
  );
});

test('Story 3.4: bedding per night only for adults the beds cannot hold', () => {
  const nights = ['2030-01-10', '2030-01-11']; // weekday, weekend
  const room = (extra) => ({
    ...deluxe,
    beds: [{ type: 'double', count: 1 }],
    extraAdultMinor: 0,
    ...extra,
  });
  const price = (roomType, adults, plan = base) =>
    priceRoomStay({
      nights,
      roomType,
      plan,
      basePlan: base,
      overrides: {},
      hotel,
      slabs,
      adults,
      childAges: [],
    });
  const bed500 = [{ type: 'extra_bed', count: 1, charge: { mode: 'fixed', amount: 500 } }];
  // Double, 2 adults: nothing.
  assert.equal(price(room({ extraPlaces: bed500 }), 2).bedding, undefined);
  // Double + single, 3 adults: nothing.
  assert.equal(
    price(
      room({
        beds: [
          { type: 'double', count: 1 },
          { type: 'single', count: 1 },
        ],
        extraPlaces: bed500,
      }),
      3,
    ).bedding,
    undefined,
  );
  // Double + extra bed ₹500, 3 adults: +50000 each night, taxed.
  const fixed = price(room({ extraPlaces: bed500 }), 3);
  assert.deepEqual(
    fixed.nights.map((n) => [n.rateMinor, n.beddingMinor, n.taxMinor]),
    [
      [310000, 50000, 15500],
      [350000, 50000, 17500],
    ],
  );
  assert.deepEqual(fixed.bedding, [{ type: 'extra_bed', count: 1, mode: 'fixed', amount: 500 }]);
  // 10% of the room-only rate (derived plan's meals and per-guest charge excluded): 4000 / 6000 → 400 / 600.
  const pct = { ...base, weekdayMinor: 400000, weekendMinor: 600000 };
  const tenPct = priceRoomStay({
    nights,
    roomType: room({
      extraPlaces: [{ type: 'extra_bed', count: 1, charge: { mode: 'percent', amount: 10 } }],
    }),
    plan: breakfast,
    basePlan: pct,
    overrides: {},
    hotel,
    slabs,
    adults: 3,
    childAges: [],
  });
  assert.deepEqual(
    tenPct.nights.map((n) => n.beddingMinor),
    [40000, 60000],
  );
  // Mattress ₹300 + extra bed ₹500, one needed: the mattress.
  const cheap = price(
    room({
      extraPlaces: [
        ...bed500,
        { type: 'mattress', count: 1, charge: { mode: 'fixed', amount: 300 } },
      ],
    }),
    3,
  );
  assert.deepEqual(cheap.bedding, [{ type: 'mattress', count: 1, mode: 'fixed', amount: 300 }]);
  // Extra adult ₹800 includes bedding: no bedding; unticked: both.
  const paid = { extraAdultMinor: 80000, baseOccupancy: 2, extraPlaces: bed500 };
  const ticked = price(room({ ...paid, extraAdultIncludesBedding: true }), 3);
  assert.equal(ticked.bedding, undefined);
  assert.equal(ticked.nights[0].rateMinor, 340000);
  assert.equal(
    price(room({ ...paid, extraAdultIncludesBedding: false }), 3).nights[0].rateMinor,
    390000,
  );
  // Old room 1 king max 3, no places.
  rejects(
    () => price(room({ beds: [{ type: 'king', count: 1 }], extraPlaces: [] }), 3),
    'BEDDING_UNAVAILABLE',
  );
  // A pre-3.4 place without a charge is free.
  const free = price(room({ extraPlaces: [{ type: 'extra_bed', count: 1 }] }), 3);
  assert.equal(free.nights[0].rateMinor, 260000);
  assert.equal(free.nights[0].beddingMinor, undefined);
  assert.equal(free.bedding, undefined, 'a free place keeps the old quote shape');
  // Mixed fixed/percent: mattress ₹500 vs bed 10% of 4000/6000 → bed on weekday (400), mattress on weekend (500).
  const mixed = priceRoomStay({
    nights,
    roomType: room({
      extraPlaces: [
        { type: 'extra_bed', count: 1, charge: { mode: 'percent', amount: 10 } },
        { type: 'mattress', count: 1, charge: { mode: 'fixed', amount: 500 } },
      ],
    }),
    plan: { ...base, weekdayMinor: 400000, weekendMinor: 600000 },
    basePlan: { ...base, weekdayMinor: 400000, weekendMinor: 600000 },
    overrides: {},
    hotel,
    slabs,
    adults: 3,
    childAges: [],
  });
  assert.deepEqual(
    mixed.nights.map((n) => n.beddingMinor),
    [40000, 50000],
  );
  assert.deepEqual(mixed.bedding.map((b) => b.type).sort(), ['extra_bed', 'mattress']);
});
