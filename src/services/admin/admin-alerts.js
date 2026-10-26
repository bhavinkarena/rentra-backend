import { notFound } from '@/utils/apiError.js';
import { ownerChannelAdapter, ownerChannelConfiguration } from '../notifications/owner-delivery.js';

/**
 * Stories 1.6/1.7: durable reviewer alerts with a tracked email per alert.
 *
 * Recipients (user decision, 26 Oct 2026): the property's assigned reviewer
 * when that admin is active and may write property reviews; otherwise every
 * such admin. Each (admin, event) pair exists once, so replays, restarts and
 * missed ticks can never duplicate an alert.
 */
export const CORRECTION_MILESTONE_DAYS = [7, 15, 30];

const TITLES = {
  property_resubmitted: (d) => `Owner resubmitted “${d.title}” (pass ${d.pass})`,
  correction_unanswered: (d) =>
    `Correction unanswered for ${d.days} days: “${d.title}” (pass ${d.pass})`,
};
export const alertTitle = (row) => TITLES[row.kind]?.(row.detail ?? {}) ?? 'Rentra review alert';

async function recipients(tx, assignedTo) {
  const reviewers = await tx`SELECT id FROM admin_user
    WHERE is_active AND (permissions IS NULL OR permissions ? 'admin.properties.write')`;
  const ids = reviewers.map((r) => r.id);
  if (assignedTo && ids.includes(assignedTo)) return [assignedTo];
  if (ids.length) return ids;
  // Nobody holds property write access: alert every active admin rather than nobody.
  return (await tx`SELECT id FROM admin_user WHERE is_active`).map((r) => r.id);
}

export async function raiseAdminAlert(tx, { kind, eventKey, rentableId, submissionId = null, detail, assignedTo }) {
  for (const adminId of await recipients(tx, assignedTo)) {
    await tx`INSERT INTO admin_alert(admin_id, event_key, kind, rentable_id, submission_id, detail)
      VALUES (${adminId}, ${eventKey}, ${kind}, ${rentableId}, ${submissionId},
        ${JSON.stringify(detail)}::text::jsonb)
      ON CONFLICT (admin_id, event_key) DO NOTHING`;
  }
}

/**
 * Story 1.7: day 7, 15 and 30 milestones counted from the original decision
 * instant, not from each other. A late or restarted scan raises every reached
 * milestone once. A newer submission (resubmitted) or any status other than
 * draft (closed) stops further milestones; draft saves alone do not. Nothing
 * here rejects or changes the property.
 */
export async function scheduleCorrectionMilestones(database, now = new Date()) {
  const due = await database`SELECT lr.id, lr.rentable_id, lr.submission_id, lr.pass_number, lr.reviewed_at,
      s.assigned_to, r.title
    FROM listing_review lr
    JOIN rentable r ON r.id=lr.rentable_id
    JOIN listing_submission s ON s.id=lr.submission_id
    WHERE lr.outcome='changes_requested' AND r.status='draft' AND r.review_pass=lr.pass_number
      AND lr.reviewed_at <= ${now.toISOString()}::timestamptz - interval '7 days'`;
  let raised = 0;
  for (const review of due) {
    for (const days of CORRECTION_MILESTONE_DAYS) {
      if (+new Date(review.reviewed_at) + days * 86400000 > +now) continue;
      await database.begin((tx) =>
        raiseAdminAlert(tx, {
          kind: 'correction_unanswered',
          eventKey: `unanswered:${review.id}:${days}`,
          rentableId: review.rentable_id,
          submissionId: review.submission_id,
          detail: { days, pass: review.pass_number, title: review.title, requestedAt: review.reviewed_at },
          assignedTo: review.assigned_to,
        }),
      );
      raised++;
    }
  }
  return raised;
}

/** Sends due alert emails. Failures stay visible on the row; the alert itself is never removed. */
export async function deliverAdminAlertEmails(database, options = {}) {
  const env = options.env || process.env;
  let config;
  try {
    config = ownerChannelConfiguration('email', 'admin_alert', env);
    new URL(env.NEXT_PUBLIC_SITE_URL);
  } catch (error) {
    // Visible on every waiting alert; retried automatically once delivery is configured.
    await database`UPDATE admin_alert SET email_state='blocked',
      email_failure=${error.code ?? 'SITE_URL_REQUIRED'} WHERE email_state IN ('pending','retry','blocked')`;
    return 0;
  }
  // A send that never finished gives up after the attempt cap instead of looping.
  await database`UPDATE admin_alert SET email_state='failed', email_failure='DELIVERY_OUTCOME_UNKNOWN'
    WHERE email_state='sending' AND email_next_at<=now() AND email_attempts>=5`;
  // Ten rows at a 10 s provider timeout fit inside the 3-minute lease.
  const claimed = await database`UPDATE admin_alert SET email_state='sending', email_attempts=email_attempts+1,
      email_next_at=now()+interval '3 minutes'
    WHERE id IN (SELECT id FROM admin_alert
      WHERE email_state IN ('pending','retry','blocked','sending') AND email_next_at<=now()
      ORDER BY email_next_at LIMIT 10 FOR UPDATE SKIP LOCKED)
    RETURNING id, admin_id, kind, rentable_id, detail, email_attempts`;
  const adapter = options.adapter?.(config) || ownerChannelAdapter(config, options.fetcher);
  const origin = new URL(env.NEXT_PUBLIC_SITE_URL).origin;
  let sent = 0;
  for (const row of claimed) {
    const [admin] = await database`SELECT email, is_active FROM admin_user WHERE id=${row.admin_id}`;
    if (!admin?.is_active || !admin.email) {
      await database`UPDATE admin_alert SET email_state='failed', email_failure='RECIPIENT_UNAVAILABLE' WHERE id=${row.id}`;
      continue;
    }
    const title = alertTitle(row);
    try {
      const outcome = await adapter.send(
        { id: row.id, recipient: admin.email, title },
        `${title}\n\nOpen the review: ${origin}/admin/properties/${row.rentable_id}`,
      );
      await database`UPDATE admin_alert SET email_state='sent', email_provider_id=${outcome.id},
        email_sent_at=now(), email_failure=NULL WHERE id=${row.id}`;
      sent++;
    } catch (error) {
      // The provider idempotency key (per alert id) makes a retry after an unknown outcome safe.
      const final = row.email_attempts >= 5;
      await database`UPDATE admin_alert SET email_state=${final ? 'failed' : 'retry'},
        email_failure=${/^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'DELIVERY_FAILED'},
        email_next_at=now() + ${`${2 ** row.email_attempts} minutes`}::interval WHERE id=${row.id}`;
    }
  }
  return sent;
}

export async function runAdminAlertJobs(database, options = {}) {
  await scheduleCorrectionMilestones(database);
  return deliverAdminAlertEmails(database, options);
}

/** Admin portal inbox: only the signed-in admin's own alerts. */
export async function listAdminAlerts(database, adminId) {
  const rows = await database`SELECT id, kind, rentable_id, submission_id, detail, created_at, read_at,
      email_state, email_failure
    FROM admin_alert WHERE admin_id=${adminId} ORDER BY read_at IS NOT NULL, created_at DESC LIMIT 50`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: alertTitle(r),
    propertyId: r.rentable_id,
    submissionId: r.submission_id,
    createdAt: r.created_at,
    read: Boolean(r.read_at),
    email: { state: r.email_state, failure: r.email_failure },
  }));
}

export async function markAdminAlertRead(database, { adminId, alertId }) {
  const [row] = await database`UPDATE admin_alert SET read_at=coalesce(read_at, now())
    WHERE id=${alertId} AND admin_id=${adminId} RETURNING id`;
  if (!row) throw notFound('ALERT_NOT_FOUND', 'Alert not found.');
  return { ok: true };
}

