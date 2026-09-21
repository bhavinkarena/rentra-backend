import 'server-only';
import { randomUUID } from 'node:crypto';
import { withListingInventory } from '../booking/inventory.js';
import { notificationMessage } from '../domain/notifications.js';
import { bodyHash, smsConfiguration, smsAdapter } from './delivery.js';

async function obsolete(tx, row) {
  const [user] = await tx`SELECT phone,phone_verified_at FROM "user" WHERE id=${row.customer_id} AND role='customer' AND account_status='active' FOR SHARE`;
  if (!user) return { reason: 'ACCOUNT_UNAVAILABLE' };
  if (row.template === 'reminder') {
    const [valid] = await tx`SELECT id FROM booking WHERE id=${row.booking_id} AND state='confirmed' AND starts_at>clock_timestamp()`;
    if (!valid) return { reason: 'REMINDER_OBSOLETE' };
  }
  if (row.template === 'review_invitation') {
    const [valid] = await tx`SELECT b.id FROM booking b JOIN visit_evidence e ON e.booking_id=b.id AND e.kind='complete' AND e.nature='actual'
      WHERE b.id=${row.booking_id} AND b.state='completed' AND b.visit_provenance='real' AND NOT EXISTS(SELECT 1 FROM review WHERE booking_id=b.id)`;
    if (!valid) return { reason: 'REVIEW_INELIGIBLE' };
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
    const [row] = await tx`SELECT n.*,o.reference,o.visit_provenance,
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

export async function runNotificationJobs(database, options = {}) {
  const rows = await database`SELECT id FROM notification_outbox WHERE state IN ('pending','retry','blocked','accepted','sending')
    AND scheduled_at<=clock_timestamp() AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY next_attempt_at,id LIMIT 10`;
  for (const row of rows) await processNotification(database, row.id, options);
  return rows.length;
}
