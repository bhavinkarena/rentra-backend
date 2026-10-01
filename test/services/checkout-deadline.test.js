import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutHoldDeadline } from '../../src/services/booking/checkout.js';

test('hold deadline cannot extend beyond a visit starting in five minutes', () => {
  const now = new Date('2030-01-07T12:00:00Z');
  assert.equal(
    checkoutHoldDeadline(now, '2030-01-07T12:05:00Z').toISOString(),
    '2030-01-07T12:05:00.000Z',
  );
  assert.equal(
    checkoutHoldDeadline(now, '2030-01-08T12:00:00Z').toISOString(),
    '2030-01-07T12:10:00.000Z',
  );
  for (const start of ['2030-01-07T12:00:00Z', '2030-01-07T11:59:59Z'])
    assert.throws(() => checkoutHoldDeadline(now, start), { code: 'VISIT_ALREADY_STARTED' });
});
