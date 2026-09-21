import 'server-only';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { notificationLabels } from '../domain/notifications.js';
import { smsConfiguration, smsAdapter } from './delivery.js';

async function admin(tx, id) {
  z.string().uuid().parse(id);
  const [row] = await tx`SELECT id FROM admin_user WHERE id=${id} AND is_active=true FOR SHARE`;
  if (!row) throw new Error('Active administrator required');
}
export async function customerNotifications(database, session, env = process.env) {
  return database.begin(async tx => {
    const customer = await lockCustomerAccount(tx, session, env);
    const rows = await tx`SELECT n.id,n.order_id,n.template,n.state,n.created_at,n.read_at,o.reference,o.visit_provenance,
      EXISTS(SELECT 1 FROM payment_order p WHERE p.booking_order_id=o.id AND p.environment='test') is_test_payment
      FROM notification_outbox n JOIN booking_order o ON o.id=n.order_id WHERE n.customer_id=${customer.id}
      AND n.scheduled_at<=clock_timestamp() AND n.state<>'suppressed'
      AND (n.template<>'reminder' OR EXISTS(SELECT 1 FROM booking b WHERE b.id=n.booking_id AND b.state='confirmed' AND b.starts_at>clock_timestamp()))
      ORDER BY n.scheduled_at DESC,n.id DESC LIMIT 50`;
    return rows.map(r => ({ id: r.id, orderId: r.order_id, title: notificationLabels[r.template], reference: r.reference,
      simulation: r.visit_provenance !== 'real' || r.is_test_payment, delivery: r.state, read: Boolean(r.read_at), at: new Date(r.created_at).toISOString() }));
  });
}
export async function markNotificationRead(database, session, id, env = process.env) {
  z.string().uuid().parse(id);
  return database.begin(async tx => {
    const customer = await lockCustomerAccount(tx, session, env);
    await tx`UPDATE notification_outbox SET read_at=coalesce(read_at,clock_timestamp()) WHERE id=${id} AND customer_id=${customer.id} AND scheduled_at<=clock_timestamp()`;
  });
}
export async function notificationMonitor(database, adminId, page = 1) {
  const selected = Math.min(100000, Math.max(1, Number.isSafeInteger(Number(page)) ? Number(page) : 1));
  return database.begin(async tx => {
    await admin(tx, adminId);
    const counts = await tx`SELECT state,count(*)::int count FROM notification_outbox GROUP BY state`;
    const rows = await tx`SELECT n.id,n.order_id,n.template,n.state,n.attempts,n.failure_code,n.provider_id,n.scheduled_at,n.next_attempt_at,o.reference
      FROM notification_outbox n JOIN booking_order o ON o.id=n.order_id ORDER BY n.created_at DESC,n.id DESC LIMIT 30 OFFSET ${(selected - 1) * 30}`;
    return { counts, rows, page: selected, hasNext: counts.reduce((n, r) => n + r.count, 0) > selected * 30 };
  });
}
export async function retryNotification(database, adminId, id) {
  z.string().uuid().parse(id);
  return database.begin(async tx => {
    await admin(tx, adminId);
    const rows = await tx`UPDATE notification_outbox SET state='pending',next_attempt_at=clock_timestamp(),failure_code=NULL
      WHERE id=${id} AND state IN ('blocked','retry','failed') AND provider_id IS NULL RETURNING id`;
    if (!rows.length) throw new Error('Only a definitely undispatched or rejected message can be retried.');
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('admin',${adminId},'notification_outbox',${id},'notification_retry')`;
  });
}
export async function reconcileUnknownNotification(database, adminId, id, sid, options = {}) {
  z.string().uuid().parse(id); z.string().regex(/^SM[a-f0-9]{32}$/i).parse(sid);
  const row = await database.begin(async tx => {
    await admin(tx, adminId);
    const [message] = await tx`SELECT * FROM notification_outbox WHERE id=${id} AND state='unknown'`;
    if (!message || !message.provider_account || !message.body_hash) throw new Error('No uncertain dispatch to reconcile.');
    return message;
  });
  const config = smsConfiguration(options.env ?? process.env);
  if (config.account !== row.provider_account) throw new Error('Restore the pinned messaging account.');
  const outcome = await smsAdapter(config, options.fetcher).fetch({ ...row, provider_id: sid });
  await database.begin(async tx => {
    await admin(tx, adminId);
    const changed = await tx`UPDATE notification_outbox SET provider_id=${outcome.id},state=${outcome.state},failure_code=${outcome.state === 'undelivered' ? 'PROVIDER_UNDELIVERED' : null},next_attempt_at=clock_timestamp(),
      delivered_at=CASE WHEN ${outcome.state === 'delivered'} THEN clock_timestamp() ELSE delivered_at END WHERE id=${id} AND state='unknown' RETURNING id`;
    if (!changed.length) throw new Error('Delivery state changed. Reload the notification.');
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('admin',${adminId},'notification_outbox',${id},'notification_reconciled')`;
  });
}
