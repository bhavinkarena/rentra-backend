import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identity } from '../../src/controllers/auth.controller.js';

test('lightweight identity exposes only live access scope and no profile or documents', async () => {
  const actor = {
    id: 'owner',
    role: 'client',
    accountStatus: 'active',
    capabilities: ['client.records.read'],
    email: 'private@example.test',
  };
  let payload;
  const res = {
    success(status, data) {
      assert.equal(status, 200);
      payload = data;
    },
  };
  await identity({ user: actor, session: { sessionId: 'generation-one' } }, res, (error) => {
    throw error;
  });
  assert.deepEqual(Object.keys(payload.user).sort(), ['accountStatus', 'cacheScope', 'role']);
  assert.match(payload.user.cacheScope, /^[a-f0-9]{64}$/);
  const previous = payload.user.cacheScope;
  await identity({ user: actor, session: { sessionId: 'generation-two' } }, res, (error) => {
    throw error;
  });
  assert.notEqual(payload.user.cacheScope, previous);
  await identity({ user: null }, res, (error) => {
    throw error;
  });
  assert.deepEqual(payload, { user: null });
});
