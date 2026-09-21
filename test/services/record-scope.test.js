import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordKindFromBaseUrl } from '@/services/booking/record-scope.js';

test('booking record scope recognizes Express router mounts without trailing slashes', () => {
  assert.equal(recordKindFromBaseUrl('/api/v1/admin'), 'admin');
  assert.equal(recordKindFromBaseUrl('/api/v1/partner'), 'owner');
  assert.equal(recordKindFromBaseUrl('/api/v1/customer'), 'customer');
});

test('the same mount detection supports reviews and support route scopes', () => {
  const reviewScopes = ['/api/v1/admin', '/api/v1/partner'].map(recordKindFromBaseUrl);
  const supportScopes = ['/api/v1/admin', '/api/v1/customer'].map(recordKindFromBaseUrl);

  assert.deepEqual(reviewScopes, ['admin', 'owner']);
  assert.deepEqual(supportScopes, ['admin', 'customer']);
});

test('booking record scope does not infer an actor from an unrelated mount', () => {
  assert.equal(recordKindFromBaseUrl('/api/v1/bookings'), null);
  assert.equal(recordKindFromBaseUrl(''), null);
});
