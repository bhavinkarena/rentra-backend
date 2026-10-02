import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propertyStrength } from '../../src/services/domain/listing-strength.js';

const full = {
  photoCount: 12,
  featurePhoto: true,
  highlight: true,
  caretaker: true,
  bothDayPrices: true,
  openDays: 90,
  unrepliedReviews: 0,
};

test('strength counts each item once and links every missing one', () => {
  assert.equal(propertyStrength(full).percent, 100);
  const weak = propertyStrength({ ...full, photoCount: 9, openDays: 59, unrepliedReviews: 2 });
  assert.equal(weak.done, weak.total - 3);
  assert.deepEqual(
    weak.items.filter((item) => !item.done).map((item) => item.target),
    ['photos', 'calendar', 'reviews'],
  );
  assert.match(propertyStrength(full, { venue: true }).items[1].label, /court/);
  // No item promises an outcome the product cannot measure.
  assert.ok(propertyStrength(full).items.every((item) => !/%|more bookings/i.test(item.label)));
});
