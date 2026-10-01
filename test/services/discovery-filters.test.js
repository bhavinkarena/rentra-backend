import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscoveryQuery, discoveryQuery } from '../../src/services/domain/discovery.js';
import { searchDiscovery } from '../../src/services/db/discovery.js';

test('bedroom and verification filters validate and survive query serialization', () => {
  const { filters, errors } = parseDiscoveryQuery({ bedrooms: '3', verified: '1' });
  assert.deepEqual(errors, []);
  const roundTrip = parseDiscoveryQuery(
    Object.fromEntries(new URLSearchParams(discoveryQuery(filters))),
  );
  assert.equal(roundTrip.filters.bedrooms, 3);
  assert.equal(roundTrip.filters.verified, '1');
  for (const query of [
    { bedrooms: '0' },
    { bedrooms: '51' },
    { bedrooms: '1.5' },
    { verified: 'true' },
  ]) {
    assert.ok(parseDiscoveryQuery(query).errors.length);
  }
});

test('space and verification filter the full result set before pagination', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    slug: `place-${i}`,
    public_code: `code${i}`,
    title: `Place ${i}`,
    bedrooms: i < 5 ? null : i < 10 ? 1 : 3,
    physically_verified: i >= 15,
    photos: [],
    weekday: 5000,
    weekend: 6000,
    created_at: '2026-01-01',
    area_name: 'Area',
    city_name: 'City',
    review_count: 0,
  }));
  const filters = parseDiscoveryQuery({ bedrooms: '3', verified: '1', page: '2' }).filters;
  const result = await searchDiscovery(filters, null, async () => rows, {
    cities: [],
    areas: [],
    categories: [],
    amenities: [],
  });
  assert.equal(result.total, 15);
  assert.equal(result.totalPages, 2);
  assert.equal(result.items.length, 3);
  assert.ok(result.items.every((item) => item.bedrooms >= 3 && item.badge === 'verified'));
});

test('search cards include ordered public galleries for both verticals', async () => {
  const row = {
    id: 'gallery-place',
    slug: 'gallery-place',
    public_code: 'gallery',
    title: 'Gallery place',
    area_name: 'Area',
    city_name: 'City',
    weekday: 5000,
    weekend: 6000,
    hour_from_minor: 120000,
    resource_count: 1,
    review_count: 0,
    created_at: '2026-01-01',
    photos: [
      { url: '/photos/cover.jpg', alt: 'Cover' },
      { url: 'https://private.invalid/photo.jpg', alt: 'Private' },
      { url: '/photos/pool.jpg', alt: 'Pool' },
    ],
  };
  const registry = {
    cities: [],
    areas: [],
    categories: [],
    amenities: [],
    verticals: [{ code: 'farmhouse' }, { code: 'entertainment' }],
  };
  for (const vertical of ['farmhouse', 'entertainment']) {
    const filters = parseDiscoveryQuery({ vertical }).filters;
    const result = await searchDiscovery(filters, null, async () => [row], registry);
    assert.deepEqual(result.errors, []);
    const card = result.items[0];
    assert.deepEqual(
      card.photos.map((photo) => photo.url),
      ['/photos/cover.jpg', '/photos/pool.jpg'],
    );
    assert.deepEqual(card.photo, card.photos[0]);
    assert.equal(card.photoCount, 2);
  }
});
