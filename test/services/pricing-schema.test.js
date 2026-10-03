import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingSchema } from '../../src/services/schemas/zod/listing.js';

const none = {
  day_weekday: 0,
  day_weekend: 0,
  night_weekday: 0,
  night_weekend: 0,
  full_day_weekday: 0,
  full_day_weekend: 0,
};

test('an offered slot needs both a weekday and a weekend price', () => {
  const result = pricingSchema.safeParse({ ...none, day_weekend: 2000 });
  assert.equal(result.success, false);
  assert.match(result.error.flatten().fieldErrors.day_weekday[0], /weekday and weekend/);
});

test('a slot priced on both day types, or on neither, is accepted', () => {
  assert.equal(
    pricingSchema.safeParse({ ...none, night_weekday: 3000, night_weekend: 3500 }).success,
    true,
  );
});
