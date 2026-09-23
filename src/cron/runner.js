import { logger } from '../utils/logger.js';

export async function runJob(job, { once = false, now = Date.now } = {}) {
  if (job.intervalMs && now() - job.lastRun < job.intervalMs) return true;
  try {
    const result = await job.run();
    if (job.heartbeat) {
      logger.info(`worker ${job.name}`, summarise(result));
      await job.heartbeat(true);
    }
    job.lastRun = now();
    return true;
  } catch {
    try {
      await job.heartbeat?.(false);
    } catch {
      // A database outage leaves a stale heartbeat for operations to detect.
    }
    logger.error(`worker ${job.name} tick failed`, { retry: once ? 'no' : 'next interval' });
    return false;
  }
}

function summarise(result) {
  if (!result || typeof result !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(result).filter(
      ([, value]) => typeof value === 'number' || typeof value === 'string',
    ),
  );
}
