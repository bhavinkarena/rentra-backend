/**
 * Room promises (Story 3.3): who a room physically sleeps and what a meal plan includes.
 * Mirrored for the owner form in Rentra/lib/domain/hotel-ui.js — keep both in step.
 */
export const BED_CAPACITY = { king: 2, queen: 2, double: 2, bunk: 2, single: 1, sofa_bed: 1 };
export const EXTRA_PLACE_TYPES = ['extra_bed', 'mattress'];
const BED_WORDS = { king: 'king bed', queen: 'queen bed', double: 'double bed', bunk: 'bunk bed', single: 'single bed', sofa_bed: 'sofa bed' };

export const bedCapacity = (beds = []) => beds.reduce((sum, bed) => sum + (BED_CAPACITY[bed.type] ?? 0) * bed.count, 0);
export const extraCapacity = (extraPlaces = []) => extraPlaces.reduce((sum, place) => sum + place.count, 0);

/** null when the beds and extra places sleep every adult; otherwise the owner-facing shortfall message. */
export function capacityShortfall({ name, beds = [], extraPlaces = [], maxAdults }) {
  const inBeds = bedCapacity(beds);
  const sleeps = inBeds + extraCapacity(extraPlaces);
  if (sleeps >= maxAdults) return null;
  const list = beds.map((bed) => `${bed.count} ${BED_WORDS[bed.type] ?? bed.type}${bed.count > 1 ? 's' : ''}`).join(' + ');
  const extra = extraCapacity(extraPlaces) ? ` and ${extraCapacity(extraPlaces)} extra` : '';
  return `${name}: ${list}${extra} ${beds.length === 1 && beds[0].count === 1 && !extra ? 'sleeps' : 'sleep'} ${sleeps}; add a sleeping place or lower max adults to ${sleeps}`;
}

/** The minimum each meal plan code includes. MP's second meal is the owner's pick. */
export const MEAL_DEFAULTS = {
  EP: { breakfast: false, lunch: false, dinner: false },
  CP: { breakfast: true, lunch: false, dinner: false },
  MP: { breakfast: true, lunch: false, dinner: false },
  AP: { breakfast: true, lunch: true, dinner: true },
};
export const mealDefaults = (code) => ({ ...(MEAL_DEFAULTS[code] ?? MEAL_DEFAULTS.EP) });

/** Stored inclusions, or the code default when none were stored (older plans; MP then promises breakfast only). */
export const resolveInclusions = (code, stored) => ({ ...mealDefaults(code), ...(stored ?? {}) });

/** Why `inclusions` cannot go with `code`, or null. */
export function inclusionsProblem(code, inclusions) {
  const min = mealDefaults(code);
  if (['breakfast', 'lunch', 'dinner'].some((meal) => min[meal] && !inclusions[meal])) return `${code} always includes ${Object.keys(min).filter((m) => min[m]).join(', ')}`;
  if (code === 'MP' && !inclusions.lunch && !inclusions.dinner) return 'Choose lunch or dinner for this meal plan';
  return null;
}
