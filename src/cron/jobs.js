import { runPaymentJobs } from '@/services/payments/jobs.js';
import { runNotificationJobs } from '@/services/notifications/jobs.js';
import { recordWorkerHealth, pruneMeasurements } from '@/services/operations/measurement.js';

// Registration only. Domain work stays in services; execution stays in runner.
// One registry per worker keeps the existing sequential cadence and retry policy.
export function createJobs(sql) {
  return [
    {
      name: 'payments',
      run: () => runPaymentJobs(sql),
      heartbeat: (ok) => recordWorkerHealth(sql, 'payments', ok),
    },
    {
      name: 'notifications',
      run: () => runNotificationJobs(sql),
      heartbeat: (ok) => recordWorkerHealth(sql, 'notifications', ok),
    },
    { name: 'retention', run: () => pruneMeasurements(sql), intervalMs: 3_600_000, lastRun: 0 },
  ];
}
