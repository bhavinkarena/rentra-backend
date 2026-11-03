import 'server-only';
import { randomUUID } from 'node:crypto';
import { withListingInventory } from '../booking/inventory.js';
import { notificationMessage } from '../domain/notifications.js';
import { bodyHash, smsConfiguration, smsAdapter } from './delivery.js';
import { arrivalGuideMessage, queueArrivalGuides } from '../booking/arrival-guide.js';

async function obsolete(tx, row) {
  const [user] = await tx`SELECT phone,phone_verified_at FROM "user" WHERE id=${row.customer_id} AND role='customer' AND account_status='active' FOR SHARE`;
  if (!user) return { reason: 'ACCOUNT_UNAVAILABLE' };
  if (row.template === 'reminder') {
    const [valid] = await tx`SELECT id FROM booking WHERE id=${row.booking_id} AND state='confirmed' AND starts_at>clock_timestamp()`;
    if (!valid) return { reason: 'REMINDER_OBSOLETE' };
  }
  if (row.template === 'arrival_guide') {
    // Cancelled, started or no-show visits never get a guide; neither does a guide the owner cleared.
    const [valid] = await tx`SELECT id FROM booking WHERE id=${row.booking_id} AND state='confirmed' AND starts_at>clock_timestamp()`;
    if (!valid) return { reason: 'ARRIVAL_GUIDE_OBSOLETE' };
    const guide = await arrivalGuideMessage(tx, row.booking_id);
    if (!guide) return { reason: 'ARRIVAL_GUIDE_EMPTY' };
    return { user, guide };
  }
  if (row.template === 'review_invitation' || row.template === 'review_reminder') {
    const [v] = await tx`SELECT b.order_id,r.title,rentra_review_eligible(b.id,${row.customer_id},b.rentable_id) eligible,
      EXISTS(SELECT 1 FROM review WHERE booking_id=b.id AND author_id=${row.customer_id}) reviewed,
      rentra_review_exception_scope(b.id,${row.customer_id},b.rentable_id) IS NOT NULL arrival,
      rentra_review_window_end(b.id,${row.customer_id}) window_end
      FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE b.id=${row.booking_id}`;
    if (v?.reviewed) return { reason: 'REVIEW_SUBMITTED' };
    if (!v?.eligible) return { reason: 'REVIEW_INELIGIBLE' };
    return { user, review: { listing: v.title, windowEnd: v.window_end, arrival: v.arrival, orderId: v.order_id } };
  }
  if (row.template === 'request_approved') {
    // Paid, expired or released since: the payment prompt would mislead.
    const [valid] = await tx`SELECT id FROM booking_order WHERE id=${row.order_id} AND state='held' AND hold_expires_at>clock_timestamp()`;
    if (!valid) return { reason: 'REQUEST_OBSOLETE' };
  }
  if (row.template === 'confirmation') {
    const [valid] = await tx`SELECT id FROM booking WHERE order_id=${row.order_id} AND state IN ('confirmed','handed_over','returned','completed','disputed') LIMIT 1`;
    if (!valid) return { reason: 'CONFIRMATION_OBSOLETE' };
  }
  return { user };
}

export async function processNotification(database, id, options = {}) {
  const env = options.env ?? process.env;
  const [scope] = await database`SELECT o.rentable_id FROM notification_outbox n JOIN booking_order o ON o.id=n.order_id WHERE n.id=${id}`;
  if (!scope) return false;
  const prepared = await withListingInventory(database, scope.rentable_id, async tx => {
    const [row] = await tx`SELECT n.*,o.reference,o.visit_provenance,o.policy_snapshot->>'kind'='stay' AS is_stay,
      EXISTS(SELECT 1 FROM payment_order p WHERE p.booking_order_id=o.id AND p.environment='test') is_test_payment
      FROM notification_outbox n JOIN booking_order o ON o.id=n.order_id WHERE n.id=${id} FOR UPDATE OF n`;
    if (!row || !['pending','retry','blocked','accepted','sending'].includes(row.state)) return null;
    const [{ now }] = await tx`SELECT clock_timestamp() now`;
    if (new Date(row.scheduled_at)>new Date(now) || new Date(row.next_attempt_at)>new Date(now) || (row.lease_until && new Date(row.lease_until)>new Date(now))) return null;
    if (row.state === 'sending') {
      await tx`UPDATE notification_outbox SET state='unknown',failure_code='DELIVERY_OUTCOME_UNKNOWN',lease_token=NULL,lease_until=NULL WHERE id=${id}`;
      return null; // A crashed POST must never be sent twice.
    }
    if (row.state !== 'accepted') {
      const eligibility = await obsolete(tx, row);
      if (eligibility.reason) {
        await tx`UPDATE notification_outbox SET state='suppressed',failure_code=${eligibility.reason} WHERE id=${id}`;
        return null;
      }
      row.phone = eligibility.user.phone;
      row.phoneVerified = Boolean(eligibility.user.phone_verified_at);
      row.guide = eligibility.guide;
      if (eligibility.review) {
        let link = null;
        try { link = new URL(`/bookings/${eligibility.review.orderId}/reviews`, env.NEXT_PUBLIC_SITE_URL).href; } catch { /* body omits the link */ }
        row.review = { ...eligibility.review, link };
      }
    }
    let config;
    try {
      config = smsConfiguration(env);
      if (row.provider_account && row.state === 'accepted' && row.provider_account !== config.account) throw new Error('PINNED_SMS_ACCOUNT_MISSING');
      if (row.state !== 'accepted' && (row.visit_provenance !== 'real' || row.is_test_payment) && env.CUSTOMER_NOTIFICATION_ALLOW_TEST_SMS !== 'true') throw new Error('TEST_SMS_DISABLED');
      if (row.state !== 'accepted' && (!row.phoneVerified || !/^[6-9]\d{9}$/.test(row.phone || ''))) throw new Error('VERIFIED_PHONE_REQUIRED');
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.code || error.message) ? (error.code || error.message) : 'SMS_NOT_CONFIGURED';
      await tx`UPDATE notification_outbox SET state=${row.state === 'accepted' ? 'accepted' : 'blocked'},failure_code=${code},next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE id=${id}`;
      return null;
    }
    const token = randomUUID(), body = notificationMessage(row);
    if (row.state !== 'accepted') {
      row.recipient = '+91' + row.phone; row.sender = config.sender; row.body_hash = bodyHash(body); row.provider_account = config.account;
      await tx`UPDATE notification_outbox SET state='sending',attempts=attempts+1,recipient=${row.recipient},sender=${row.sender},
        body_hash=${row.body_hash},provider_account=${config.account},failure_code=NULL WHERE id=${id}`;
    }
    await tx`UPDATE notification_outbox SET lease_token=${token},lease_until=clock_timestamp()+interval '2 minutes',next_attempt_at=clock_timestamp()+interval '2 minutes' WHERE id=${id}`;
    return { row, config, token, body };
  });
  if (!prepared) return false;
  const { row, config, token, body } = prepared;
  try {
    const adapter = smsAdapter(config, options.fetcher);
    const outcome = row.state === 'accepted' ? await adapter.fetch(row) : await adapter.send(row, body);
    await database`UPDATE notification_outbox SET state=${outcome.state},provider_id=${outcome.id},failure_code=${outcome.state === 'undelivered' ? 'PROVIDER_UNDELIVERED' : null},
      delivered_at=CASE WHEN ${outcome.state === 'delivered'} THEN clock_timestamp() ELSE delivered_at END,
      lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE id=${id} AND lease_token=${token}`;
  } catch (error) {
    const state = row.state === 'accepted' ? 'accepted' : error.safeRetry ? (row.attempts >= 4 ? 'failed' : 'retry') : 'unknown';
    const code = /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'DELIVERY_OUTCOME_UNKNOWN';
    await database`UPDATE notification_outbox SET state=${state},failure_code=${code},lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '5 minutes'
      WHERE id=${id} AND lease_token=${token}`;
  }
  return true;
}

/**
 * Story 5.3: one day-7 reminder per sent review invitation, at 10:00 IST on the invitation's IST date + 7,
 * never past the review window. Pending/blocked/retry invitations wait; suppressed/failed ones get none.
 * The event key dedupes, so re-runs and restarts are idempotent.
 */
export async function queueReviewReminders(database) {
  // ponytail: anchored to delivered_at, else scheduled_at (no accepted-at column); add one if accepted-only rows matter.
  const rows = await database`INSERT INTO notification_outbox(order_id,booking_id,customer_id,event_key,template,scheduled_at)
    SELECT n.order_id,n.booking_id,n.customer_id,'review-reminder:'||n.booking_id,'review_reminder',d.due
    FROM notification_outbox n JOIN booking b ON b.id=n.booking_id
    CROSS JOIN LATERAL (SELECT rentra_review_window_end(b.id,n.customer_id) window_end,
      ((((coalesce(n.delivered_at,n.scheduled_at) AT TIME ZONE 'Asia/Kolkata')::date + 7)::timestamp + time '10:00') AT TIME ZONE 'Asia/Kolkata') due) d
    WHERE n.template='review_invitation' AND n.state IN ('accepted','delivered','unknown')
      AND d.window_end > clock_timestamp() AND d.due > clock_timestamp() AND d.due <= d.window_end
      AND rentra_review_eligible(b.id,n.customer_id,b.rentable_id)
      AND NOT EXISTS(SELECT 1 FROM review r WHERE r.booking_id=b.id AND r.author_id=n.customer_id)
    ON CONFLICT DO NOTHING RETURNING id`;
  return rows.length;
}

export async function runNotificationJobs(database, options = {}) {
  await queueArrivalGuides(database);
  await queueReviewReminders(database);
  const rows = await database`SELECT id FROM notification_outbox WHERE state IN ('pending','retry','blocked','accepted','sending')
    AND scheduled_at<=clock_timestamp() AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY next_attempt_at,id LIMIT 10`;
  for (const row of rows) await processNotification(database, row.id, options);
  return rows.length;
}
