import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalCacheScope } from '../../src/services/auth/cache-scope.js';
import { corsOptions } from '../../src/config/cors.js';

test('public cache generation changes with login, actor, status and permissions', () => {
  const actor = { id: 'a', role: 'client', accountStatus: 'active', capabilities: ['b', 'a'] };
  const session = { sessionId: 'session-one' };
  const scope = portalCacheScope(actor, session);
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(scope, portalCacheScope({ ...actor, capabilities: ['a', 'b'] }, session));
  for (const changed of [
    { ...actor, id: 'b' },
    { ...actor, accountStatus: 'blocked' },
    { ...actor, capabilities: ['a'] },
  ])
    assert.notEqual(scope, portalCacheScope(changed, session));
  assert.notEqual(scope, portalCacheScope(actor, { sessionId: 'session-two' }));
  assert.equal(portalCacheScope(actor, {}), null);
  assert.equal(portalCacheScope({ ...actor, role: 'customer' }, session), null);
});
test('credentialed CORS uses explicit origins and rejects untrusted browser requests', () => {
  const options = corsOptions({
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://rentra.example',
  });
  options.origin('https://rentra.example', (error, allowed) => {
    assert.equal(error, null);
    assert.equal(allowed, true);
  });
  options.origin(undefined, (error, allowed) => {
    assert.equal(error, null);
    assert.equal(allowed, true);
  });
  for (const origin of ['https://evil.example', 'null', 'https://rentra.example.evil.example'])
    options.origin(origin, (error) => assert.equal(error.statusCode, 403));
  corsOptions({ NODE_ENV: 'production' }).origin('http://localhost:3000', (error) =>
    assert.equal(error.statusCode, 403),
  );
});
