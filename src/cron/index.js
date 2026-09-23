import '../boot-check.js';
import { setTimeout as sleep } from 'node:timers/promises';

const { sql } = await import('@/config/database.js');
const { config } = await import('@/config/env.js');
const { createJobs } = await import('./jobs.js');
const { runJob } = await import('./runner.js');
const { logger } = await import('@/utils/logger.js');

/**
 * Background worker — payment reconciliation, inventory expiry, booking
 * notifications and measurement retention.
 *
 * The `@/…` imports above are dynamic for the same reason as in src/index.js:
 * a static import is resolved before any code runs, so `boot-check.js` would
 * never get to explain a missing module loader. `../boot-check.js` is a
 * relative path deliberately — it has to resolve without the loader.
 *
 * A SEPARATE process from the API, not a timer inside it. Two reasons that
 * matter in practice: the API scales horizontally and N copies of this loop
 * would reconcile the same payment N times, and a job that wedges must not
 * take request handling down with it.
 *
 * Each tick records a heartbeat so the admin operations screen can say which
 * job last ran and whether it succeeded. A database outage leaves a stale
 * heartbeat rather than crashing the loop — that is the signal an operator
 * needs, and crashing would remove it.
 *
 * `--once` runs a single tick and exits, for CI and manual verification.
 */
const once = process.argv.includes('--once');
const TICK_MS = 10_000;
const jobs = createJobs(sql);

let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    logger.info('worker stopping', { signal });
  });
}

config();
logger.info('worker started', { mode: once ? 'once' : 'loop' });

try {
  do {
    for (const job of jobs) {
      const succeeded = await runJob(job, { once });
      if (!succeeded && once && job.name !== 'retention') process.exitCode = 1;
    }

    if (once) break;
    if (!stopping) await sleep(TICK_MS);
  } while (!stopping);
} finally {
  await sql.end({ timeout: 5 });
}
