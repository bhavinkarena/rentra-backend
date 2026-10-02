import { cleanListingPhotoOrphans } from '../services/uploads/cloudinary.js';
import { autoOpenDates } from '../services/booking/owner-settings.js';
import { resumeEndedPauses } from '../services/auth/listings.js';
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
    {
      name: 'listing-photo-orphans',
      run: () => cleanListingPhotoOrphans(sql),
      intervalMs: 86400000,
      lastRun: 0,
    },
    { name: 'resume-paused', run: () => resumeEndedPauses(sql), intervalMs: 3600000, lastRun: 0 },
    { name: 'auto-open-dates', run: () => autoOpenDates(sql), intervalMs: 86400000, lastRun: 0 },
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
