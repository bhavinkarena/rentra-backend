import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billIsFresh } from '../../src/services/domain/listing-completion.js';

test('electricity bill must be issued within the last 3 months, not in the future', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  assert.equal(billIsFresh('2026-10-02', now), true);
  assert.equal(billIsFresh('2026-07-02', now), true);
  assert.equal(billIsFresh('2026-07-01', now), false);
  assert.equal(billIsFresh('2026-10-03', now), false);
  assert.equal(billIsFresh('2026-02-30', now), false);
  assert.equal(billIsFresh('', now), false);
});
