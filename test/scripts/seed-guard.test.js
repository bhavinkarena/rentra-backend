import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedDatabaseUrl } from '../../src/scripts/seed-guard.js';

const remote = 'postgresql://u:p@ep-example.neon.tech/rentra';

test('seed guard allows local databases and refuses everything else unless named', () => {
  assert.equal(
    seedDatabaseUrl('t', { DATABASE_URL: 'postgres://postgres@127.0.0.1:55432/x' }),
    'postgres://postgres@127.0.0.1:55432/x',
  );
  assert.throws(() => seedDatabaseUrl('t', {}), /DATABASE_URL is not set/);
  assert.throws(
    () => seedDatabaseUrl('t', { DATABASE_URL: remote }),
    /refusing to seed remote host ep-example\.neon\.tech/,
  );
  assert.throws(
    () => seedDatabaseUrl('t', { DATABASE_URL: remote, SEED_ALLOW_HOST: 'other.neon.tech' }),
    /refusing to seed remote host/,
  );
  assert.equal(
    seedDatabaseUrl('t', { DATABASE_URL: remote, SEED_ALLOW_HOST: 'ep-example.neon.tech' }),
    remote,
  );
  assert.throws(
    () => seedDatabaseUrl('t', { DATABASE_URL: 'postgres://localhost/x', NODE_ENV: 'production' }),
    /NODE_ENV=production/,
  );
  assert.throws(() => seedDatabaseUrl('t', { DATABASE_URL: 'not a url' }), /not a valid URL/);
});
