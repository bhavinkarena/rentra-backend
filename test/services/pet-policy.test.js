import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_ALLOWED,
  effectivePetPolicy,
  normalizePetPolicy,
  petPolicyLine,
  petPolicyProblem,
  publicPetPolicy,
} from '../../src/services/domain/pet-policy.js';
import { petPolicySchema } from '../../src/services/schemas/zod/listing.js';
import { publicHouseRules } from '../../src/services/domain/listing-content.js';
import { prepareQuote } from '../../src/services/booking/quotes.js';

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

test('Story 3.8: lines for guests (no fee) and owners (fee)', () => {
  assert.equal(petPolicyLine(allowed), 'Pets allowed: up to 2 dogs or cats under 25 kg');
  assert.equal(
    petPolicyLine(allowed, { fee: true }),
    'Up to 2 dogs or cats, under 25 kg · ₹500 per pet per night',
  );
  assert.equal(
    petPolicyLine(effectivePetPolicy(null, true)),
    'Pets allowed: up to 1 dog, cat or small pet',
  );
  assert.equal(
    petPolicyLine(effectivePetPolicy(null, true), { fee: true }),
    'Up to 1 dog, cat or small pet · no pet fee',
  );
  assert.equal(petPolicyLine({ status: 'not_allowed' }), 'No pets');
  assert.deepEqual(publicPetPolicy(allowed), {
    status: 'allowed',
    maxPets: 2,
    types: ['cat', 'dog'],
    maxSize: 'medium',
  });
  assert.equal(
    publicHouseRules({ petsAllowed: true }, publicPetPolicy(allowed))[0],
    'Pets allowed: up to 2 dogs or cats under 25 kg',
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
  const q = (extra) =>
    prepareQuote(
      {
        rentableId: '00000000-0000-4000-8000-000000000001',
        dates: ['2030-01-04'],
        slot: 'day',
        guests: 2,
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
  assert.deepEqual(stamped.policy.petPolicy, { version: 4, policy: publicPetPolicy(allowed) });
  assert.equal(
    JSON.stringify(stamped).includes('per_pet_night'),
    false,
    'no fee in the guest payload',
  );
  // A fee-only change bumps the version on save, so the digest still moves.
  assert.notEqual(q({ pet_policy: allowed, pet_policy_version: 5 }).hash, stamped.hash);
  assert.deepEqual(q({ house_rules: { petsAllowed: true } }).policy.petPolicy, {
    version: 1,
    policy: publicPetPolicy(effectivePetPolicy(null, true)),
  });
});
