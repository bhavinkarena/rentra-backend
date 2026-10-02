import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicHouseRules } from '../../src/services/domain/listing-content.js';

test('structured owner rules become guest lines; legacy lists pass through', () => {
  assert.deepEqual(
    publicHouseRules({
      petsAllowed: false,
      alcoholAllowed: true,
      stagGroups: 'on_request',
      musicCutoff: '11 PM',
      notes: 'No fireworks',
      cancellationConfirmed: true,
    }),
    ['No pets', 'Alcohol allowed', 'Stag groups on request', 'Music off by 11 PM', 'No fireworks'],
  );
  assert.deepEqual(publicHouseRules(['No smoking']), ['No smoking']);
  assert.deepEqual(publicHouseRules(null), []);
});
