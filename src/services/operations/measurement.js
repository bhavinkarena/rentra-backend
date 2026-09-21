import 'server-only';
import { measurementSchema } from '../domain/measurement.js';

export async function recordMeasurement(database, input) {
  const event = measurementSchema.parse(input);
  await database`INSERT INTO customer_measurement(day,event,source,device,visits,count)
    VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,${event.event},${event.source},${event.device},${event.visits},1)
    ON CONFLICT(day,event,source,device,visits) DO UPDATE
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
