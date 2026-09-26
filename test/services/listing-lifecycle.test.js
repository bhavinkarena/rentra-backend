import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerEditEffect,
  ownerPauseTarget,
  RESTRICTED_MESSAGE,
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
