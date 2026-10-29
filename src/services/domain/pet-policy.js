import { allocateByWeights } from './booking-money.js';
/**
 * Story 3.8: ordinary pet policy for a stay listing (farm/villa and hotel).
 * { status: 'allowed'|'not_allowed', maxPets: 1..5, types: ['dog'|'cat'|'small_other'], maxSize: 'small'|'medium'|'any',
 *   fee: { unit: 'free'|'per_stay'|'per_night'|'per_pet'|'per_pet_night', amount: whole rupees 0..50000 } }
 * Not allowed stores only { status }. Mirrored in Rentra/lib/domain/pet-policy.js.
 */
export const PET_TYPES = ['dog', 'cat', 'small_other'];
export const PET_SIZES = ['small', 'medium', 'any'];
export const PET_FEE_UNITS = ['free', 'per_stay', 'per_night', 'per_pet', 'per_pet_night'];
export const ASSISTANCE_ANIMALS_LINE = 'Assistance animals aren’t treated as pets and aren’t charged pet fees. Contact Rentra support before booking.';

/** What a legacy "pets allowed: yes" means (user decision 29 Oct 2026). */
export const LEGACY_ALLOWED = Object.freeze({ status: 'allowed', maxPets: 1, types: [...PET_TYPES], maxSize: 'any', fee: { unit: 'free', amount: 0 } });

/** The saved policy, or the one derived from the legacy yes/no flag when none is saved. */
export function effectivePetPolicy(petPolicy, legacyAllowed) {
  // A JSON null in the column is "no saved policy", like SQL NULL (the search filter agrees).
  if (petPolicy && typeof petPolicy === 'object') return petPolicy;
  return legacyAllowed ? structuredClone(LEGACY_ALLOWED) : { status: 'not_allowed' };
}

/** Why `policy` cannot be saved, or null. */
export function petPolicyProblem(policy) {
  if (!policy || typeof policy !== 'object') return 'Choose whether pets are allowed';
  if (policy.status === 'not_allowed') return null;
  if (policy.status !== 'allowed') return 'Choose whether pets are allowed';
  const { maxPets, types, maxSize, fee } = policy;
  if (!Number.isInteger(maxPets) || maxPets < 1 || maxPets > 5) return 'Allow from 1 to 5 pets';
  if (!Array.isArray(types) || !types.length) return 'Choose at least one pet type';
  if (types.some((t) => !PET_TYPES.includes(t)) || new Set(types).size !== types.length) return 'Choose dogs, cats or small pets';
  if (!PET_SIZES.includes(maxSize)) return 'Choose the largest pet size';
  if (!fee || !PET_FEE_UNITS.includes(fee.unit)) return 'Choose how the pet fee is charged';
  if (!Number.isInteger(fee.amount) || fee.amount < 0 || fee.amount > 50000) return 'Enter the pet fee in whole rupees from 0 to 50,000';
  if (fee.unit === 'free' && fee.amount !== 0) return 'A free pet policy has no fee';
  return null;
}

/** The stored form: exactly the policy fields, types in a fixed order. Call only on a valid policy. */
export function normalizePetPolicy(policy) {
  if (policy.status !== 'allowed') return { status: 'not_allowed' };
  return { status: 'allowed', maxPets: policy.maxPets, types: PET_TYPES.filter((t) => policy.types.includes(t)), maxSize: policy.maxSize,
    fee: { unit: policy.fee.unit, amount: policy.fee.amount } };
}

/** What guests see: since Story 3.9 charges the fee, the whole policy (not allowed stays bare). */
export function publicPetPolicy(policy) {
  return policy?.status === 'allowed' ? policy : { status: 'not_allowed' };
}

const NOUN = { dog: ['dog', 'dogs'], cat: ['cat', 'cats'], small_other: ['small pet', 'small pets'] };
const SIZE = { small: 'under 10 kg', medium: 'under 25 kg', any: '' };
const UNIT = { per_stay: 'per stay', per_night: 'per night', per_pet: 'per pet', per_pet_night: 'per pet per night' };

const list = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`);

/** "up to 2 dogs or cats under 25 kg" */
function limits(policy, sep = ' ') {
  const nouns = list(PET_TYPES.filter((t) => policy.types.includes(t)).map((t) => NOUN[t][policy.maxPets > 1 ? 1 : 0]));
  return [`up to ${policy.maxPets} ${nouns}`, SIZE[policy.maxSize]].filter(Boolean).join(sep);
}

export function petFeeText(fee) {
  if (!fee || fee.unit === 'free' || !fee.amount) return 'no pet fee';
  return `₹${fee.amount.toLocaleString('en-IN')} ${UNIT[fee.unit]}`;
}

/** Guest line (with the fee when the policy carries one, Story 3.9), or with { fee: true } the owner preview line. */
export function petPolicyLine(policy, { fee = false } = {}) {
  if (policy?.status !== 'allowed') return 'No pets';
  if (!fee) return `Pets allowed: ${limits(policy)}${policy.fee ? ` · ${petFeeText(policy.fee)}` : ''}`;
  const text = limits(policy, ', ');
  return `${text[0].toUpperCase()}${text.slice(1)} · ${petFeeText(policy.fee)}`;
}

/** Story 3.9: why `pets` cannot be booked under `policy`, as { code, message }, or null. */
export function petProblem(policy, pets) {
  if (pets != null && (!Number.isInteger(pets) || pets < 0 || pets > 5)) return { code: 'PETS_INVALID', message: 'Choose 0–5 pets.' };
  if (!pets) return null;
  if (policy?.status !== 'allowed') return { code: 'PETS_NOT_ALLOWED', message: 'This stay doesn’t allow pets' };
  if (pets > policy.maxPets) return { code: 'PETS_OVER_LIMIT', message: `Up to ${policy.maxPets} ${policy.maxPets === 1 ? 'pet' : 'pets'}` };
  return null;
}

const PER_UNIT = ['per_night', 'per_pet_night'];
/**
 * Story 3.9: the pet charge in paise split over `units` (hotel nights or farm booked dates):
 * per-unit fees on every unit; once-only fees (per_stay, per_pet) spread over the units by largest
 * remainder (earlier units take the extra paise), so cancelling one farm visit refunds only its share.
 * Call after petProblem.
 */
export function petChargeParts(policy, pets, units) {
  const parts = Array(units).fill(0);
  if (!pets || policy?.status !== 'allowed' || policy.fee.unit === 'free' || !units) return parts;
  const once = policy.fee.amount * 100 * (policy.fee.unit.startsWith('per_pet') ? pets : 1);
  if (PER_UNIT.includes(policy.fee.unit)) return parts.fill(once);
  return allocateByWeights(once, parts.map(() => 1));
}

export const petChargeMinor = (policy, pets, units) => petChargeParts(policy, pets, units).reduce((a, b) => a + b, 0);

/** The one confirmation a guest ticks, from the listing's own rule ("My pets are dogs or cats under 25 kg"). */
export function petConfirmationText(policy) {
  const nouns = list(PET_TYPES.filter((t) => policy.types.includes(t)).map((t) => NOUN[t][1]));
  return ['My pets are', nouns, SIZE[policy.maxSize]].filter(Boolean).join(' ');
}

/**
 * Story 3.9: the quote's pet declaration, or {} for zero pets so old quotes keep their shape and digest.
 * Throws a { code, message } refusal through `fail`.
 */
export function petDeclaration(policy, pets, units, fail) {
  const problem = petProblem(policy, pets);
  if (problem) throw fail(problem.code, problem.message);
  if (!pets) return {};
  const parts = petChargeParts(policy, pets, units);
  return { pets: { count: pets, confirmed: false, confirmation: petConfirmationText(policy), unit: policy.fee.unit, amount: policy.fee.amount,
    totalMinor: parts.reduce((a, b) => a + b, 0) }, parts };
}
