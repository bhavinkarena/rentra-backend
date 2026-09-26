import 'server-only';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { listingCompletion } from '../domain/listing-completion.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';
import { rentable } from '../db/schema/index.js';
import { CHECKLIST, listVerifications, publicationState } from './verification.js';

export const REVIEW_SECTIONS = [
  'basics',
  'location',
  'capacity',
  'amenities',
  'rules',
  'pricing',
  'terms',
  'photos',
  'ownership',
];
export const listingQueueQuery = z.object({
  status: z
    .enum(['pending_review', 'pending_verification', 'draft', 'rejected', 'all'])
    .default('pending_review'),
  assignee: z.enum(['any', 'me', 'unassigned']).default('any'),
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const camel = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value,
    ]),
  );
const decisionSchema = z.object({
  submissionId: z.string().uuid(),
  outcome: z.enum(['changes_requested', 'rejected', 'approved_for_visit']),
  reason: z.string().trim().min(4).max(2000),
  flagged: z.array(z.enum(REVIEW_SECTIONS)).default([]),
});

async function lockedListing(tx, id, clientId) {
  const [owner] =
    await tx`SELECT u.id,u.account_status FROM "user" u JOIN rentable r ON r.client_id=u.id WHERE r.id=${id} FOR SHARE OF u`;
  const [row] = await tx`SELECT * FROM rentable WHERE id=${id} FOR UPDATE`;
  if (!row || (clientId && row.client_id !== clientId))
    throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  if (owner?.account_status !== 'active')
    throw conflict(
      'CLIENT_NOT_ACTIVE',
      'The client must be active before this property can be submitted or reviewed.',
    );
  return row;
}

/** Called while holding the property lock; child writes take the same lock via triggers. */
async function snapshot(tx, row) {
  const prices =
    await tx`SELECT slot,weekday,weekend FROM rentable_price WHERE rentable_id=${row.id} ORDER BY slot`;
  const amenities =
    await tx`SELECT a.id AS amenity_id,a.label_en,a.slug,ra.value FROM rentable_amenity ra JOIN amenity a ON a.id=ra.amenity_id WHERE ra.rentable_id=${row.id} ORDER BY a.id`;
  const documents =
    await tx`SELECT id,doc_type,side,status,review_note,name_on_document,issued_at,uploaded_at FROM document WHERE owner_type='rentable' AND owner_id=${row.id} AND deleted_at IS NULL ORDER BY id`;
  const [place] =
    await tx`SELECT c.name AS city,a.name AS area,cat.name AS category FROM rentable r LEFT JOIN city c ON c.id=r.city_id LEFT JOIN area a ON a.id=r.area_id LEFT JOIN category cat ON cat.id=r.category_id WHERE r.id=${row.id}`;
  // No storage keys, signed links, account credentials or financial history in snapshots.
  const listing = camel(row);
  if (typeof row.location === 'string' && /^[0-9a-f]+$/i.test(row.location))
    listing.location = rentable.location.mapFromDriverValue(row.location);
  delete listing.approvedSnapshot;
  return {
    listing,
    prices: prices.map(camel),
    amenities: amenities.map(camel),
    documents: documents.map(camel),
    photos: Array.isArray(row.photos) ? row.photos : [],
    place,
  };
}

export async function submitProperty(database, { id, clientId, ip = null }) {
  return database.begin(async (tx) => {
    const row = await lockedListing(tx, id, clientId);
    if (!['draft', 'rejected', 'pending_review'].includes(row.status))
      throw conflict('LISTING_NOT_SUBMITTABLE', 'This property is not waiting for submission.');
    const [latest] =
      await tx`SELECT * FROM listing_submission WHERE rentable_id=${id} ORDER BY pass_number DESC LIMIT 1`;
    if (row.status === 'pending_review' && latest?.content_version === row.content_version)
      throw conflict('ALREADY_SUBMITTED', 'This revision is already waiting for review.');
    const data = await snapshot(tx, row);
    const readiness = listingCompletion(data.listing, data);
    if (readiness.remaining.length)
      throw unprocessable({
        _: `Still to do: ${readiness.remaining.map((s) => s.label).join(', ')}`,
      });
    const pass = row.review_pass + 1;
    const [submission] =
      await tx`INSERT INTO listing_submission(rentable_id,content_version,pass_number,snapshot,submitted_by,assigned_to)
      VALUES (${id},${row.content_version},${pass},${JSON.stringify(data)}::text::jsonb,${clientId},${latest?.assigned_to ?? null}) RETURNING id`;
    await tx`UPDATE rentable SET status='pending_review',review_pass=${pass},rejection_reason=NULL,updated_at=now() WHERE id=${id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,after,ip) VALUES ('client',${clientId},'rentable',${id},'listing_submitted',${JSON.stringify({ submissionId: submission.id, pass, contentVersion: row.content_version })}::text::jsonb,${ip})`;
    return { id, submissionId: submission.id, pass, slug: row.slug, publicCode: row.public_code };
  });
}

export async function propertyReviewContext(database, id) {
  const [row] =
    await database`SELECT s.id,s.pass_number,s.content_version,s.submitted_at,s.assigned_to,
    r.content_version AS current_version,r.status,a.email AS reviewer
    FROM rentable r LEFT JOIN listing_submission s ON s.rentable_id=r.id
    LEFT JOIN admin_user a ON a.id=s.assigned_to WHERE r.id=${id} ORDER BY s.pass_number DESC NULLS LAST LIMIT 1`;
  if (!row) return null;
  return {
    submissionId: row.id,
    pass: row.pass_number,
    submittedAt: row.submitted_at,
    needsResubmission:
      row.status === 'pending_review' && (!row.id || row.content_version !== row.current_version),
    stale: !row.id || row.content_version !== row.current_version,
    assignee: row.assigned_to ? { id: row.assigned_to, email: row.reviewer } : null,
    // Client-safe verification progress: when and how, never the evidence.
    verification: await clientVerification(database, id),
  };
}

async function clientVerification(database, id) {
  const [visit] = await database`SELECT mode, scheduled_at, time_zone FROM verification_visit
    WHERE rentable_id=${id} AND completed_at IS NULL AND cancelled_at IS NULL LIMIT 1`;
  return visit ? { mode: visit.mode, scheduledAt: visit.scheduled_at, timeZone: visit.time_zone } : null;
}

export async function listPropertyReviews(database, adminId, input) {
  const f = listingQueueQuery.parse(input);
  // Conditional fragments: comparing the listing_status enum to 'all' is an error.
  const status = f.status === 'all' ? database`true` : database`r.status=${f.status}`;
  const assignee =
    f.assignee === 'me'
      ? database`s.assigned_to=${adminId}`
      : f.assignee === 'unassigned'
        ? database`s.assigned_to IS NULL`
        : database`true`;
  const filter = database`${status} AND ${assignee}
    AND (${f.q}='' OR position(lower(${f.q}) in lower(r.title))>0 OR position(lower(${f.q}) in lower(coalesce(u.email,'')))>0 OR r.public_code=${f.q})`;
  const join = database`FROM rentable r JOIN "user" u ON u.id=r.client_id
    LEFT JOIN listing_submission s ON s.rentable_id=r.id AND s.pass_number=r.review_pass
    LEFT JOIN admin_user a ON a.id=s.assigned_to WHERE ${filter}`;
  const [{ total }] = await database`SELECT count(*)::int AS total ${join}`;
  const pages = Math.max(1, Math.ceil(total / 20)),
    page = Math.min(f.page, pages);
  const items =
    await database`SELECT r.id,r.title,r.public_code,r.status,r.content_version,r.review_pass,u.email,u.account_status,
    s.id AS submission_id,s.content_version AS submitted_version,s.submitted_at,a.email AS reviewer
    ${join} ORDER BY s.submitted_at ASC NULLS FIRST,r.id LIMIT 20 OFFSET ${(page - 1) * 20}`;
  return { ...f, page, pages, total, items: items.map(camel) };
}

export async function readPropertyReview(database, id) {
  const [owner] =
    await database`SELECT r.id,r.title,r.slug,r.public_code,r.status,r.content_version,r.client_id,u.name,u.email,u.account_status,
    (SELECT id FROM client_application WHERE user_id=u.id) AS application_id FROM rentable r JOIN "user" u ON u.id=r.client_id WHERE r.id=${id}`;
  if (!owner) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  const submissions =
    await database`SELECT s.*,a.email AS reviewer FROM listing_submission s LEFT JOIN admin_user a ON a.id=s.assigned_to WHERE rentable_id=${id} ORDER BY pass_number DESC`;
  const submissionDTO = (s) => ({
    ...camel(s),
    displayPhotos: normalizePublicPhotos(s.snapshot.photos, {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    }),
  });
  const history =
    await database`SELECT l.*,a.email AS reviewer FROM listing_review l LEFT JOIN admin_user a ON a.id=l.reviewed_by WHERE rentable_id=${id} ORDER BY reviewed_at DESC`;
  const current = submissions[0];
  return {
    property: camel(owner),
    current: current ? submissionDTO(current) : null,
    submissions: submissions.map(submissionDTO),
    history: history.map(camel),
    stale: !current || current.content_version !== owner.content_version,
    readiness: current ? listingCompletion(current.snapshot.listing, current.snapshot) : null,
    verifications: await listVerifications(database, id),
    publication: await publicationState(database, id),
    checklist: CHECKLIST.map(([key, label]) => ({ key, label })),
  };
}

export async function assignPropertyReview(
  database,
  { id, adminId, submissionId, action, ip = null },
) {
  if (
    !z.string().uuid().safeParse(submissionId).success ||
    !['claim', 'release', 'takeover'].includes(action)
  )
    throw unprocessable({ action: 'Choose a valid submission and assignment action.' });
  return database.begin(async (tx) => {
    const row = await lockedListing(tx, id);
    const [s] =
      await tx`SELECT * FROM listing_submission WHERE id=${submissionId} AND rentable_id=${id} FOR UPDATE`;
    if (!s || s.pass_number !== row.review_pass || row.status !== 'pending_review')
      throw conflict('SUBMISSION_CHANGED', 'Reload the current submission.');
    if (action === 'claim' && s.assigned_to && s.assigned_to !== adminId)
      throw conflict('ASSIGNED_ELSEWHERE', 'Another reviewer is assigned.');
    if (action === 'release' && s.assigned_to !== adminId)
      throw conflict('NOT_ASSIGNED_TO_YOU', 'Only your own assignment can be released.');
    const next = action === 'release' ? null : adminId;
    if (next === s.assigned_to) return { ok: true };
    await tx`UPDATE listing_submission SET assigned_to=${next} WHERE id=${submissionId}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,after,ip) VALUES ('admin',${adminId},'rentable',${id},'listing_review_assigned',${JSON.stringify({ submissionId, assignedTo: next, action })}::text::jsonb,${ip})`;
    return { ok: true };
  });
}

export async function decidePropertyReview(database, { id, adminId, input, ip = null }) {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success)
    throw unprocessable(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path[0] ?? '_', i.message])),
    );
  const d = parsed.data;
  if (d.outcome === 'changes_requested' && !d.flagged.length)
    throw unprocessable({ flagged: 'Choose at least one section to correct.' });
  return database.begin(async (tx) => {
    const row = await lockedListing(tx, id);
    const [s] =
      await tx`SELECT * FROM listing_submission WHERE id=${d.submissionId} AND rentable_id=${id} FOR UPDATE`;
    if (
      !s ||
      s.pass_number !== row.review_pass ||
      s.content_version !== row.content_version ||
      row.status !== 'pending_review'
    )
      throw conflict(
        'SUBMISSION_CHANGED',
        'The property changed or was already decided. Reload and review the latest submission.',
      );
    if (s.assigned_to && s.assigned_to !== adminId)
      throw conflict('ASSIGNED_ELSEWHERE', 'Take over the assignment before deciding.');
    if ((await tx`SELECT id FROM listing_review WHERE submission_id=${s.id}`).length)
      throw conflict('ALREADY_DECIDED', 'This submission was already decided.');
    if (
      d.outcome === 'approved_for_visit' &&
      listingCompletion(s.snapshot.listing, s.snapshot).remaining.length
    )
      throw conflict('LISTING_INCOMPLETE', 'This submitted revision is incomplete.');
    const status = {
      changes_requested: 'draft',
      rejected: 'rejected',
      approved_for_visit: 'pending_verification',
    }[d.outcome];
    await tx`INSERT INTO listing_review(rentable_id,pass_number,submission_id,outcome,reason,flagged_fields,reviewed_by)
      VALUES (${id},${s.pass_number},${s.id},${d.outcome},${d.reason},${JSON.stringify([...new Set(d.flagged)])}::text::jsonb,${adminId})`;
    await tx`UPDATE listing_submission SET assigned_to=${adminId} WHERE id=${s.id}`;
    await tx`UPDATE rentable SET status=${status},rejection_reason=${d.outcome === 'approved_for_visit' ? null : d.reason},updated_at=now() WHERE id=${id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,after,reason,ip)
      VALUES ('admin',${adminId},'rentable',${id},'listing_review_decided',${JSON.stringify({ submissionId: s.id, outcome: d.outcome, status, pass: s.pass_number })}::text::jsonb,${d.reason},${ip})`;
    return { ok: true, status, submissionId: s.id };
  });
}
