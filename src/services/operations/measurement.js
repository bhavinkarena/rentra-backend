import 'server-only';
import { measurementSchema } from '../domain/measurement.js';

export async function recordMeasurement(database, input) {
  const event = measurementSchema.parse(input);
  await database`INSERT INTO customer_measurement(day,event,source,device,visits,vertical,count)
    VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,${event.event},${event.source},${event.device},${event.visits},${event.vertical},1)
    ON CONFLICT(day,event,source,device,visits,vertical) DO UPDATE
    SET count=least(customer_measurement.count+1,1000000)`;
}

// Measurement is optional and cannot turn a committed booking into a failed action.
export async function measure(database, event, visits = 'unknown') {
  if (process.env.RENTRA_MEASUREMENT_ENABLED !== 'true') return;
  try { await recordMeasurement(database, { event, source: 'server', visits }); }
  catch { console.error('[measurement] write failed'); }
}

export async function recordWorkerHealth(database, service, healthy) {
  if (!['payments', 'notifications'].includes(service) || typeof healthy !== 'boolean') throw new Error('Invalid health signal');
  await database`INSERT INTO service_health(service,healthy,checked_at,last_success_at)
    VALUES(${service},${healthy},clock_timestamp(),CASE WHEN ${healthy} THEN clock_timestamp() ELSE NULL END)
    ON CONFLICT(service) DO UPDATE SET healthy=excluded.healthy,checked_at=excluded.checked_at,
    last_success_at=CASE WHEN excluded.healthy THEN excluded.checked_at ELSE service_health.last_success_at END`;
}

export async function pruneMeasurements(database) {
  await database`DELETE FROM customer_measurement WHERE day<=(clock_timestamp() AT TIME ZONE 'UTC')::date-90`;
}

/**
 * Short-lived auth artefacts and abandoned quotes. Windows sit well beyond the code's own:
 * OTP 10 min, rate window 1 h, session 30 days. Audit history is append-only and never pruned here.
 */
export async function pruneAuthArtifacts(database) {
  const [otp] = await database`WITH d AS (DELETE FROM otp_challenge WHERE created_at<clock_timestamp()-interval '7 days' RETURNING 1) SELECT count(*)::int n FROM d`;
  const [rate] = await database`WITH d AS (DELETE FROM auth_rate_event WHERE created_at<clock_timestamp()-interval '7 days' RETURNING 1) SELECT count(*)::int n FROM d`;
  const [sessions] = await database`WITH d AS (DELETE FROM auth_session WHERE coalesce(revoked_at,expires_at)<clock_timestamp()-interval '90 days' RETURNING 1) SELECT count(*)::int n FROM d`;
  const [quotes] = await database`WITH d AS (DELETE FROM booking_quote q WHERE q.expires_at<clock_timestamp()-interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM booking_order o WHERE o.quote_id=q.id) RETURNING 1) SELECT count(*)::int n FROM d`;
  // A duplicate webhook racing the worker can leave a job row for an already processed event.
  const [jobs] = await database`WITH d AS (DELETE FROM payment_event_job j USING payment_event e
    WHERE e.id=j.event_id AND e.state='processed' RETURNING 1) SELECT count(*)::int n FROM d`;
  return { otp: otp.n, rate: rate.n, sessions: sessions.n, quotes: quotes.n, webhookJobs: jobs.n };
}
