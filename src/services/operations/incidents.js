import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readOperations } from './overview.js';
import { requireActivePaymentAdmin } from '../payments/gateway-settings.js';

export const incidentCodes = [
  'overdue_holds', 'payment_backlog', 'webhook_backlog', 'refund_backlog',
  'delivery_backlog', 'otp_delivery_failures', 'support_backlog', 'negative_inventory',
  'overlapping_inventory', 'unallocated_captures', 'payments_worker_unhealthy',
  'notifications_worker_unhealthy', 'inventory_conflict', 'quote_changed',
  'payment_unavailable', 'otp_request_rejected', 'otp_rejected',
];
const codeSchema = z.enum(incidentCodes);
const commandSchema = z.object({
  code: codeSchema,
  action: z.enum(['open', 'reopen', 'assign', 'note', 'acknowledge', 'snooze', 'escalate', 'resolve']),
  note: z.string().trim().min(8).max(2000),
  requestKey: z.string().uuid(),
  expectedVersion: z.coerce.number().int().min(0),
  assigneeId: z.string().uuid().optional(),
  snoozeHours: z.coerce.number().int().refine(value => [1, 4, 24].includes(value)).optional(),
});

async function linkedRecords(tx, code) {
  if (code === 'delivery_backlog' || code === 'notifications_worker_unhealthy') {
    return tx`SELECT n.id::text id,o.reference label,concat('/admin/notifications/',n.id) href,n.state
      FROM notification_outbox n JOIN booking_order o ON o.id=n.order_id
      WHERE n.state IN ('failed','undelivered','unknown','blocked') OR
        (n.state IN ('pending','retry','sending','accepted') AND n.scheduled_at<clock_timestamp()-interval '15 minutes')
      ORDER BY n.created_at DESC LIMIT 25`;
  }
  if (code === 'support_backlog') return tx`SELECT id::text id,id::text label,concat('/admin/support/',id) href,state
    FROM support_request WHERE state<>'resolved' AND updated_at<clock_timestamp()-interval '24 hours' ORDER BY updated_at LIMIT 25`;
  if (code === 'overdue_holds') return tx`SELECT id::text id,reference label,concat('/admin/bookings/',id) href,state
    FROM booking_order WHERE state='held' AND hold_expires_at<clock_timestamp()-interval '2 minutes' ORDER BY hold_expires_at LIMIT 25`;
  if (code === 'payment_backlog') return tx`SELECT DISTINCT p.id::text id,o.reference label,concat('/admin/finance/payments/',p.id) href,p.state
    FROM payment_execution e JOIN payment_order p ON p.id=e.payment_order_id JOIN booking_order o ON o.id=p.booking_order_id
    WHERE p.state<>'succeeded' AND e.state<>'ready' AND p.created_at<clock_timestamp()-interval '15 minutes' LIMIT 25`;
  if (code === 'refund_backlog') return tx`SELECT r.id::text id,r.id::text label,concat('/admin/finance/refunds/',r.id) href,r.state
    FROM refund r WHERE r.state IN ('requested','processing','unknown','failed') AND r.created_at<clock_timestamp()-interval '15 minutes' ORDER BY r.created_at LIMIT 25`;
  if (code === 'webhook_backlog') return tx`SELECT id::text id,id::text label,'/admin/finance/payments' href,state
    FROM payment_event WHERE state<>'processed' AND received_at<clock_timestamp()-interval '5 minutes' ORDER BY received_at LIMIT 25`;
  if (code === 'unallocated_captures') return tx`SELECT t.id::text id,t.id::text label,'/admin/finance/payments' href,t.outcome state
    FROM payment_transaction t WHERE t.kind='capture' AND t.outcome='succeeded'
    AND t.captured_minor<>coalesce((SELECT sum(a.actual_minor) FROM payment_allocation a WHERE a.transaction_id=t.id),0) LIMIT 25`;
  if (code === 'negative_inventory') return tx`SELECT rentable_id::text id,rentable_id::text label,concat('/admin/properties/',rentable_id) href,'negative' state
    FROM availability WHERE units_available<0 LIMIT 25`;
  if (code === 'overlapping_inventory') return tx`SELECT a.id::text id,a.rentable_id::text label,concat('/admin/properties/',a.rentable_id) href,'overlap' state
    FROM inventory_reservation a JOIN inventory_reservation b ON a.id<b.id AND a.rentable_id=b.rentable_id AND a.resource_key=b.resource_key
    AND a.blocked_start_at<b.blocked_end_at AND b.blocked_start_at<a.blocked_end_at
    WHERE (a.state='committed' OR (a.state='held' AND a.hold_expires_at>clock_timestamp()))
    AND (b.state='committed' OR (b.state='held' AND b.hold_expires_at>clock_timestamp())) LIMIT 25`;
  return [];
}

export async function readIncident(database, adminId, code) {
  codeSchema.parse(code);
  const overview = await readOperations(database, adminId);
  const signal = overview.alerts.find(item => item.code === code);
  return database.begin(async tx => {
    await requireActivePaymentAdmin(tx, adminId);
    const [incident] = await tx`SELECT i.*,a.name assignee_name FROM operational_incident i
      LEFT JOIN admin_user a ON a.id=i.assignee_id WHERE i.code=${code}`;
    const events = await tx`SELECT e.id,e.action,e.note,e.details,e.signal_count,e.sampled_at,e.at,a.name actor_name
      FROM operational_incident_event e JOIN admin_user a ON a.id=e.actor_id WHERE e.code=${code}
      ORDER BY e.at DESC,e.id DESC LIMIT 50`;
    const records = await linkedRecords(tx, code);
    const health = code.endsWith('_worker_unhealthy')
      ? overview.health.find(row => row.service === code.split('_')[0]) ?? null : null;
    return { code, count: signal?.count ?? 0, sampledAt: overview.sampledAt,
      health, incident: incident ?? null, events, records, recordsLimited: records.length === 25 };
  });
}

export async function commandIncident(database, adminId, input) {
  const command = commandSchema.parse(input);
  const payloadHash = createHash('sha256').update(JSON.stringify({
    action: command.action, note: command.note, expectedVersion: command.expectedVersion,
    assigneeId: command.assigneeId ?? null, snoozeHours: command.snoozeHours ?? null,
  })).digest('hex');
  const overview = await readOperations(database, adminId);
  const count = overview.alerts.find(row => row.code === command.code)?.count ?? 0;
  if (['open', 'reopen'].includes(command.action) && count === 0) throw new Error('The measured signal is clear. No incident can be opened.');
  if (command.action === 'resolve' && count !== 0) throw new Error('The measured signal remains active. Resolve only after recovery evidence is clear.');
  return database.begin(async tx => {
    await requireActivePaymentAdmin(tx, adminId);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${command.code}))`;
    const [duplicate] = await tx`SELECT code,action,payload_hash FROM operational_incident_event WHERE request_key=${command.requestKey}`;
    if (duplicate) {
      if (duplicate.code !== command.code || duplicate.action !== command.action || duplicate.payload_hash !== payloadHash) throw new Error('Request key was already used for another command.');
      return { replayed: true };
    }
    if (command.action === 'open') {
      await tx`INSERT INTO operational_incident(code) VALUES(${command.code}) ON CONFLICT DO NOTHING`;
    }
    const [current] = await tx`SELECT * FROM operational_incident WHERE code=${command.code} FOR UPDATE`;
    if (!current) throw new Error('Open this incident before changing it.');
    if (current.version !== command.expectedVersion && !(command.action === 'open' && command.expectedVersion === 0 && current.version === 1)) {
      throw new Error('Incident changed. Reload and try again.');
    }
    if (command.action === 'open' && current.version !== 1) throw new Error('Incident already exists. Reload it.');
    if (command.action === 'open') {
      const [existingOpen] = await tx`SELECT id FROM operational_incident_event WHERE code=${command.code} LIMIT 1`;
      if (existingOpen) throw new Error('Incident already exists. Reload it.');
    }
    if (command.action === 'reopen' && current.status !== 'resolved') throw new Error('Only resolved incidents can be reopened.');
    if (!['open', 'reopen'].includes(command.action) && current.status === 'resolved') throw new Error('Reopen this incident first.');
    if (command.action === 'assign') {
      if (!command.assigneeId) throw new Error('Choose an active administrator.');
      const [assignee] = await tx`SELECT id FROM admin_user WHERE id=${command.assigneeId} AND is_active=true`;
      if (!assignee) throw new Error('Choose an active administrator.');
    }
    if (command.action === 'snooze' && !command.snoozeHours) throw new Error('Choose a snooze duration.');
    if (command.action !== 'open') await tx`UPDATE operational_incident SET
      status=CASE WHEN ${command.action}='resolve' THEN 'resolved'
        WHEN ${command.action}='reopen' THEN 'open'
        WHEN ${command.action}='acknowledge' THEN 'acknowledged'
        WHEN ${command.action}='escalate' THEN 'escalated' ELSE status END,
      assignee_id=CASE WHEN ${command.action}='assign' THEN ${command.assigneeId ?? null}::uuid ELSE assignee_id END,
      snoozed_until=CASE WHEN ${command.action}='snooze' THEN clock_timestamp()+(${command.snoozeHours ?? 0} * interval '1 hour')
        WHEN ${command.action} IN ('reopen','resolve') THEN NULL ELSE snoozed_until END,
      version=version+1,updated_at=clock_timestamp() WHERE code=${command.code}`;
    const [after] = await tx`SELECT status,assignee_id,snoozed_until,version FROM operational_incident WHERE code=${command.code}`;
    const details = { beforeStatus: command.action === 'open' ? null : current.status,
      afterStatus: after.status, assigneeId: after.assignee_id, snoozedUntil: after.snoozed_until, version: after.version };
    await tx`INSERT INTO operational_incident_event(code,actor_id,request_key,payload_hash,action,note,details,signal_count,sampled_at)
      VALUES(${command.code},${adminId},${command.requestKey},${payloadHash},${command.action},${command.note},${JSON.stringify(details)}::text::jsonb,${count},${overview.sampledAt})`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,reason,after)
      VALUES('admin',${adminId},'operational_incident',${command.code},${`incident_${command.action}`},${command.note},${JSON.stringify({ ...details, signalCount: count, sampledAt: overview.sampledAt })}::text::jsonb)`;
    return { replayed: false };
  });
}
