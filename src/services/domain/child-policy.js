/**
 * Story 3.6: explicit child age bands. A policy is
 * { adultRateFromAge: 2..18, bands: [{ kind: 'infant'|'child', fromAge, toAge, rule: { type: 'free'|'fixed'|'percent', amount } }] }
 * (fixed: whole rupees per child per night; percent, child bands only: % of the room-only night ÷ room adults, Story 3.7). Bands cover 0 .. adultRateFromAge-1 exactly; minors at or above
 * adultRateFromAge pay the extra adult rate but stay children. Mirrored in Rentra/lib/domain/hotel-ui.js.
 */
const ages = (from, to) => (from === to ? `Age ${from} is` : `Ages ${from}-${to} are`);

/** Why `policy` cannot be saved, or null. Checks types and ranges itself, so the owner form can share it. */
export function policyProblem(policy) {
  const { adultRateFromAge: top, bands = [] } = policy ?? {};
  if (!Number.isInteger(top) || top < 2 || top > 18) return 'Adult rate starts between age 2 and 18';
  if (!Array.isArray(bands) || !bands.length) return `${ages(0, top - 1)} not covered`;
  for (const [index, band] of bands.entries()) {
    if (!['infant', 'child'].includes(band.kind)) return 'Choose infant or child for each band';
    if (![band.fromAge, band.toAge].every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) return 'Enter every age as a whole year from 0 to 17';
    if (band.toAge < band.fromAge) return `Band ${band.fromAge}-${band.toAge} ends before it starts`;
    const { type, amount } = band.rule ?? {};
    if (type === 'free' && amount !== 0) return 'A free band has no price';
    if (type === 'fixed' && !(Number.isInteger(amount) && amount >= 0 && amount <= 50000)) return 'Enter each band’s price in whole rupees from 0 to 50,000';
    if (type === 'percent' && band.kind !== 'child') return 'Infant bands are free or a fixed price';
    if (type === 'percent' && !(Number.isInteger(amount) && amount >= 1 && amount <= 100)) return 'Enter each band’s percent as a whole number from 1 to 100';
    if (!['free', 'fixed', 'percent'].includes(type)) return 'Choose free, a fixed price or a percent for each band';
    const prev = bands[index - 1];
    if (prev && band.fromAge < prev.fromAge) return 'List the bands from youngest to oldest';
    if (prev && band.kind === 'infant' && prev.kind === 'child') return 'Infant bands come before child bands';
  }
  let next = 0;
  for (const band of bands) {
    if (band.fromAge > next) return `${ages(next, band.fromAge - 1)} not covered`;
    if (band.fromAge < next) return `Ages ${band.fromAge}-${Math.min(band.toAge, next - 1)} are in two bands`;
    next = band.toAge + 1;
  }
  if (next > top) return `Ages ${top}-${next - 1} already pay the adult rate`;
  if (next < top) return `${ages(next, top - 1)} not covered`;
  return null;
}

/** Hotels without a saved policy keep their old pricing: under childFreeAge free, then the room's extra child price. */
export function fallbackPolicy(childFreeAge, extraChildMinor = 0) {
  const free = Math.min(Math.max(0, childFreeAge ?? 0), 18);
  const bands = [];
  if (free > 0) bands.push({ kind: 'infant', fromAge: 0, toAge: free - 1, rule: { type: 'free', amount: 0 } });
  if (free < 18) bands.push({ kind: 'child', fromAge: free, toAge: 17, rule: { type: 'fixed', amount: extraChildMinor / 100 } });
  return { adultRateFromAge: 18, bands };
}

/** The policy one room quotes with, and where it came from. */
export function effectiveChildPolicy(profile, room) {
  if (room?.childPolicy) return { source: 'room', policy: room.childPolicy };
  if (profile?.childPolicy) return { source: 'property', policy: profile.childPolicy };
  return { source: 'property', policy: fallbackPolicy(profile?.childFreeAge, room?.extraChildMinor) };
}

/** The band for an age, or null when the age pays the adult rate. */
export const bandFor = (policy, age) => (age >= policy.adultRateFromAge ? null
  : policy.bands.find((band) => age >= band.fromAge && age <= band.toAge) ?? null);

/**
 * Cots one room needs: infants beyond maxOccupancy. `tooMany` when the overflow is not only infants.
 * `missing` is the first infant without a cot (1-based among the overflow), or 0.
 */
export function cotNeed({ maxOccupancy, adults, childAges, policy, cots }) {
  const overflow = Math.max(0, adults + childAges.length - maxOccupancy);
  const infants = childAges.filter((age) => bandFor(policy, age)?.kind === 'infant').length;
  const have = cots?.count ?? 0;
  return { needed: overflow, tooMany: overflow > infants, missing: overflow > have ? have + 1 : 0 };
}

/** Story 3.7: one child's percent charge for a night, integer paise, half up: roomOnly × pct / 100 / adults. */
export const percentChildMinor = (roomOnlyMinor, pct, adults) => {
  const denom = 10000 * adults;
  return Math.floor((roomOnlyMinor * pct * 100 + denom / 2) / denom);
};
