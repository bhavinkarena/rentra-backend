import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { slugifyHotel, validateHotelCatalog } from '../../src/scripts/import-hotel-catalog.js';

const data = JSON.parse(
  await readFile(
    new URL('../../src/scripts/data/india-hotel-catalog.json', import.meta.url),
    'utf8',
  ),
);

test('catalogue contains 72 distinct sourced hotels across nine cities', () => {
  assert.deepEqual(validateHotelCatalog(data), { cities: 9, hotels: 72 });
  assert.equal(slugifyHotel('The Park, New Delhi'), 'the-park-new-delhi');
});

test('catalogue rejects duplicate sources, names, and unsupported amenities before connecting', () => {
  const copy = structuredClone(data);
  copy.cities[0].hotels[1].sourceUrl = copy.cities[0].hotels[0].sourceUrl;
  assert.throws(() => validateHotelCatalog(copy), /Duplicate source/);
  copy.cities[0].hotels[1] = structuredClone(data.cities[0].hotels[1]);
  copy.cities[0].hotels[1].name = copy.cities[0].hotels[0].name.toUpperCase();
  assert.throws(() => validateHotelCatalog(copy), /Duplicate hotel/);
  copy.cities[0].hotels[1] = structuredClone(data.cities[0].hotels[1]);
  copy.cities[0].hotels[1].amenities.push('invented_facility');
  assert.throws(() => validateHotelCatalog(copy), /Unknown amenity/);
});
