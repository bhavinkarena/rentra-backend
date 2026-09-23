import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../../src/cron/runner.js';

test('retention runs only when due and retries a failed run', async () => {
  let calls = 0;
  let fail = true;
  const job = {
    name: 'retention',
    intervalMs: 100,
    lastRun: 0,
    run: async () => {
      calls++;
      if (fail) throw new Error('private information');
    },
  };
  assert.equal(await runJob(job, { now: () => 50 }), true);
  assert.equal(calls, 0);
  assert.equal(await runJob(job, { now: () => 100 }), false);
  assert.equal(job.lastRun, 0);
  fail = false;
  assert.equal(await runJob(job, { now: () => 101 }), true);
  assert.equal(job.lastRun, 101);
  await runJob(job, { now: () => 150 });
  assert.equal(calls, 2);
});

test('records success and failure heartbeats without throwing on a database outage', async () => {
  const heartbeats = [];
  const job = {
    name: 'payments',
    run: async () => ({ count: 1 }),
    heartbeat: async (ok) => {
      heartbeats.push(ok);
    },
  };
  assert.equal(await runJob(job), true);
  job.run = async () => {
    throw new Error('private information');
  };
  assert.equal(await runJob(job, { once: true }), false);
  assert.deepEqual(heartbeats, [true, false]);
  job.heartbeat = async () => {
    throw new Error('database unavailable');
  };
  assert.equal(await runJob(job), false);
});
