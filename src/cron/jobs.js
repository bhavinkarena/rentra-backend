import { runPaymentJobs } from '@/services/payments/jobs.js';
import { runPrivacyJobs } from '@/services/customer/privacy-fulfillment.js';
import { runExportJobs } from '@/services/admin/audit-browser.js';
import { runNotificationJobs } from '@/services/notifications/jobs.js';
import {
  recordWorkerHealth,
  pruneMeasurements,
  pruneAuthArtifacts,
} from '@/services/operations/measurement.js';

// Registration only. Domain work stays in services; execution stays in runner.
// One registry per worker keeps the existing sequential cadence and retry policy.
export function createJobs(sql) {
  return [
    { name: 'exports', run: () => runExportJobs(sql) },
    { name: 'privacy', run: () => runPrivacyJobs(sql) },
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
    {
      name: 'retention',
      run: async () => ({
        ...(await pruneAuthArtifacts(sql)),
        measurements: await pruneMeasurements(sql),
      }),
      intervalMs: 3_600_000,
      lastRun: 0,
    },
  ];
}
