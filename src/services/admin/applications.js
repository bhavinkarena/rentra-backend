import 'server-only';

import crypto from 'node:crypto';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';

/**
 * Gate 1 review (CP05): bounded queue, reviewer assignment and decisions tied
 * to the reviewed `client_application.review_version`.
 *
 * Every submit, withdraw and decision bumps that version inside the same
 * statement or transaction, so a decision made from a stale screen — the
 * client resubmitted, withdrew, or another reviewer decided first — commits
 * nothing and answers 409. Exactly one decision audit entry exists per
 * reviewed version. There is no client decision notification channel yet;
 * the client sees the outcome in the partner workspace.
 */

export const SLA_HOURS = 48;
const PAGE_SIZE = 20;
const STATUSES = ['submitted', 'more_info_needed', 'approved', 'rejected', 'draft'];
export const FLAGGABLE = ['phone', 'details', 'kyc', 'payout', 'consent'];

/** What a reviewer judged. Compared by keyed hash so the audit log never stores the values. */
const REVIEWED_FIELDS = {
  name: (r) => r.user_name,
  phone: (r) => r.phone,
  clientType: (r) => r.client_type,
  legalName: (r) => r.legal_name,
  residentialAddress: (r) => r.residential_address,
  pincode: (r) => r.pincode,
  ownerName: (r) => r.owner_name,
  ownerRelationship: (r) => r.owner_relationship,
  kycDocType: (r) => r.kyc_doc_type,
  kycNameOnDoc: (r) => r.kyc_name_on_doc,
  payoutDestination: (r) => [r.payout_upi_id, r.payout_account_ref, r.payout_ifsc].join('|'),
  payoutHolderName: (r) => r.payout_holder_name,
  documents: (r) => r.document_fingerprint,
};

export const applicationQueueQuery = z.object({
  status: z.enum(['all', ...STATUSES]).default('submitted'),
  assignee: z.enum(['any', 'me', 'unassigned']).default('any'),
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});

const decisionInput = z.object({
  reason: z.string().trim().max(1000).default(''),
  flagged: z.array(z.enum(FLAGGABLE)).default([]),
  expectedVersion: z.coerce.number().int().min(1),
});

function fieldHashes(row) {
  const key = process.env.SESSION_SECRET ?? '';
  return Object.fromEntries(
    Object.entries(REVIEWED_FIELDS).map(([field, pick]) => [
      field,
      crypto.createHmac('sha256', key).update(`${field}\u0000${pick(row) ?? ''}`).digest('hex').slice(0, 24),
    ]),
  );
}

/** Application row plus everything its field fingerprint needs. */
const reviewRow = (sql, where) => sql`SELECT a.*, u.name AS user_name, u.phone, u.client_type,
    u.account_status, u.email,
    (SELECT string_agg(d.doc_type || ':' || d.side || ':' || d.storage_key || ':' || d.status, ',' ORDER BY d.doc_type, d.side)
       FROM document d WHERE d.owner_type='client_application' AND d.owner_id=a.id AND d.deleted_at IS NULL) AS document_fingerprint
  FROM client_application a JOIN "user" u ON u.id=a.user_id WHERE ${where}`;

export async function listApplications(database, adminId, input = {}) {
  const f = applicationQueueQuery.parse(input);
  const match = database`(${f.q} = '' OR position(lower(${f.q}) in lower(coalesce(a.legal_name,''))) > 0
    OR position(lower(${f.q}) in lower(coalesce(u.email,''))) > 0
    OR position(lower(${f.q}) in lower(coalesce(u.name,''))) > 0)`;
  const assignee =
    f.assignee === 'me'
      ? database`a.assigned_to=${adminId}`
      : f.assignee === 'unassigned'
        ? database`a.assigned_to IS NULL`
        : database`true`;
  const [counts] = await database`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE a.status='submitted')::int AS submitted,
      count(*) FILTER (WHERE a.status='more_info_needed')::int AS more_info_needed,
      count(*) FILTER (WHERE a.status='approved')::int AS approved,
      count(*) FILTER (WHERE a.status='rejected')::int AS rejected,
      count(*) FILTER (WHERE a.status='draft')::int AS draft,
      count(*) FILTER (WHERE a.status='submitted' AND a.submitted_at < now() - ${SLA_HOURS} * interval '1 hour')::int AS overdue
    FROM client_application a JOIN "user" u ON u.id=a.user_id WHERE ${match} AND ${assignee}`;
  const total = f.status === 'all' ? counts.total : counts[f.status];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const status = f.status === 'all' ? database`true` : database`a.status=${f.status}`;
  // Oldest waiting first for the work queue; most recently changed first otherwise.
  const order =
    f.status === 'submitted'
      ? database`a.submitted_at ASC NULLS LAST, a.id`
      : database`a.updated_at DESC, a.id`;
  const rows = await database`SELECT a.id, a.status, a.legal_name, a.submitted_at, a.reviewed_at,
      a.updated_at, a.strike_count, a.payout_name_match, a.review_version, a.assigned_to,
      coalesce(jsonb_array_length(a.flagged_fields), 0) AS flagged_count,
      u.id AS user_id, u.email, u.client_type, u.account_status, ad.email AS assignee_email,
      round(extract(epoch FROM (now() - a.submitted_at)) / 3600)::int AS age_hours,
      (SELECT count(*)::int FROM audit_log l WHERE l.entity='client_application'
        AND l.entity_id=a.id::text AND l.action='application_submitted') AS submissions,
      (SELECT count(*)::int FROM audit_log l WHERE l.actor_id=u.id AND l.action='locked_cta_click') AS cta_clicks
    FROM client_application a JOIN "user" u ON u.id=a.user_id
    LEFT JOIN admin_user ad ON ad.id=a.assigned_to
    WHERE ${match} AND ${assignee} AND ${status}
    ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  return {
    status: f.status,
    assignee: f.assignee,
    q: f.q,
    page,
    pages,
    pageSize: PAGE_SIZE,
    total,
    slaHours: SLA_HOURS,
    counts: {
      all: counts.total,
      ...Object.fromEntries(STATUSES.map((key) => [key, counts[key]])),
      overdue: counts.overdue,
    },
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      legalName: r.legal_name,
      email: r.email,
      userId: r.user_id,
      clientType: r.client_type,
      accountStatus: r.account_status,
      submittedAt: r.submitted_at,
      updatedAt: r.updated_at,
      ageHours: r.status === 'submitted' ? r.age_hours : null,
      overdue: r.status === 'submitted' && (r.age_hours ?? 0) > SLA_HOURS,
      strikeCount: r.strike_count,
      blocker: r.payout_name_match === false ? 'payout name mismatch' : null,
      reviewVersion: r.review_version,
      assignee: r.assigned_to ? { id: r.assigned_to, email: r.assignee_email } : null,
      assignedToMe: r.assigned_to === adminId,
      flaggedCount: r.flagged_count,
      resubmission: r.submissions > 1,
      ctaClicks: r.cta_clicks,
    })),
  };
}

/** Assignment, last decision and which reviewed fields changed since it. */
export async function readReviewContext(database, applicationId, adminId) {
  const [row] = await reviewRow(database, database`a.id=${applicationId}`);
  if (!row) return null;
  const [assignee] = row.assigned_to
    ? await database`SELECT id, email FROM admin_user WHERE id=${row.assigned_to}`
    : [];
  const [last] = await database`SELECT action, at, before->'fieldHashes' AS hashes FROM audit_log
    WHERE entity='client_application' AND entity_id=${applicationId}
      AND action IN ('application_more_info','application_rejected','application_approved')
    ORDER BY at DESC LIMIT 1`;
  const [{ submissions, waiting_hours }] = await database`SELECT
      (SELECT count(*)::int FROM audit_log WHERE entity='client_application'
        AND entity_id=${applicationId} AND action='application_submitted') AS submissions,
      (SELECT round(extract(epoch FROM (now() - submitted_at)) / 3600)::int
        FROM client_application WHERE id=${applicationId} AND status='submitted') AS waiting_hours`;
  const current = fieldHashes(row);
  const changed = last?.hashes
    ? Object.keys(current).filter((field) => last.hashes[field] !== current[field])
    : null;
  return {
    reviewVersion: row.review_version,
    assignee: assignee ? { id: assignee.id, email: assignee.email } : null,
    assignedToMe: row.assigned_to === adminId,
    assignedAt: row.assigned_at,
    submissions,
    waitingHours: waiting_hours,
    overdue: waiting_hours != null && waiting_hours > SLA_HOURS,
    lastDecision: last ? { action: last.action, at: last.at } : null,
    changedSinceLastDecision: changed,
  };
}

export async function assignApplication(database, { adminId, applicationId, action, ip = null }) {
  if (!['claim', 'release', 'takeover'].includes(action)) throw unprocessable({ action: 'Unknown action.' });
  return database.begin(async (tx) => {
    const [app] = await tx`SELECT a.id, a.assigned_to, ad.email AS assignee_email FROM client_application a
      LEFT JOIN admin_user ad ON ad.id=a.assigned_to WHERE a.id=${applicationId} FOR UPDATE OF a`;
    if (!app) throw notFound('APPLICATION_NOT_FOUND', 'No such application.');
    if (action === 'claim' && app.assigned_to && app.assigned_to !== adminId) {
      throw conflict('ASSIGNED_ELSEWHERE', `Already assigned to ${app.assignee_email}. Take over only if you have agreed it.`);
    }
    if (action === 'release' && app.assigned_to !== adminId) {
      throw conflict('NOT_ASSIGNED_TO_YOU', 'Only the assigned reviewer can release this application.');
    }
    const next = action === 'release' ? null : adminId;
    if (app.assigned_to === next) return { applicationId, assignedTo: next };
    await tx`UPDATE client_application SET assigned_to=${next},
        assigned_at=${next ? tx`now()` : null}, updated_at=now() WHERE id=${app.id}`;
    await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, before, after, ip)
      VALUES ('admin', ${adminId}, 'client_application', ${app.id}, ${`application_${action === 'release' ? 'released' : action === 'takeover' ? 'taken_over' : 'claimed'}`},
        ${JSON.stringify({ assignedTo: app.assigned_to })}::text::jsonb, ${JSON.stringify({ assignedTo: next })}::text::jsonb, ${ip})`;
    return { applicationId, assignedTo: next };
  });
}

/**
 * approve | more_info | reject, in one transaction: lock the client, then the
 * application; check version, status, assignment and account state; update;
 * write the single decision audit entry with the field fingerprint.
 */
export async function decideApplication(database, { adminId, applicationId, decision, input, ip = null }) {
  const parsed = decisionInput.safeParse({
    ...input,
    flagged: [].concat(input?.flagged ?? []).filter(Boolean),
  });
  if (!parsed.success) {
    throw unprocessable(Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])));
  }
  const { reason, flagged, expectedVersion } = parsed.data;
  if (decision !== 'approve' && reason.length < 4) {
    throw unprocessable({ reason: 'Say what is needed — the client sees this verbatim.' });
  }
  if (decision === 'more_info' && !flagged.length) {
    throw unprocessable({ flagged: 'Choose at least one step the client must correct.' });
  }

  return database.begin(async (tx) => {
    const [owner] = await tx`SELECT u.id, u.account_status FROM "user" u
      JOIN client_application a ON a.user_id=u.id WHERE a.id=${applicationId} FOR UPDATE OF u`;
    if (!owner) throw notFound('APPLICATION_NOT_FOUND', 'No such application.');
    const [app] = await reviewRow(tx, tx`a.id=${applicationId} FOR UPDATE OF a`);
    if (app.review_version !== expectedVersion) {
      throw conflict(
        'APPLICATION_CHANGED',
        'This application changed after you opened it — resubmitted, withdrawn or already decided. Reload before deciding.',
      );
    }
    if (app.status !== 'submitted') {
      throw conflict('APPLICATION_NOT_SUBMITTED', `This application is "${app.status.replaceAll('_', ' ')}" and is not awaiting a decision.`);
    }
    if (app.assigned_to && app.assigned_to !== adminId) {
      throw conflict('ASSIGNED_ELSEWHERE', 'Another reviewer is assigned. Take over the application before deciding.');
    }
    if (decision === 'approve') {
      if (app.payout_name_match === false) {
        throw conflict('APPROVAL_BLOCKED', 'A confirmed payout name mismatch blocks approval. Request more information instead.');
      }
      if (owner.account_status !== 'pending_application') {
        throw conflict('ACCOUNT_NOT_PENDING', `The client account is "${owner.account_status.replaceAll('_', ' ')}"; approval would change it. Resolve the account first.`);
      }
    }

    const strikes = decision === 'reject' ? app.strike_count + 1 : app.strike_count;
    const blocked = decision === 'reject' && strikes >= 3;
    const status = { approve: 'approved', more_info: 'more_info_needed', reject: 'rejected' }[decision];
    const [updated] = await tx`UPDATE client_application SET status=${status},
        reviewed_at=now(), reviewed_by=${adminId}, decision_reason=${reason || null},
        flagged_fields=${decision === 'more_info' ? JSON.stringify(flagged) : null}::text::jsonb,
        strike_count=${strikes},
        submitted_at=${decision === 'approve' ? app.submitted_at : null},
        review_version=review_version+1,
        assigned_to=coalesce(assigned_to, ${adminId}), assigned_at=coalesce(assigned_at, now()),
        updated_at=now()
      WHERE id=${app.id} RETURNING review_version`;
    if (decision === 'approve') {
      // "verified" here means reviewed by Rentra staff; no KYC provider is connected.
      await tx`UPDATE "user" SET account_status='active', kyc_status='verified', updated_at=now() WHERE id=${owner.id}`;
    } else if (blocked) {
      await tx`UPDATE "user" SET account_status='blocked', updated_at=now() WHERE id=${owner.id}`;
    }
    await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, before, after, reason, ip)
      VALUES ('admin', ${adminId}, 'client_application', ${app.id},
        ${{ approve: 'application_approved', more_info: 'application_more_info', reject: 'application_rejected' }[decision]},
        ${JSON.stringify({ status: app.status, reviewVersion: app.review_version, fieldHashes: fieldHashes(app) })}::text::jsonb,
        ${JSON.stringify({ status, reviewVersion: updated.review_version, ...(decision === 'more_info' ? { flagged } : {}), ...(decision === 'reject' ? { strikeCount: strikes, accountBlocked: blocked } : {}) })}::text::jsonb,
        ${reason || null}, ${ip})`;
    return { applicationId: app.id, status, reviewVersion: updated.review_version, accountBlocked: blocked };
  });
}
