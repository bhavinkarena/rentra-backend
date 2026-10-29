import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HotelError, priceRoomStay, roomOccupancy } from '../../src/services/domain/hotel.js';
import {
  bandFor,
  effectiveChildPolicy,
  fallbackPolicy,
  policyProblem,
} from '../../src/services/domain/child-policy.js';
import { childPolicySchema, hotelRoomSchema } from '../../src/services/schemas/zod/listing.js';

/** Story 3.6: explicit child bands, adult-rate minors, cots. */
const policy = {
  adultRateFromAge: 12,
  bands: [
    { kind: 'infant', fromAge: 0, toAge: 1, rule: { type: 'free', amount: 0 } },
    { kind: 'child', fromAge: 2, toAge: 11, rule: { type: 'fixed', amount: 500 } },
  ],
};
const room = {
  name: 'Deluxe',
  maxAdults: 2,
  maxChildren: 2,
  maxOccupancy: 3,
  baseOccupancy: 2,
  extraAdultMinor: 70000,
  extraChildMinor: 40000,
  beds: [{ type: 'king', count: 1 }],
  extraPlaces: [],
  cots: { count: 0 },
  childPolicy: { version: 1, source: 'property', policy },
};
const plan = { id: 'base', derivedFrom: null, weekdayMinor: 300000, weekendMinor: 300000 };
const slabs = [
  {
    minRateMinor: 0,
    maxRateMinor: null,
    taxBps: 0,
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
  },
];
const price = (roomType, adults, childAges) =>
  priceRoomStay({
    nights: ['2030-01-08', '2030-01-09'],
    roomType,
    plan,
    basePlan: plan,
    overrides: {},
    hotel: { weekendNights: [], childFreeAge: 6 },
    slabs,
    adults,
    childAges,
  });
const rejects = (fn, code, message) =>
  assert.throws(
    fn,
    (e) => e instanceof HotelError && e.code === code && (!message || e.message === message),
  );

test('policy validation: exact cover, ordered, named gaps and overlaps', () => {
  assert.equal(policyProblem(policy), null);
  assert.equal(childPolicySchema.safeParse(policy).success, true);
  const gap = { ...policy, bands: [policy.bands[0], { ...policy.bands[1], fromAge: 3 }] };
  assert.equal(policyProblem(gap), 'Age 2 is not covered');
  const overlap = {
    adultRateFromAge: 12,
    bands: [
      { ...policy.bands[1], fromAge: 0, toAge: 5 },
      { ...policy.bands[1], fromAge: 4, toAge: 11 },
    ],
  };
  assert.match(policyProblem(overlap), /two bands/);
  assert.equal(childPolicySchema.safeParse(overlap).success, false);
  assert.equal(
    policyProblem({ adultRateFromAge: 12, bands: [policy.bands[0]] }),
    'Ages 2-11 are not covered',
  );
  assert.equal(
    policyProblem({
      adultRateFromAge: 12,
      bands: [policy.bands[1], { ...policy.bands[0], fromAge: 12, toAge: 13 }],
    }),
    'Infant bands come before child bands',
  );
  const percent = {
    ...policy,
    bands: [policy.bands[0], { ...policy.bands[1], rule: { type: 'percent', amount: 25 } }],
  };
  assert.equal(childPolicySchema.safeParse(percent).success, false);
  const missing = childPolicySchema.safeParse(gap);
  assert.equal(missing.error.issues[0].message, 'Age 2 is not covered');
});

test('policy validation: blanks, ranges, free price and order are named', () => {
  const [infant, child] = policy.bands;
  assert.equal(
    policyProblem({ ...policy, bands: [{ ...infant, toAge: '' }, child] }),
    'Enter every age as a whole year from 0 to 17',
  );
  assert.match(
    policyProblem({
      ...policy,
      bands: [infant, { ...child, rule: { type: 'fixed', amount: 1.5 } }],
    }),
    /whole rupees/,
  );
  assert.equal(
    policyProblem({ ...policy, bands: [{ ...infant, rule: { type: 'free', amount: 5 } }, child] }),
    'A free band has no price',
  );
  assert.equal(
    policyProblem({ ...policy, bands: [child, infant] }),
    'List the bands from youngest to oldest',
  );
  assert.equal(
    policyProblem({
      ...policy,
      bands: [
        { ...child, fromAge: 0, toAge: 1 },
        { ...infant, fromAge: 2, toAge: 11 },
      ],
    }),
    'Infant bands come before child bands',
  );
  assert.equal(
    policyProblem({ ...policy, bands: [{ ...infant, toAge: 18 }] }),
    'Enter every age as a whole year from 0 to 17',
  );
});

test('fallback derives today’s rule; existing quotes are identical', () => {
  const fallback = fallbackPolicy(6, 40000);
  assert.deepEqual(
    fallback.bands.map((b) => [b.kind, b.fromAge, b.toAge, b.rule.type, b.rule.amount]),
    [
      ['infant', 0, 5, 'free', 0],
      ['child', 6, 17, 'fixed', 400],
    ],
  );
  assert.equal(
    effectiveChildPolicy({ childFreeAge: 6 }, { extraChildMinor: 40000 }).source,
    'property',
  );
  const legacy = { ...room, maxAdults: 3, maxOccupancy: 4, beds: [], childPolicy: undefined };
  // Old rule: 3 adults + age 8 with base 2 → one extra adult (70000) + one extra child (40000) per night.
  assert.equal(price(legacy, 3, [8]).nights[0].rateMinor, 300000 + 70000 + 40000);
  assert.equal(price(legacy, 2, [4]).nights[0].rateMinor, 300000);
  const derived = {
    ...legacy,
    childPolicy: {
      version: 1,
      ...effectiveChildPolicy({ childFreeAge: 6 }, { extraChildMinor: 40000 }),
    },
  };
  for (const [adults, ages] of [
    [3, [8]],
    [2, [4]],
    [1, [10, 12]],
    [2, [0, 17]],
  ]) {
    assert.deepEqual(price(derived, adults, ages).nights, price(legacy, adults, ages).nights);
  }
});

test('a 13-year-old with adult rate from 12 pays the extra adult price but is not an adult', () => {
  const stay = price(room, 2, [13]);
  assert.equal(stay.nights[0].rateMinor, 300000 + 70000);
  assert.equal(stay.occupancy.extraAdults, 1);
  // maxAdults 2 is still satisfied: the minor is a child for capacity and supervision.
  assert.doesNotThrow(() => roomOccupancy(room, { adults: 2, childAges: [13] }, policy));
  rejects(() => roomOccupancy(room, { adults: 0, childAges: [13] }, policy), 'OCCUPANCY');
  assert.equal(bandFor(policy, 13), null);
});

test('a fixed-band child beyond base pays the band amount per night', () => {
  assert.equal(price(room, 2, [5]).nights[0].rateMinor, 300000 + 50000);
  assert.equal(price(room, 1, [5]).nights[0].rateMinor, 300000);
  assert.equal(price(room, 2, [1]).nights[0].rateMinor, 300000);
});

test('a room override applies over the property default', () => {
  const free = {
    adultRateFromAge: 18,
    bands: [{ kind: 'child', fromAge: 0, toAge: 17, rule: { type: 'free', amount: 0 } }],
  };
  const resolved = effectiveChildPolicy({ childPolicy: policy }, { childPolicy: free });
  assert.equal(resolved.source, 'room');
  assert.equal(
    price({ ...room, childPolicy: { version: 2, ...resolved } }, 2, [5]).nights[0].rateMinor,
    300000,
  );
});

test('cots: overflow infants need a cot; a priced cot is a nightly charge', () => {
  rejects(() => price(room, 2, [0, 1]), 'COT_UNAVAILABLE', 'Deluxe has no cot for infant 1');
  const free = price({ ...room, cots: { count: 1, amount: 0 } }, 2, [0, 1]);
  assert.equal(free.nights[0].rateMinor, 300000);
  assert.deepEqual(free.cots, { count: 1, amount: 0 });
  const paid = price({ ...room, cots: { count: 1, amount: 300 } }, 2, [0, 1]);
  assert.deepEqual(
    paid.nights.map((n) => [n.rateMinor, n.cotMinor]),
    [
      [330000, 30000],
      [330000, 30000],
    ],
  );
  // Overflow by a non-infant is not a cot case.
  rejects(() => price({ ...room, cots: { count: 1 } }, 2, [5, 6]), 'OCCUPANCY');
});

test('room schema takes an override and cots; percent and bad cots are refused', () => {
  const base = {
    name: 'Deluxe',
    beds: [{ type: 'king', count: 1 }],
    maxAdults: 2,
    maxChildren: 2,
    maxOccupancy: 3,
    baseOccupancy: 2,
    roomCount: 2,
    extraAdult: 700,
    extraChild: 400,
    sortOrder: 0,
  };
  const parsed = hotelRoomSchema.parse({
    ...base,
    childPolicy: policy,
    cots: { count: 1, amount: 300 },
  });
  assert.deepEqual(parsed.cots, { count: 1, amount: 300 });
  assert.equal(hotelRoomSchema.parse(base).childPolicy, null);
  assert.equal(hotelRoomSchema.safeParse({ ...base, cots: { count: 5 } }).success, false);
});
