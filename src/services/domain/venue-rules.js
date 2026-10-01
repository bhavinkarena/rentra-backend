/**
 * Venue rules (entertainment plan) as readable lines. Venues store rules as an
 * object ({ footwear, minAge, foodAllowed, smokingAllowed, alcoholAllowed, notes });
 * farmhouses store a list of strings, which is returned unchanged.
 */
const FOOTWEAR = {
  non_marking: 'Non-marking shoes only',
  no_studs: 'Sports shoes, no studs',
  studs_ok: 'Studs allowed',
  any: 'Any footwear',
};
const FOOD = {
  yes: 'Outside food allowed',
  no: 'No outside food',
  seating_only: 'Outside food in the seating area only',
};

export function houseRuleLines(rules) {
  if (Array.isArray(rules)) return rules.filter((rule) => typeof rule === 'string' && rule);
  if (!rules || typeof rules !== 'object') return [];
  return [
    FOOTWEAR[rules.footwear] ?? null,
    rules.minAge ? `Players ${rules.minAge}+ only` : null,
    FOOD[rules.foodAllowed] ?? null,
    rules.smokingAllowed ? 'Smoking allowed in marked areas' : 'No smoking',
    rules.alcoholAllowed ? 'Alcohol allowed' : 'No alcohol',
    typeof rules.notes === 'string' && rules.notes.trim() ? rules.notes.trim() : null,
  ].filter(Boolean);
}
