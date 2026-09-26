import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilitiesFor,
  canAccessRoute,
  CARETAKER_CAPABILITIES,
  routeCapability,
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

test('client lifecycle commands need admin.clients.write, reads need admin.clients.read', () => {
  const reader = { isActive: true, permissions: ['admin.clients.read'] };
  const id = '00000000-0000-4000-8000-000000000000';
  assert.equal(canAccessRoute(reader, 'admin', 'GET', '/clients'), true);
  assert.equal(canAccessRoute(reader, 'admin', 'GET', `/clients/${id}/lifecycle-preview`), true);
  for (const action of ['suspend', 'reinstate'])
    assert.equal(canAccessRoute(reader, 'admin', 'POST', `/clients/${id}/${action}`), false);
  assert.equal(
    canAccessRoute(
      { isActive: true, permissions: ['admin.clients.write'] },
      'admin',
      'POST',
      `/clients/${id}/suspend`,
    ),
    true,
  );
  assert.equal(
    canAccessRoute({ isActive: true, permissions: [] }, 'admin', 'GET', '/clients'),
    false,
  );
});

test('customer account controls need admin.customers.write; clients grants do not carry over', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const reader = { isActive: true, permissions: ['admin.customers.read'] };
  assert.equal(canAccessRoute(reader, 'admin', 'GET', `/customers/${id}`), true);
  for (const path of ['restrict', 'reinstate', 'sessions/revoke', 'profile'])
    assert.equal(canAccessRoute(reader, 'admin', 'POST', `/customers/${id}/${path}`), false);
  const clientsOnly = {
    isActive: true,
    permissions: ['admin.clients.write', 'admin.clients.read'],
  };
  assert.equal(canAccessRoute(clientsOnly, 'admin', 'GET', '/customers'), false);
  assert.equal(
    canAccessRoute(
      { isActive: true, permissions: null },
      'admin',
      'POST',
      `/customers/${id}/profile`,
    ),
    true,
  );
});

test('verification and publication commands need admin.properties.write', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const reader = { isActive: true, permissions: ['admin.properties.read'] };
  assert.equal(canAccessRoute(reader, 'admin', 'GET', `/properties/${id}`), true);
  for (const path of ['verifications', `verifications/${id}/outcome`, 'publish'])
    assert.equal(canAccessRoute(reader, 'admin', 'POST', `/properties/${id}/${path}`), false);
  const writer = { isActive: true, permissions: ['admin.properties.write'] };
  assert.equal(canAccessRoute(writer, 'admin', 'POST', `/properties/${id}/publish`), true);
});

test('restriction and correction commands need admin.properties.write', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const reader = { isActive: true, permissions: ['admin.properties.read'] };
  const writer = { isActive: true, permissions: ['admin.properties.write'] };
  for (const path of ['hide', 'restore', 'correction']) {
    assert.equal(canAccessRoute(reader, 'admin', 'POST', `/properties/${id}/${path}`), false);
    assert.equal(canAccessRoute(writer, 'admin', 'POST', `/properties/${id}/${path}`), true);
  }
});

test('updates reach onboarding clients; tasks need an active client', () => {
  const pending = { role: 'client', accountStatus: 'pending_application', capabilities: [] };
  const active = { role: 'client', accountStatus: 'active' };
  const suspended = { role: 'client', accountStatus: 'suspended' };
  pending.capabilities = capabilitiesFor(pending, 'client');
  assert.ok(pending.capabilities.includes('client.updates.read'));
  assert.ok(pending.capabilities.includes('client.updates.write'));
  assert.equal(pending.capabilities.includes('client.tasks.read'), false);
  assert.ok(capabilitiesFor(active, 'client').includes('client.tasks.read'));
  assert.deepEqual(capabilitiesFor(suspended, 'client'), []);
  assert.equal(routeCapability('client', 'POST', '/updates/read'), 'client.updates.write');
  assert.equal(routeCapability('client', 'GET', '/tasks'), 'client.tasks.read');
});

test('caretakers get only the two assigned-visit capabilities; team admin stays with the owner', () => {
  assert.deepEqual(capabilitiesFor({ active: true, permissions: {} }, 'staff'), [
    'staff.assigned-visits.read',
  ]);
  assert.deepEqual(capabilitiesFor({ active: true, permissions: { evidence: true } }, 'staff'), [
    'staff.assigned-visits.read',
    'staff.assigned-visits.evidence',
  ]);
  assert.deepEqual(
    capabilitiesFor({ active: false, permissions: { evidence: true } }, 'staff'),
    [],
  );
  for (const caps of [
    capabilitiesFor(
      { active: true, permissions: { evidence: true, pricing: true, team: true } },
      'staff',
    ),
  ])
    assert.ok(
      caps.every((c) => c.startsWith('staff.assigned-visits.')),
      'no pricing, earnings, KYC or team capability',
    );
  assert.ok(
    capabilitiesFor({ role: 'client', accountStatus: 'active' }, 'client').includes(
      'client.team.write',
    ),
  );
  assert.equal(
    capabilitiesFor({ role: 'client', accountStatus: 'pending_application' }, 'client').includes(
      'client.team.read',
    ),
    false,
  );
  assert.equal(routeCapability('client', 'POST', '/team/invite'), 'client.team.write');
  assert.equal(
    routeCapability('admin', 'GET', '/team'),
    null,
    'owner team permission is not platform administration',
  );
});
