/**
 * Property strength after publish (PROP-06). DERIVED, never stored. Each item
 * links to where the owner fixes it; no item promises more bookings.
 *
 * ponytail: the plan's "arrival guide" item is left out until an arrival guide
 * exists to fill in. Add it here when that feature ships.
 */
export function propertyStrength(facts, { venue = false } = {}) {
  const items = [
    { key: 'photos', label: 'Add 10 or more photos', done: facts.photoCount >= 10, target: 'photos' },
    {
      key: 'feature_photo',
      label: venue ? 'Add a photo of a court' : 'Add a photo of the pool or lawn',
      done: facts.featurePhoto,
      target: 'photos',
    },
    { key: 'highlight', label: 'Write a one-line highlight', done: facts.highlight, target: 'story' },
    { key: 'caretaker', label: 'Assign a caretaker', done: facts.caretaker, target: 'team' },
    {
      key: 'prices',
      label: 'Set weekday and weekend prices',
      done: facts.bothDayPrices,
      target: 'pricing',
    },
    { key: 'open_days', label: 'Keep 60 or more days open', done: facts.openDays >= 60, target: 'calendar' },
    {
      key: 'review_replies',
      label: 'Reply to every guest review',
      done: facts.unrepliedReviews === 0,
      target: 'reviews',
    },
  ];
  const done = items.filter((item) => item.done).length;
  return { items, done, total: items.length, percent: Math.round((done / items.length) * 100) };
}
