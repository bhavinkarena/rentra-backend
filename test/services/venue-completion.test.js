import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listingCompletion,
  ownershipDocTypesFor,
} from '../../src/services/domain/listing-completion.js';

import { venueConfig } from '../helpers/venue-fixture.js';
const venue = {
  rentalUnit: 'hour',
  categorySlug: 'box-cricket',
  houseRules: { footwear: 'non_marking', cancellationConfirmed: true },
  cancellationTier: 'moderate',
  depositAmount: 0,
  bookingConfig: venueConfig,
};
const rates = ['weekday', 'weekend'].map((dayKind) => ({
  activity: 'box-cricket',
  dayKind,
  startMinute: 360,
  endMinute: 1500,
  hourlyRate: 800,
}));

test('a venue is graded on courts, opening hours, venue rules and hourly prices', () => {
  const ids = (c) => c.sections.map((s) => s.id);
  const empty = listingCompletion(venue);
  assert.deepEqual(ids(empty), [
    'type',
    'location',
    'space',
    'amenities',
    'photos',
    'story',
    'pricing',
    'availability',
    'rules',
    'ownership',
  ]);
  const done = (c, id) => c.sections.find((s) => s.id === id).done;
  assert.equal(done(empty, 'space'), false);
  assert.equal(done(empty, 'pricing'), false);
  assert.equal(done(empty, 'availability'), true);
  assert.equal(done(empty, 'rules'), true);

  const filled = listingCompletion(venue, {
    resources: [
      { isActive: true, capacity: 12, activities: ['box-cricket'] },
      { isActive: false, activities: [] },
    ],
    hourlyRates: rates,
  });
  assert.equal(done(filled, 'space'), true);
  assert.equal(done(filled, 'pricing'), true);

  const courtWithoutActivity = listingCompletion(venue, {
    resources: [{ isActive: true, activities: [] }],
  });
  assert.equal(done(courtWithoutActivity, 'space'), false);
});

test('farmhouses keep their sections and documents', () => {
  const farm = listingCompletion({ rentalUnit: 'slot' });
  assert.ok(farm.sections.some((s) => s.id === 'space'));
  assert.ok(!farm.sections.some((s) => s.id === 'hours'));
  assert.ok(!ownershipDocTypesFor('slot').some((d) => d.id === 'shop_establishment'));
  assert.ok(ownershipDocTypesFor('hour').some((d) => d.id === 'shop_establishment'));
});

test('venue completion rejects gaps, missing primary activity, missing capacity and invalid hours', () => {
  const resources = [{ isActive: true, capacity: 12, activities: ['box-cricket'] }];
  const done = (listing, data, id) =>
    listingCompletion(listing, data).sections.find((s) => s.id === id).done;
  assert.equal(done(venue, { resources, hourlyRates: rates.slice(0, 1) }, 'pricing'), false);
  assert.equal(
    done(
      venue,
      { resources, hourlyRates: rates.map((r) => ({ ...r, endMinute: 1440 })) },
      'pricing',
    ),
    false,
  );
  assert.equal(
    done(venue, { resources: [{ ...resources[0], activities: ['pickleball'] }] }, 'space'),
    false,
  );
  assert.equal(done(venue, { resources: [{ ...resources[0], capacity: null }] }, 'space'), false);
  assert.equal(
    done({ ...venue, bookingConfig: { ...venueConfig, weeklyHours: {} } }, {}, 'availability'),
    false,
  );
});
