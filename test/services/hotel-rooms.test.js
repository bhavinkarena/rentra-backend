import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bedCapacity,
  capacityShortfall,
  inclusionsProblem,
  mealDefaults,
  resolveInclusions,
} from '../../src/services/domain/hotel-rooms.js';
import { hotelRoomSchema } from '../../src/services/schemas/zod/listing.js';

test('Story 3.3: bed capacity and sleeping-place rule', () => {
  assert.equal(
    bedCapacity([
      { type: 'king', count: 1 },
      { type: 'sofa_bed', count: 1 },
      { type: 'bunk', count: 2 },
    ]),
    7,
  );
  const room = {
    name: 'Deluxe',
    beds: [{ type: 'double', count: 1 }],
    extraPlaces: [],
    maxAdults: 2,
  };
  assert.equal(capacityShortfall(room), null);
  assert.equal(
    capacityShortfall({ ...room, maxAdults: 3 }),
    'Deluxe: 1 double bed sleeps 2; add a sleeping place or lower max adults to 2',
  );
  assert.equal(
    capacityShortfall({ ...room, maxAdults: 3, extraPlaces: [{ type: 'extra_bed', count: 1 }] }),
    null,
  );
  assert.equal(
    capacityShortfall({
      ...room,
      beds: [{ type: 'single', count: 2 }],
      maxAdults: 3,
      extraPlaces: [{ type: 'mattress', count: 1 }],
    }),
    null,
  );
  const row = {
    name: 'Deluxe',
    beds: [{ type: 'double', count: 1 }],
    maxAdults: 3,
    maxChildren: 1,
    maxOccupancy: 4,
    baseOccupancy: 2,
    roomCount: 1,
    extraAdult: 0,
    extraChild: 0,
    sortOrder: 0,
  };
  assert.equal(hotelRoomSchema.safeParse(row).success, false);
  assert.equal(
    hotelRoomSchema.safeParse({ ...row, extraPlaces: [{ type: 'extra_bed', count: 1 }] }).success,
    true,
  );
  assert.equal(
    hotelRoomSchema.safeParse({ ...row, extraPlaces: [{ type: 'cot', count: 1 }] }).success,
    false,
  );
  assert.equal(
    hotelRoomSchema.safeParse({ ...row, isActive: false }).success,
    true,
    'removed rooms do not block',
  );
});

test('Story 3.3: meal defaults and overrides', () => {
  assert.deepEqual(mealDefaults('EP'), { breakfast: false, lunch: false, dinner: false });
  assert.deepEqual(resolveInclusions('CP', null), { breakfast: true, lunch: false, dinner: false });
  assert.equal(inclusionsProblem('CP', resolveInclusions('CP', null)), null);
  assert.equal(
    inclusionsProblem('CP', { breakfast: true, lunch: false, dinner: true }),
    null,
    'adding a meal is allowed',
  );
  assert.match(inclusionsProblem('MP', resolveInclusions('MP', null)), /lunch or dinner/);
  assert.equal(inclusionsProblem('MP', { breakfast: true, lunch: true, dinner: false }), null);
  assert.ok(inclusionsProblem('AP', { breakfast: true, lunch: true, dinner: false }));
});
