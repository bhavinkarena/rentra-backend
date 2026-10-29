import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_ALLOWED,
  effectivePetPolicy,
  normalizePetPolicy,
  petPolicyLine,
  petPolicyProblem,
  publicPetPolicy,
  petChargeMinor,
  petChargeParts,
  petConfirmationText,
  petProblem,
} from '../../src/services/domain/pet-policy.js';
import { petPolicySchema } from '../../src/services/schemas/zod/listing.js';
import { publicHouseRules } from '../../src/services/domain/listing-content.js';
import { prepareQuote } from '../../src/services/booking/quotes.js';
import { cancellationEntitlement } from '../../src/services/domain/cancellation.js';

const allowed = {
  status: 'allowed',
  maxPets: 2,
  types: ['cat', 'dog'],
  maxSize: 'medium',
  fee: { unit: 'per_pet_night', amount: 500 },
};

test('Story 3.8: legacy flags derive the effective policy', () => {
  assert.deepEqual(effectivePetPolicy(null, true), {
    status: 'allowed',
    maxPets: 1,
    types: ['dog', 'cat', 'small_other'],
    maxSize: 'any',
    fee: { unit: 'free', amount: 0 },
  });
  assert.deepEqual(effectivePetPolicy(null, false), { status: 'not_allowed' });
  assert.deepEqual(effectivePetPolicy(undefined, undefined), { status: 'not_allowed' });
  assert.equal(effectivePetPolicy(allowed, false), allowed);
  effectivePetPolicy(null, true).types.push('x');
  assert.equal(LEGACY_ALLOWED.types.length, 3, 'legacy default is not shared');
});

test('Story 3.8: validation names the problem', () => {
  assert.equal(petPolicyProblem(allowed), null);
  assert.equal(petPolicyProblem({ status: 'not_allowed' }), null);
  assert.equal(petPolicyProblem({ ...allowed, types: [] }), 'Choose at least one pet type');
  for (const bad of [
    { ...allowed, maxPets: 6 },
    { ...allowed, maxPets: 0 },
    { ...allowed, maxPets: 1.5 },
    { ...allowed, fee: { unit: 'per_stay', amount: 50001 } },
    { ...allowed, fee: { unit: 'per_stay', amount: -1 } },
    { ...allowed, fee: { unit: 'free', amount: 10 } },
    { ...allowed, fee: { unit: 'weekly', amount: 1 } },
    { ...allowed, types: ['horse'] },
    { ...allowed, types: ['dog', 'dog'] },
    { ...allowed, maxSize: 'large' },
    { status: 'on_request' },
    null,
  ])
    assert.ok(petPolicyProblem(bad), JSON.stringify(bad));
  assert.equal(
    petPolicySchema.safeParse({ ...allowed, types: [] }).error.issues[0].message,
    'Choose at least one pet type',
  );
  assert.deepEqual(petPolicySchema.parse({ status: 'not_allowed', maxPets: 3 }), {
    status: 'not_allowed',
  });
  assert.deepEqual(petPolicySchema.parse({ ...allowed, extra: 1 }).types, ['dog', 'cat']);
  assert.equal('extra' in normalizePetPolicy({ ...allowed, extra: 1 }), false);
});

test('Story 3.8/3.9: lines for guests (fee shown since 3.9) and owners', () => {
  assert.equal(
    petPolicyLine(allowed),
    'Pets allowed: up to 2 dogs or cats under 25 kg · ₹500 per pet per night',
  );
  assert.equal(
    petPolicyLine(allowed, { fee: true }),
    'Up to 2 dogs or cats, under 25 kg · ₹500 per pet per night',
  );
  assert.equal(
    petPolicyLine(effectivePetPolicy(null, true)),
    'Pets allowed: up to 1 dog, cat or small pet · no pet fee',
  );
  assert.equal(
    petPolicyLine(effectivePetPolicy(null, true), { fee: true }),
    'Up to 1 dog, cat or small pet · no pet fee',
  );
  assert.equal(petPolicyLine({ status: 'not_allowed' }), 'No pets');
  assert.deepEqual(publicPetPolicy(allowed), allowed);
  assert.equal(
    publicHouseRules({ petsAllowed: true }, publicPetPolicy(allowed))[0],
    'Pets allowed: up to 2 dogs or cats under 25 kg · ₹500 per pet per night',
  );
  assert.equal(publicHouseRules({ petsAllowed: true })[0], 'Pets allowed');
});

test('Story 3.8: farm quotes stamp the pet policy only when allowed', () => {
  const slot = {
    enabled: true,
    startTime: '09:00',
    endTime: '18:00',
    endDayOffset: 0,
    bufferBeforeMinutes: 30,
    bufferAfterMinutes: 30,
    capacity: 12,
    includedGuests: 2,
    extraGuestChargeMinor: 0,
  };
  const listing = (extra) => ({
    status: 'live',
    total_units: 1,
    capacity: 12,
    booking_config_version: 1,
    cancellation_tier: 'flexible',
    deposit_minor: 0,
    booking_config: {
      inventoryReady: true,
      timeZone: 'Asia/Kolkata',
      leadTimeMinutes: 60,
      bookingHorizonDays: 90,
      slots: { day: slot, night: { enabled: false }, full_day: { enabled: false } },
    },
    house_rules: { petsAllowed: false },
    pet_policy: null,
    pet_policy_version: 1,
    ...extra,
  });
  const q = (extra, choice = {}) =>
    prepareQuote(
      {
        rentableId: '00000000-0000-4000-8000-000000000001',
        dates: ['2030-01-04'],
        slot: 'day',
        guests: 2,
        ...choice,
      },
      listing(extra),
      [{ slot: 'day', weekday_minor: 100000, weekend_minor: 100000 }],
      [],
      { version: 1, provider: 'razorpay', environment: 'test', mode: 'real', enabled: true },
      new Date('2030-01-01T00:00:00Z'),
    );
  const none = q({});
  assert.equal(none.policy.petPolicy, undefined);
  assert.equal(q({ pet_policy: { status: 'not_allowed' }, pet_policy_version: 4 }).hash, none.hash);
  const stamped = q({ pet_policy: allowed, pet_policy_version: 4 });
  // Story 3.9 keeps this stamp fee-free (pre-3.9 shape and digest at zero pets); the fee is in `pets`.
  const { fee: _fee, ...limits } = allowed;
  assert.deepEqual(stamped.policy.petPolicy, { version: 4, policy: limits });
  assert.equal(JSON.stringify(stamped).includes('per_pet_night'), false, 'no fee without pets');
  // A fee-only change bumps the version on save, so the digest still moves.
  assert.notEqual(q({ pet_policy: allowed, pet_policy_version: 5 }).hash, stamped.hash);
  assert.deepEqual(q({ house_rules: { petsAllowed: true } }).policy.petPolicy, {
    version: 1,
    policy: (({ fee: _f, ...rest }) => rest)(effectivePetPolicy(null, true)),
  });
  // JSON null in the column means "no saved policy", like SQL NULL.
  assert.equal(effectivePetPolicy(JSON.parse('null'), true).status, 'allowed');
  assert.equal(effectivePetPolicy('null', true).status, 'allowed');

  // Story 3.9: farm pet charges are paid extras inside each visit's rent, before the one service fee.
  const two = { dates: ['2030-01-04', '2030-01-05'] };
  const withFee = (unit, amount, maxPets = 5) => ({
    pet_policy: { ...allowed, maxPets, fee: { unit, amount } },
  });
  const petMinors = (quote) => quote.visits.map((visit) => visit.petMinor ?? 0);
  const plain = q(withFee('per_pet', 200), two);
  assert.equal(
    q(withFee('per_pet', 200), { ...two, pets: 0 }).hash,
    plain.hash,
    'zero pets keeps the digest',
  );
  assert.equal(plain.totals.petMinor, undefined);
  assert.equal(plain.policy.pets, undefined);
  const perPet = q(withFee('per_pet', 200), { ...two, pets: 2 });
  // Review decision: once-only charges are spread over the visits (₹200 × 2 pets = ₹400 over 2 visits).
  assert.deepEqual(
    petMinors(perPet),
    [20000, 20000],
    'per pet is once per pet, spread over visits',
  );
  // Cancelling one visit refunds only that visit's share, at the visit's own proportional rule.
  const [first] = perPet.visits;
  const refund = cancellationEntitlement(
    {
      policy_snapshot: {
        version: 'customer-v1',
        cancellationTier: 'flexible',
        cancellationPolicy: {
          version: 1,
          windows: [{ hoursBefore: 0, pct: 50 }],
          atOrAfterCheckInPct: 0,
        },
      },
      hours_known: true,
      starts_at: first.startsAt,
      amount_rent_minor: first.rentMinor,
      amount_fee_minor: first.feeMinor,
      amount_deposit_minor: 0,
    },
    new Date('2030-01-01T00:00:00Z'),
  );
  assert.equal(
    refund.rent,
    Math.floor(first.rentMinor / 2),
    '50% of this visit (its ₹200 pet share included)',
  );
  assert.ok(first.rentMinor - first.petMinor === plain.visits[0].rentMinor);
  assert.equal(perPet.totals.petMinor, 40000);
  assert.equal(perPet.totals.rentMinor, plain.totals.rentMinor + 40000);
  assert.equal(
    perPet.totals.feeMinor,
    Math.floor((perPet.totals.rentMinor * 5 + 50) / 100),
    'one fee covers it',
  );
  assert.deepEqual(perPet.policy.pets, {
    count: 2,
    confirmed: false,
    confirmation: 'My pets are dogs or cats under 25 kg',
    unit: 'per_pet',
    amount: 200,
    totalMinor: 40000,
  });
  assert.equal(perPet.payment.expectedMinor > 0, true);
  assert.deepEqual(
    petMinors(q(withFee('per_night', 300), { ...two, pets: 1 })),
    [30000, 30000],
    'per night: each booked date',
  );
  const free = q(withFee('free', 0), { ...two, pets: 2 });
  assert.deepEqual(petMinors(free), [0, 0]);
  assert.equal(free.policy.pets.totalMinor, 0, 'free still records the declaration');
  assert.notEqual(
    free.hash,
    q(withFee('free', 0), { ...two, pets: 1 }).hash,
    'the count moves the digest',
  );
  assert.throws(() => q({ pet_policy: { status: 'not_allowed' } }, { pets: 1 }), {
    code: 'PETS_NOT_ALLOWED',
  });
  assert.throws(() => q(withFee('free', 0, 1), { pets: 2 }), {
    code: 'PETS_OVER_LIMIT',
    message: 'Up to 1 pet',
  });
});

test('Story 3.9: pet charge math and refusals', () => {
  const policy = (unit, amount = 300, maxPets = 5) => ({
    ...allowed,
    maxPets,
    fee: { unit, amount },
  });
  assert.equal(petChargeMinor(policy('free', 0), 2, 3), 0);
  assert.equal(petChargeMinor(policy('per_stay'), 2, 3), 30000);
  assert.equal(petChargeMinor(policy('per_night'), 2, 3), 90000);
  assert.equal(petChargeMinor(policy('per_pet'), 2, 3), 60000);
  assert.equal(petChargeMinor(policy('per_pet_night'), 1, 2), 60000);
  assert.equal(petChargeMinor(policy('per_pet_night'), 0, 2), 0);
  assert.deepEqual(petChargeParts(policy('per_pet', 200), 2, 2), [20000, 20000]);
  assert.deepEqual(
    petChargeParts(policy('per_stay', 1), 1, 3),
    [34, 33, 33],
    'earlier visits take the extra paise',
  );
  assert.deepEqual(petChargeParts(policy('per_night'), 1, 2), [30000, 30000]);
  assert.equal(petProblem({ status: 'not_allowed' }, 0), null);
  assert.equal(petProblem(policy('free', 0), 6).code, 'PETS_INVALID');
  assert.equal(petProblem(policy('free', 0), 1.5).code, 'PETS_INVALID');
  assert.equal(petProblem(policy('free', 0), '2').code, 'PETS_INVALID');
  assert.equal(petProblem({ status: 'not_allowed' }, 1).code, 'PETS_NOT_ALLOWED');
  assert.deepEqual(petProblem(policy('free', 0, 1), 2), {
    code: 'PETS_OVER_LIMIT',
    message: 'Up to 1 pet',
  });
  assert.equal(petProblem(policy('free', 0, 2), 2), null);
  assert.equal(
    petConfirmationText({ ...allowed, types: ['dog', 'cat', 'small_other'], maxSize: 'any' }),
    'My pets are dogs, cats or small pets',
  );
});
