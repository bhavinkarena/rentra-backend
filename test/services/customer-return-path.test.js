import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCustomerAreaPath } from '../../src/services/auth/customer-selection.js';

test('Story 2.3 login returns only to same-origin customer pages', () => {
  for (const ok of ['/checkout/review/abc-123', '/bookings/9f1c', '/account', '/support/new'])
    assert.equal(safeCustomerAreaPath(ok), ok);
  for (const bad of ['//evil.test', 'https://evil.test', '/admin', '/checkout/../admin', '/bookings?x=1', '/account/a b', 42, null, '/'.padEnd(300, 'a')])
    assert.equal(safeCustomerAreaPath(bad), null, String(bad));
});
