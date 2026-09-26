import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilitiesFor,
  canAccessRoute,
  CARETAKER_CAPABILITIES,
} from '@/services/auth/capabilities.js';
import { validPortalSession } from '@/services/auth/portal-sessions.js';

test('capabilities fail closed for unknown, customer, suspended and blocked actors', () => {
  for (const actor of [
    null,
    { role: 'customer', accountStatus: 'active' },
    { role: 'client', accountStatus: 'suspended' },
    { role: 'client', accountStatus: 'blocked' },
  ]) {
    assert.deepEqual(capabilitiesFor(actor, 'client'), []);
    assert.equal(canAccessRoute(actor, 'client', 'GET', '/records/123/summary'), false);
  }
});

test('pending clients can onboard but cannot change listings or operate bookings', () => {
  const actor = { role: 'client', accountStatus: 'pending_application' };
  assert.equal(canAccessRoute(actor, 'client', 'POST', '/application/details'), true);
  assert.equal(canAccessRoute(actor, 'client', 'POST', '/listings/123/basics'), false);
  assert.equal(canAccessRoute(actor, 'client', 'GET', '/records'), false);
  actor.accountStatus = 'active';
  assert.equal(canAccessRoute(actor, 'client', 'POST', '/listings/123/calendar/block'), true);
  assert.equal(canAccessRoute(actor, 'client', 'HEAD', '/records/123/summary'), true);
  assert.equal(canAccessRoute(actor, 'client', 'POST', '/unknown'), false);
});

test('admin permissions use current grants; document downloads and writes are distinct', () => {
  const admin = { isActive: true, permissions: ['admin.records.read'] };
  assert.equal(canAccessRoute(admin, 'admin', 'GET', '/records/123/summary'), true);
  assert.equal(canAccessRoute(admin, 'admin', 'POST', '/records/visit'), false);
  assert.equal(canAccessRoute(admin, 'admin', 'GET', '/documents/123/file'), false);
  admin.permissions = ['admin.documents.read'];
  assert.equal(canAccessRoute(admin, 'admin', 'GET', '/users/123/documents'), true);
  admin.isActive = false;
  assert.deepEqual(capabilitiesFor(admin, 'admin'), []);
  assert.equal(
    CARETAKER_CAPABILITIES.some((value) => /payments|pricing|documents|staff.write/.test(value)),
    false,
  );
});

test('missing, legacy and wrong-role portal claims fail before SQL', async () => {
  const database = () => {
    throw new Error('Unexpected SQL');
  };
  for (const claims of [
    null,
    {},
    { userId: 'bad', sessionId: 'bad', role: 'client' },
    { role: 'customer' },
  ]) {
    assert.equal(await validPortalSession(database, claims, 'client'), false);
    assert.equal(await validPortalSession(database, claims, 'admin'), false);
  }
});
