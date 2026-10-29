import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeCustomerAreaPath } from '../../src/services/auth/customer-selection.js';

test('Story 2.3 login returns only to same-origin customer pages', () => {
  for (const ok of ['/checkout/review/abc-123', '/bookings/9f1c', '/account', '/support/new'])
    assert.equal(safeCustomerAreaPath(ok), ok);
  for (const bad of ['//evil.test', 'https://evil.test', '/admin', '/checkout/../admin', '/bookings?x=1', '/account/a b', 42, null, '/'.padEnd(300, 'a')])
    assert.equal(safeCustomerAreaPath(bad), null, String(bad));
});

test('Story 3.1 login returns to the exact search URL', () => {
  for (const ok of ['/search', '/search?vertical=hotel&city=surat&checkin=2026-11-01&children=4%2C7'])
    assert.equal(safeCustomerAreaPath(ok), ok);
  for (const bad of [
    '/search?a=1\r\nSet-Cookie:x',
    '/search?a=1%0D%0ASet-Cookie:x',
    '/search?a=\\evil.com',
    '/search\\evil.com',
    '/search?q=a b',
    '/search?q=a\tb',
    '/search?q=a@evil.com',
    '/search?x=%2F%2Fevil.com',
    '/search?x=http://evil.com',
    '/search?next=//evil.test', '/search/../admin', '/searchx', '/search?a=<b>', `/search?q=${'a'.repeat(2000)}`, '/search#x'])
    assert.equal(safeCustomerAreaPath(bad), null, bad);
});
