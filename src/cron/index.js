import '../boot-check.js';
import { setTimeout as sleep } from 'node:timers/promises';

const { sql } = await import('@/config/database.js');
const { config } = await import('@/config/env.js');
const { runPaymentJobs } = await import('@/services/payments/jobs.js');
const { runNotificationJobs } = await import('@/services/notifications/jobs.js');
const { recordWorkerHealth, pruneMeasurements } =
  await import('@/services/operations/measurement.js');
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
const MEASUREMENT_PRUNE_MS = 3_600_000;

let stopping = false;
let lastPrune = 0;

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
    await tick('payments', () => runPaymentJobs(sql));
    await tick('notifications', () => runNotificationJobs(sql));

    if (Date.now() - lastPrune >= MEASUREMENT_PRUNE_MS) {
      try {
        await pruneMeasurements(sql);
        lastPrune = Date.now();
      } catch {
        logger.error('measurement retention failed');
      }
    }

    if (once) break;
    if (!stopping) await sleep(TICK_MS);
  } while (!stopping);
} finally {
  await sql.end({ timeout: 5 });
}

/**
 * One job, with its heartbeat. Failures are logged without the error object:
 * these jobs handle payment identifiers and phone numbers, and a stack trace
 * in a log aggregator is the easiest way to leak both.
 */
async function tick(name, run) {
  try {
    const result = await run();
    logger.info(`worker ${name}`, summarise(result));
    await recordWorkerHealth(sql, name, true);
  } catch {
    try {
      await recordWorkerHealth(sql, name, false);
    } catch {
      /* A database outage leaves a stale heartbeat, which is itself the signal. */
    }
    logger.error(`worker ${name} tick failed`, { retry: once ? 'no' : 'next interval' });
    if (once) process.exitCode = 1;
  }
}

/** Counts only — never the rows themselves. */
function summarise(result) {
  if (!result || typeof result !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(result).filter(([, v]) => typeof v === 'number' || typeof v === 'string'),
  );
}
