import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  issuePriority,
  isLateReport,
  discoveryProblem,
  issueWindowOpen,
} from '../../src/services/domain/stay-issue.js';

test('stay issue rules: priority, lateness, discovery bounds and window', () => {
  const now = new Date('2026-10-30T12:00:00Z'),
    h = 3_600_000;
  assert.equal(issuePriority('access'), 'urgent');
  assert.equal(issuePriority('safety'), 'urgent');
  assert.equal(issuePriority('stranded'), 'urgent');
  assert.equal(issuePriority('cleanliness'), 'normal');
  assert.equal(isLateReport(new Date(now - 72 * h), now), false);
  assert.equal(isLateReport(new Date(now - 80 * h), now), true);
  const checkIn = new Date(now - 48 * h);
  assert.equal(discoveryProblem(new Date(+now + 4 * 60_000), checkIn, now), null);
  assert.equal(discoveryProblem(new Date(+now + h), checkIn, now), 'future');
  assert.equal(discoveryProblem('nonsense', checkIn, now), 'future');
  assert.equal(discoveryProblem(new Date(checkIn - 23 * h), checkIn, now), null);
  assert.equal(discoveryProblem(new Date(checkIn - 25 * h), checkIn, now), 'before_stay');
  assert.equal(issueWindowOpen(new Date(now - 29 * 24 * h), now), true);
  assert.equal(issueWindowOpen(new Date(now - 31 * 24 * h), now), false);
  assert.equal(issueWindowOpen(null, now), false);
});
