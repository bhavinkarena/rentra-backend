import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerEditEffect,
  ownerPauseTarget,
  RESTRICTED_MESSAGE,
  trustChanges,
} from '@/services/domain/listing-lifecycle.js';

test('owner trust edits need re-review, including a paused property', () => {
  assert.deepEqual(ownerEditEffect({ status: 'live' }, true).patch, {
    status: 'pending_review',
    priorStatus: 'live',
  });
  assert.deepEqual(ownerEditEffect({ status: 'paused' }, true).patch, {
    status: 'pending_review',
    priorStatus: 'paused',
  });
  assert.deepEqual(ownerEditEffect({ status: 'live' }, false), { patch: {}, sentBack: false });
  assert.deepEqual(ownerEditEffect({ status: 'draft' }, true).patch, {});
});

test('owner edits never lift an admin restriction', () => {
  const hidden = ownerEditEffect({ status: 'hidden', priorStatus: 'live' }, true);
  assert.deepEqual(hidden.patch, { priorStatus: 'pending_review' });
  assert.equal(hidden.patch.status, undefined);
  assert.deepEqual(ownerEditEffect({ status: 'hidden', priorStatus: 'draft' }, true).patch, {});
});

test('owner pause and resume cannot reach or leave hidden', () => {
  assert.deepEqual(ownerPauseTarget('live'), { next: 'paused' });
  assert.deepEqual(ownerPauseTarget('paused'), { next: 'live' });
  assert.equal(ownerPauseTarget('hidden').error, RESTRICTED_MESSAGE);
  assert.ok(ownerPauseTarget('pending_review').error);
});

test('only values that really differ count as trust edits', () => {
  const current = {
    title: 'River Farm',
    categoryId: 'c1',
    capacity: 12,
    bedrooms: 3,
    exactAddress: '12 Lane',
    location: { x: 72.8, y: 21.1 },
    houseRules: { petsAllowed: false, notes: null },
  };
  const same = {
    title: 'River Farm',
    categoryId: 'c1',
    location: { x: 72.8000000001, y: 21.1 },
    exactAddress: '12 Lane',
    houseRules: { notes: null, petsAllowed: false },
  };
  assert.deepEqual(
    trustChanges(current, same, ['categoryId', 'title', 'location', 'exactAddress', 'houseRules']),
    [],
  );
  assert.deepEqual(trustChanges(current, { title: 'River Farm 2', categoryId: 'c1' }, ['categoryId', 'title']), ['title']);
  assert.deepEqual(trustChanges(current, { capacity: 14, bedrooms: 3 }, ['capacity', 'bedrooms']), ['capacity']);
  // Child collections are compared by the caller; naming one means it changed.
  assert.deepEqual(trustChanges(current, {}, ['amenities']), ['amenities']);
});
