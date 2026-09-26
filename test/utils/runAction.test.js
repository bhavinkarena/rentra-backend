import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAction } from '@/utils/runAction.js';

test('an unexpected action error reaches the error middleware instead of hanging', async () => {
  const failure = new Error('relation "portal_session" does not exist');
  const handler = runAction(async () => {
    throw failure;
  });
  const received = await new Promise((resolve) => {
    handler({ body: {}, is: () => false, headers: {} }, {}, resolve);
  });
  assert.equal(received, failure);
});
