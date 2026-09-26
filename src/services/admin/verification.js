import 'server-only';

import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { revalidateListing } from '@/services/cache/listing-cache.js';
import { listingCompletion } from '../domain/listing-completion.js';

/**
 * Verification scheduling and publication (CP07).
 *
 * Qualifying evidence policy (recorded decision): a property publishes only
 * after a COMPLETED verification of the exact submitted revision it will
 * publish, with outcome `passed`, every checklist item confirmed and written
 * findings. A physical visit also records on-site coordinates. There is no
 * waiver path in this part. Evidence stays admin-only; public pages never read
 * it. Publication does not claim bookability: `inventory` reports whether the
 * owner has confirmed schedules and opened dates.
 */

export const CHECKLIST = [
  ['ownerIdentity', 'Met the owner or authorised agent; identity matches the approved application'],
  ['matchesPhotos', 'The property matches the submitted photos'],
  ['amenitiesPresent', 'Claimed amenities are present and usable'],
  ['locationMatches', 'Address and map location match the submission'],
  ['ownershipOriginal', 'Original ownership or authority document sighted'],
  ['safeForGuests', 'No safety concern that should stop guests visiting'],
];
const CHECKLIST_KEYS = CHECKLIST.map(([key]) => key);
const TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const uuid = z.string().uuid();

const fields = (error) =>
  Object.fromEntries(error.issues.map((issue) => [issue.path[0] ?? '_', issue.message]));

/** `YYYY-MM-DDTHH:mm` entered in the property timezone (IST) → instant. */
const localTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Choose a date and time.')
  .transform((value) => new Date(`${value}:00${IST_OFFSET}`))
  .refine((date) => !Number.isNaN(date.getTime()), 'Choose a valid date and time.')
  .refine((date) => date.getTime() > Date.now(), 'Choose a time in the future.')
  .refine(
    (date) => date.getTime() < Date.now() + 90 * 24 * 3600 * 1000,
    'Schedule within the next 90 days.',
  );

const scheduleInput = z.object({
  submissionId: uuid,
  mode: z.enum(['video_call', 'physical']),
  scheduledAt: localTime,
  note: z.string().trim().max(500).default(''),
});
const rescheduleInput = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  scheduledAt: localTime,
  reason: z.string().trim().min(4, 'Say why it moved.').max(500),
});
const cancelInput = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  reason: z.string().trim().min(4, 'Say why it was cancelled.').max(500),
});
const outcomeInput = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  outcome: z.enum(['passed', 'failed', 'no_show']),
  findings: z.string().trim().max(4000).default(''),
  checklist: z.array(z.enum(CHECKLIST_KEYS)).default([]),
  geoLat: z.union([z.literal(''), z.coerce.number().min(-90).max(90)]).optional(),
  geoLng: z.union([z.literal(''), z.coerce.number().min(-180).max(180)]).optional(),
});

async function lockProperty(tx, id) {
  if (!uuid.safeParse(id).success) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  const [owner] = await tx`SELECT u.id, u.account_status FROM "user" u
    JOIN rentable r ON r.client_id=u.id WHERE r.id=${id} FOR SHARE OF u`;
  const [row] = await tx`SELECT * FROM rentable WHERE id=${id} FOR UPDATE`;
  if (!row) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  return { row, ownerActive: owner?.account_status === 'active' };
}

/** The current submission and its Gate 2 decision; null when none applies. */
async function reviewedRevision(tx, row) {
  const [submission] = await tx`SELECT s.*, lr.outcome AS review_outcome
    FROM listing_submission s LEFT JOIN listing_review lr ON lr.submission_id=s.id
    WHERE s.rentable_id=${row.id} AND s.pass_number=${row.review_pass}`;
  return submission ?? null;
}

function revisionCurrent(row, submission) {
  return Boolean(
    submission &&
      submission.review_outcome === 'approved_for_visit' &&
      submission.content_version === row.content_version,
  );
}

async function audit(tx, { adminId, id, action, after, reason = null, ip = null }) {
  await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, after, reason, ip)
    VALUES ('admin', ${adminId}, 'rentable', ${id}, ${action},
      ${JSON.stringify(after)}::text::jsonb, ${reason}, ${ip})`;
}

async function inventory(database, id, row) {
  const config = row.booking_config;
  const [{ open }] = await database`SELECT count(*)::int AS open FROM availability
    WHERE rentable_id=${id} AND day >= (now() AT TIME ZONE ${TIME_ZONE})::date
      AND units_available > 0 AND blocked_by_client = false`;
  const scheduleReady = config?.inventoryReady === true;
  return {
    scheduleReady,
    openDates: open,
    bookable: scheduleReady && open > 0,
    note: !scheduleReady
      ? 'Not bookable yet: the owner has not confirmed booking hours.'
      : open === 0
        ? 'Not bookable yet: no open dates on the calendar.'
        : 'Bookable on the open dates the owner has published.',
  };
}

/** Publication eligibility with the reasons it is blocked, for the admin screen and the command. */
export async function publicationState(database, id) {
  const [row] = await database`SELECT * FROM rentable WHERE id=${id}`;
  if (!row) return null;
  const [owner] = await database`SELECT account_status FROM "user" WHERE id=${row.client_id}`;
  const submission = await reviewedRevision(database, row);
  const [visit] = submission
    ? await database`SELECT * FROM verification_visit WHERE submission_id=${submission.id}
        AND outcome='passed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1`
    : [];
  const blockers = [];
  if (row.status === 'live') blockers.push('Already published.');
  else if (row.status !== 'pending_verification')
    blockers.push('The property is not waiting for verification.');
  if (owner?.account_status !== 'active') blockers.push('The client account is not active.');
  if (!submission || submission.review_outcome !== 'approved_for_visit')
    blockers.push('The current submission has not been approved for verification.');
  else if (submission.content_version !== row.content_version)
    blockers.push('The property changed after submission; it needs a new review.');
  if (submission && listingCompletion(submission.snapshot.listing, submission.snapshot).remaining.length)
    blockers.push('The submitted revision is incomplete.');
  if (!visit) blockers.push('No passed verification of this exact revision is recorded.');
  return {
    eligible: blockers.length === 0,
    blockers,
    submissionId: submission?.id ?? null,
    visitId: visit?.id ?? null,
    inventory: await inventory(database, id, row),
    publishedAt: row.published_at,
    publishedSubmissionId: row.published_submission_id,
  };
}

export async function listVerifications(database, id) {
  const rows = await database`SELECT v.*, a.email AS assignee_email, r.email AS recorder_email
    FROM verification_visit v
    LEFT JOIN admin_user a ON a.id=v.assigned_to
    LEFT JOIN admin_user r ON r.id=v.recorded_by
    WHERE v.rentable_id=${id} ORDER BY v.created_at DESC`;
  return rows.map((v) => ({
    id: v.id,
    submissionId: v.submission_id,
    mode: v.mode,
    status: v.cancelled_at ? 'cancelled' : v.completed_at ? 'completed' : 'scheduled',
    scheduledAt: v.scheduled_at,
    timeZone: v.time_zone,
    assignee: v.assigned_to ? { id: v.assigned_to, email: v.assignee_email } : null,
    outcome: v.outcome,
    completedAt: v.completed_at,
    recordedBy: v.recorder_email,
    cancelledAt: v.cancelled_at,
    cancelReason: v.cancel_reason,
    report: v.report,
    geo: v.geo_lat != null ? { lat: v.geo_lat, lng: v.geo_lng } : null,
    version: v.version,
    createdAt: v.created_at,
  }));
}

export async function scheduleVerification(database, { adminId, id, input, ip = null }) {
  const parsed = scheduleInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  return database.begin(async (tx) => {
    const { row, ownerActive } = await lockProperty(tx, id);
    if (!ownerActive) throw conflict('CLIENT_NOT_ACTIVE', 'The client account is not active.');
    if (row.status !== 'pending_verification')
      throw conflict('NOT_PENDING_VERIFICATION', 'This property is not waiting for verification.');
    const submission = await reviewedRevision(tx, row);
    if (!revisionCurrent(row, submission) || submission.id !== d.submissionId)
      throw conflict('SUBMISSION_CHANGED', 'Reload: the revision approved for verification changed.');
    const [open] = await tx`SELECT id, submission_id FROM verification_visit
      WHERE rentable_id=${id} AND completed_at IS NULL AND cancelled_at IS NULL FOR UPDATE`;
    if (open && open.submission_id === submission.id)
      throw conflict('VERIFICATION_ALREADY_SCHEDULED', 'A verification is already scheduled. Reschedule it instead.');
    if (open) {
      // A visit for an older revision cannot verify this one.
      await tx`UPDATE verification_visit SET cancelled_at=now(), cancel_reason='Superseded by a newer revision',
        version=version+1 WHERE id=${open.id}`;
    }
    const [visit] = await tx`INSERT INTO verification_visit
        (rentable_id, submission_id, mode, assigned_to, scheduled_at, time_zone, created_by)
      VALUES (${id}, ${submission.id}, ${d.mode}, ${adminId}, ${d.scheduledAt.toISOString()}::timestamptz, ${TIME_ZONE}, ${adminId})
      RETURNING id, version`;
    await audit(tx, {
      adminId,
      id,
      action: 'verification_scheduled',
      after: { visitId: visit.id, submissionId: submission.id, mode: d.mode, scheduledAt: d.scheduledAt },
      reason: d.note || null,
      ip,
    });
    return { visitId: visit.id, version: visit.version };
  });
}

async function lockOpenVisit(tx, id, visitId, expectedVersion) {
  if (!uuid.safeParse(visitId).success) throw notFound('VERIFICATION_NOT_FOUND', 'Verification not found.');
  const [visit] = await tx`SELECT * FROM verification_visit WHERE id=${visitId} AND rentable_id=${id} FOR UPDATE`;
  if (!visit) throw notFound('VERIFICATION_NOT_FOUND', 'Verification not found.');
  if (visit.completed_at || visit.cancelled_at)
    throw conflict('VERIFICATION_CLOSED', 'This verification is already completed or cancelled.');
  if (visit.version !== expectedVersion)
    throw conflict('VERIFICATION_CHANGED', 'This verification changed after you opened it. Reload.');
  return visit;
}

export async function rescheduleVerification(database, { adminId, id, visitId, input, ip = null }) {
  const parsed = rescheduleInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  return database.begin(async (tx) => {
    await lockProperty(tx, id);
    const visit = await lockOpenVisit(tx, id, visitId, d.expectedVersion);
    const [updated] = await tx`UPDATE verification_visit SET scheduled_at=${d.scheduledAt.toISOString()}::timestamptz, version=version+1
      WHERE id=${visit.id} RETURNING version`;
    await audit(tx, {
      adminId,
      id,
      action: 'verification_rescheduled',
      after: { visitId: visit.id, from: visit.scheduled_at, to: d.scheduledAt },
      reason: d.reason,
      ip,
    });
    return { visitId: visit.id, version: updated.version };
  });
}

export async function cancelVerification(database, { adminId, id, visitId, input, ip = null }) {
  const parsed = cancelInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  return database.begin(async (tx) => {
    await lockProperty(tx, id);
    const visit = await lockOpenVisit(tx, id, visitId, d.expectedVersion);
    await tx`UPDATE verification_visit SET cancelled_at=now(), cancel_reason=${d.reason}, version=version+1
      WHERE id=${visit.id}`;
    await audit(tx, { adminId, id, action: 'verification_cancelled', after: { visitId: visit.id }, reason: d.reason, ip });
    return { visitId: visit.id };
  });
}

/**
 * passed: evidence complete for the current revision; the property stays
 * pending verification until someone publishes. failed: back to the client
 * as a draft with the findings as the reason. no_show: closes the visit.
 */
export async function recordVerificationOutcome(database, { adminId, id, visitId, input, ip = null }) {
  const parsed = outcomeInput.safeParse({
    ...input,
    checklist: [].concat(input?.checklist ?? []).filter(Boolean),
  });
  if (!parsed.success) throw unprocessable(fields(parsed.error));
  const d = parsed.data;
  return database.begin(async (tx) => {
    const { row } = await lockProperty(tx, id);
    const visit = await lockOpenVisit(tx, id, visitId, d.expectedVersion);
    const submission = await reviewedRevision(tx, row);
    if (
      row.status !== 'pending_verification' ||
      !revisionCurrent(row, submission) ||
      submission.id !== visit.submission_id
    )
      throw conflict(
        'REVISION_CHANGED',
        'The property changed after this verification was scheduled. Cancel it; the client must resubmit.',
      );
    if (d.outcome !== 'no_show' && d.findings.length < 20)
      throw unprocessable({ findings: 'Write at least 20 characters of findings.' });
    const geo = d.geoLat !== undefined && d.geoLat !== '' && d.geoLng !== undefined && d.geoLng !== '';
    if (d.outcome === 'passed') {
      const missing = CHECKLIST_KEYS.filter((key) => !d.checklist.includes(key));
      if (missing.length)
        throw unprocessable({ checklist: 'Confirm every checklist item, or record the verification as failed.' });
      if (visit.mode === 'physical' && !geo)
        throw unprocessable({ geoLat: 'Record the on-site coordinates for a physical visit.' });
    }
    const report = {
      checklist: Object.fromEntries(CHECKLIST_KEYS.map((key) => [key, d.checklist.includes(key)])),
      findings: d.findings,
    };
    await tx`UPDATE verification_visit SET outcome=${d.outcome}, completed_at=now(), recorded_by=${adminId},
        report=${JSON.stringify(report)}::text::jsonb,
        geo_lat=${geo ? d.geoLat : null}, geo_lng=${geo ? d.geoLng : null}, version=version+1
      WHERE id=${visit.id}`;
    if (d.outcome === 'failed') {
      await tx`UPDATE rentable SET status='draft', rejection_reason=${d.findings}, updated_at=now() WHERE id=${id}`;
    }
    await audit(tx, {
      adminId,
      id,
      action: 'verification_recorded',
      after: { visitId: visit.id, submissionId: visit.submission_id, outcome: d.outcome, mode: visit.mode },
      reason: d.findings || null,
      ip,
    });
    return { visitId: visit.id, outcome: d.outcome, status: d.outcome === 'failed' ? 'draft' : row.status };
  });
}

export async function publishProperty(database, { adminId, id, input, ip = null }) {
  const submissionId = input?.submissionId;
  if (!uuid.safeParse(submissionId).success)
    throw unprocessable({ submissionId: 'Reload and publish the reviewed revision.' });
  const result = await database.begin(async (tx) => {
    const { row } = await lockProperty(tx, id);
    const state = await publicationState(tx, id);
    if (state.submissionId !== submissionId)
      throw conflict('SUBMISSION_CHANGED', 'Reload: the reviewed revision changed.');
    if (!state.eligible) throw conflict('PUBLICATION_BLOCKED', state.blockers.join(' '));
    const [submission] = await tx`SELECT snapshot FROM listing_submission WHERE id=${submissionId}`;
    const [visit] = await tx`SELECT completed_at, recorded_by FROM verification_visit WHERE id=${state.visitId}`;
    await tx`UPDATE rentable SET status='live', prior_status=NULL, rejection_reason=NULL,
        verified_at=${new Date(visit.completed_at).toISOString()}::timestamptz, verified_by=${visit.recorded_by},
        approved_snapshot=${JSON.stringify(submission.snapshot)}::text::jsonb,
        published_submission_id=${submissionId}, published_at=now(), published_by=${adminId}, updated_at=now()
      WHERE id=${id}`;
    await audit(tx, {
      adminId,
      id,
      action: 'listing_published',
      after: {
        submissionId,
        contentVersion: row.content_version,
        visitId: state.visitId,
        bookable: state.inventory.bookable,
      },
      ip,
    });
    return { row, state };
  });
  revalidateListing(
    { id, slug: result.row.slug, publicCode: result.row.public_code },
    { statusChanged: true },
  );
  return { id, status: 'live', submissionId, inventory: result.state.inventory };
}
