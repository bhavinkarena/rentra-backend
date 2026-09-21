import 'server-only';
import { requireActivePaymentAdmin, getPaymentConfiguration } from '../payments/gateway-settings.js';

/** Private aggregate projection; never serialize source rows or error payloads. */
export async function readOperations(database, adminId, env = process.env) {
  return database.begin(async tx => {
    await requireActivePaymentAdmin(tx, adminId);
    const gateway = await getPaymentConfiguration(tx, env);
    const [signals] = await tx`SELECT
      (SELECT count(*)::int FROM booking_order WHERE state='held' AND hold_expires_at<clock_timestamp()-interval '2 minutes') AS overdue_holds,
      (SELECT count(*)::int FROM payment_execution e JOIN payment_order p ON p.id=e.payment_order_id
        WHERE p.state<>'succeeded' AND e.state<>'ready' AND p.created_at<clock_timestamp()-interval '15 minutes') AS payment_backlog,
      (SELECT count(*)::int FROM payment_event WHERE state<>'processed' AND received_at<clock_timestamp()-interval '5 minutes') AS webhook_backlog,
      (SELECT count(*)::int FROM refund WHERE state IN ('requested','processing','unknown','failed') AND created_at<clock_timestamp()-interval '15 minutes') AS refund_backlog,
      (SELECT count(*)::int FROM notification_outbox WHERE state IN ('failed','undelivered','unknown','blocked')
        OR (state IN ('pending','retry','sending','accepted') AND scheduled_at<clock_timestamp()-interval '15 minutes')) AS delivery_backlog,
      (SELECT count(*)::int FROM customer_otp_challenge WHERE delivery_mode<>'development' AND NOT delivered AND created_at>clock_timestamp()-interval '1 hour') AS otp_delivery_failures,
      (SELECT count(*)::int FROM support_request WHERE state<>'resolved' AND updated_at<clock_timestamp()-interval '24 hours') AS support_backlog,
      (SELECT count(*)::int FROM availability WHERE units_available<0) AS negative_inventory,
      (SELECT count(*)::int FROM inventory_reservation a JOIN inventory_reservation b ON a.id<b.id AND a.rentable_id=b.rentable_id AND a.resource_key=b.resource_key
        AND a.blocked_start_at<b.blocked_end_at AND b.blocked_start_at<a.blocked_end_at
        WHERE (a.state='committed' OR (a.state='held' AND a.hold_expires_at>clock_timestamp()))
          AND (b.state='committed' OR (b.state='held' AND b.hold_expires_at>clock_timestamp()))) AS overlapping_inventory,
      (SELECT count(*)::int FROM payment_transaction t WHERE t.kind='capture' AND t.outcome='succeeded'
        AND t.captured_minor<>coalesce((SELECT sum(a.actual_minor) FROM payment_allocation a WHERE a.transaction_id=t.id),0)) AS unallocated_captures`;
    const health = await tx`SELECT service,healthy,checked_at,last_success_at,
      checked_at<clock_timestamp()-interval '2 minutes' stale FROM service_health ORDER BY service`;
    const measurements = await tx`SELECT event,source,device,visits,sum(count)::text count FROM customer_measurement
      WHERE day>=(clock_timestamp() AT TIME ZONE 'UTC')::date-29 GROUP BY event,source,device,visits ORDER BY source,event,device,visits`;
    const funnel = await tx`SELECT
      (SELECT count(*)::text FROM booking_quote WHERE created_at>clock_timestamp()-interval '30 days') quotes,
      (SELECT count(*)::text FROM booking_order b WHERE created_at>clock_timestamp()-interval '30 days'
        AND EXISTS(SELECT 1 FROM payment_order p WHERE p.booking_order_id=b.id AND p.provider='razorpay' AND p.environment='test')) test_orders,
      (SELECT count(*)::text FROM booking_lifecycle_event e WHERE kind='confirmed' AND created_at>clock_timestamp()-interval '30 days'
        AND EXISTS(SELECT 1 FROM payment_order p WHERE p.booking_order_id=e.order_id AND p.provider='razorpay' AND p.environment='test')) test_confirmations,
      (SELECT count(*)::text FROM booking_lifecycle_event WHERE kind='expired' AND created_at>clock_timestamp()-interval '30 days') expired_orders`;
    // Each money source is aggregated BEFORE joining. Never multiply allocations/refunds.
    const money = await tx`WITH captures AS (
        SELECT provider,environment,mode,sum(captured_minor)::numeric captured_minor FROM payment_transaction
        WHERE kind='capture' AND outcome='succeeded' AND verified_at IS NOT NULL GROUP BY provider,environment,mode
      ), refunds AS (
        SELECT provider,environment,mode,sum(actual_minor)::numeric refunded_minor FROM refund
        WHERE state='succeeded' AND verified_at IS NOT NULL GROUP BY provider,environment,mode
      ), intent AS (
        SELECT provider,environment,mode,sum(expected_minor)::numeric intended_minor FROM payment_order GROUP BY provider,environment,mode
      ) SELECT i.provider,i.environment,i.mode,i.intended_minor::text,
        coalesce(c.captured_minor,0)::text captured_minor,coalesce(r.refunded_minor,0)::text refunded_minor
        FROM intent i LEFT JOIN captures c USING(provider,environment,mode) LEFT JOIN refunds r USING(provider,environment,mode)
        ORDER BY i.environment,i.provider,i.mode`;
    const [live] = await tx`SELECT coalesce(sum(actual_minor),0)::text captured_minor,
      coalesce(sum(refunded_minor),0)::text refunded_minor,
      coalesce(sum(actual_minor-refunded_minor) FILTER(WHERE component='fee'),0)::text net_fee_minor,
      coalesce(sum(payout_reserved_minor),0)::text payout_reserved_minor FROM captured_payment_allocation`;
    const alerts = Object.entries(signals).filter(([, count]) => count > 0).map(([code, count]) => ({ code, count }));
    for (const service of ['payments', 'notifications']) {
      const row = health.find(item => item.service === service);
      if (!row || !row.healthy || row.stale) alerts.push({ code: `${service}_worker_unhealthy`, count: 1 });
    }
    for (const event of ['inventory_conflict', 'quote_changed', 'payment_unavailable', 'otp_request_rejected', 'otp_rejected']) {
      const [recent] = await tx`SELECT coalesce(sum(count),0)::int n FROM customer_measurement
        WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date AND source='server' AND event=${event}`;
      if (recent.n >= 10) alerts.push({ code: event, count: recent.n });
    }
    return { gateway, signals, health: Array.from(health), alerts, measurements: Array.from(measurements), funnel: funnel[0], money: Array.from(money), live,
      measurementEnabled: env.RENTRA_MEASUREMENT_ENABLED === 'true', sampledAt: new Date().toISOString() };
  });
}
