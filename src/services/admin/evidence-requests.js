import 'server-only';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { getEnv } from '@/services/schemas/joi/env';
import { VIDEO_LIMITS, videoStore } from '../uploads/video-store.js';

/**
 * Story 1.3: a reviewer asks for a property video tied to one submitted
 * revision; the owner uploads it privately and explicitly submits it.
 * Nothing here changes review, publication or booking state.
 */
const requestSchema = z.object({
  submissionId: z.string().uuid(),
  reason: z.string().trim().min(10).max(2000),
});

function enabled() {
  if (!getEnv().EVIDENCE_VIDEO_UPLOADS || !videoStore().configured())
    throw conflict('VIDEO_EVIDENCE_DISABLED', 'Property video requests are not enabled yet.');
}

const state = (r) =>
  r.submitted_at ? 'submitted' : r.video_public_id ? 'uploaded' : 'requested';

function dto(r) {
  return {
    id: r.id,
    submissionId: r.submission_id,
    passNumber: r.pass_number,
    contentVersion: r.content_version,
    reason: r.reason,
    requestedBy: r.requested_by_email ?? null,
    requestedAt: r.requested_at,
    state: state(r),
    video: r.video_public_id
      ? {
          // Opaque per-upload reference (random suffix), never the storage path.
          ref: r.video_public_id.split('/').pop(),
          format: r.video_format,
          bytes: r.video_bytes,
          uploadedAt: r.uploaded_at,
        }
      : null,
    submittedAt: r.submitted_at,
  };
}

const select = (tx) => tx`SELECT e.*, s.pass_number, a.email AS requested_by_email
  FROM property_evidence_request e
  JOIN listing_submission s ON s.id=e.submission_id
  LEFT JOIN admin_user a ON a.id=e.requested_by`;

async function audit(tx, { actorType, actorId, id, action, after, reason = null, ip = null }) {
  await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, after, reason, ip)
    VALUES (${actorType}, ${actorId}, 'rentable', ${id}, ${action},
      ${JSON.stringify(after)}::text::jsonb, ${reason}, ${ip})`;
}

/** Reviewer command. Replays return the existing open request for that submission. */
export async function requestVideo(database, { id, adminId, input, ip = null }) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw unprocessable({ reason: 'Explain what the video must show (10–2000 characters).' });
  enabled();
  const { submissionId, reason } = parsed.data;
  return database.begin(async (tx) => {
    const [row] = await tx`SELECT * FROM rentable WHERE id=${id} FOR UPDATE`;
    if (!row) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
    const [s] =
      await tx`SELECT * FROM listing_submission WHERE id=${submissionId} AND rentable_id=${id}`;
    if (
      !s ||
      s.pass_number !== row.review_pass ||
      s.content_version !== row.content_version ||
      !['pending_review', 'pending_verification'].includes(row.status)
    )
      throw conflict('SUBMISSION_CHANGED', 'Reload the current submission.');
    const [open] =
      await tx`SELECT id FROM property_evidence_request WHERE submission_id=${submissionId} AND submitted_at IS NULL`;
    if (open) return { ok: true, requestId: open.id, replayed: true };
    const [created] = await tx`INSERT INTO property_evidence_request
      (rentable_id, submission_id, content_version, reason, requested_by)
      VALUES (${id}, ${submissionId}, ${s.content_version}, ${reason}, ${adminId}) RETURNING id`;
    await audit(tx, {
      actorType: 'admin',
      actorId: adminId,
      id,
      action: 'evidence_requested',
      after: { requestId: created.id, submissionId, passNumber: s.pass_number, kind: 'video' },
      reason,
      ip,
    });
    await tx`SELECT client_update_insert(${row.client_id}, ${'evidence_request:' + created.id},
      'property', 'action', 'evidence_requested', ${id}, NULL,
      ${JSON.stringify({ requestId: created.id })}::text::jsonb, now())`;
    return { ok: true, requestId: created.id, replayed: false };
  });
}

/** Admin review detail. */
export async function listEvidenceRequests(database, id) {
  const rows =
    await database`${select(database)} WHERE e.rentable_id=${id} ORDER BY e.requested_at DESC`;
  return rows.map(dto);
}

async function ownedRequest(tx, { clientId, id, requestId, lock = false }) {
  const [r] = lock
    ? await tx`SELECT e.* FROM property_evidence_request e JOIN rentable l ON l.id=e.rentable_id
        WHERE e.id=${requestId} AND e.rentable_id=${id} AND l.client_id=${clientId} FOR UPDATE OF e`
    : await tx`SELECT e.* FROM property_evidence_request e JOIN rentable l ON l.id=e.rentable_id
        WHERE e.id=${requestId} AND e.rentable_id=${id} AND l.client_id=${clientId}`;
  if (!r) throw notFound('EVIDENCE_REQUEST_NOT_FOUND', 'Request not found.');
  return r;
}

/** Owner view: only the owner's own property. Never includes storage keys. */
export async function ownerEvidenceRequests(database, { clientId, id }) {
  const [own] = await database`SELECT 1 FROM rentable WHERE id=${id} AND client_id=${clientId}`;
  if (!own) throw notFound('LISTING_NOT_FOUND', 'Property not found.');
  const rows =
    await database`${select(database)} WHERE e.rentable_id=${id} ORDER BY e.requested_at DESC`;
  return {
    enabled: Boolean(getEnv().EVIDENCE_VIDEO_UPLOADS),
    limits: { maxBytes: VIDEO_LIMITS.maxBytes, formats: VIDEO_LIMITS.formats },
    requests: rows.map((r) => ({ ...dto(r), requestedBy: undefined })),
  };
}

/** Signs one direct upload for one exact public id. */
export async function signVideoUpload(database, { clientId, id, requestId }) {
  enabled();
  return database.begin(async (tx) => {
    const r = await ownedRequest(tx, { clientId, id, requestId, lock: true });
    if (r.submitted_at) throw conflict('EVIDENCE_SUBMITTED', 'This video was already sent.');
    const publicId = videoStore().newKey(`property-evidence/${id}/${requestId}`);
    await tx`UPDATE property_evidence_request SET pending_public_id=${publicId} WHERE id=${requestId}`;
    return { publicId, upload: videoStore().signUpload(publicId), limits: VIDEO_LIMITS };
  });
}

/** Verifies the stored asset from the provider's own metadata, never the browser's. */
export async function confirmVideoUpload(database, { clientId, id, requestId, publicId }) {
  enabled();
  const store = videoStore();
  let replaced = null;
  const result = await database.begin(async (tx) => {
    const r = await ownedRequest(tx, { clientId, id, requestId, lock: true });
    if (r.submitted_at) throw conflict('EVIDENCE_SUBMITTED', 'This video was already sent.');
    if (!publicId || publicId !== r.pending_public_id) {
      if (publicId && publicId === r.video_public_id) return { ok: true, state: 'uploaded' };
      throw conflict('UPLOAD_CHANGED', 'Start the upload again.');
    }
    const meta = await store.inspect(publicId);
    if (!meta)
      throw unprocessable({ video: 'The upload did not finish. Choose the video again.' });
    if (!VIDEO_LIMITS.formats.includes(meta.format) || !(meta.bytes <= VIDEO_LIMITS.maxBytes)) {
      await tx`UPDATE property_evidence_request SET pending_public_id=NULL WHERE id=${requestId}`;
      return { rejected: publicId };
    }
    replaced = r.video_public_id;
    await tx`UPDATE property_evidence_request SET video_public_id=${publicId},
      video_format=${meta.format}, video_bytes=${meta.bytes}, uploaded_at=now(), pending_public_id=NULL
      WHERE id=${requestId}`;
    return { ok: true, state: 'uploaded' };
  });
  if (result.rejected) {
    await store.remove(result.rejected);
    throw unprocessable({
      video: 'Use an MP4 or MOV video of 50 MB or less. This file was not kept.',
    });
  }
  // Replacing an unsent video: remove the earlier asset only after the new one is committed.
  if (replaced) await store.remove(replaced).catch(() => {});
  return result;
}

/** Explicit owner response. Same video again is a no-op; anything else is a conflict. */
export async function submitVideoResponse(database, { clientId, id, requestId, publicId, ip = null }) {
  // The owner names the upload by its reference (or full id); a different upload is refused.
  const ref = String(publicId ?? '').split('/').pop();
  const same = (r) => Boolean(ref) && r.video_public_id?.split('/').pop() === ref;
  return database.begin(async (tx) => {
    const r = await ownedRequest(tx, { clientId, id, requestId, lock: true });
    if (r.submitted_at) {
      if (same(r)) return { ok: true, state: 'submitted', replayed: true };
      throw conflict('EVIDENCE_SUBMITTED', 'This request already has a submitted video.');
    }
    if (!same(r))
      throw conflict('UPLOAD_CHANGED', 'Upload the video before sending it.');
    await tx`UPDATE property_evidence_request SET submitted_at=now() WHERE id=${requestId}`;
    await audit(tx, {
      actorType: 'client',
      actorId: clientId,
      id,
      action: 'evidence_response_submitted',
      after: { requestId, submissionId: r.submission_id, format: r.video_format, bytes: r.video_bytes },
      ip,
    });
    return { ok: true, state: 'submitted', replayed: false };
  });
}

/** Admin playback of a submitted video, audited per open. */
export async function streamEvidenceVideo(database, { id, requestId, adminId, range, ip = null }) {
  const [r] =
    await database`SELECT * FROM property_evidence_request WHERE id=${requestId} AND rentable_id=${id} AND submitted_at IS NOT NULL`;
  if (!r) throw notFound('EVIDENCE_NOT_FOUND', 'Video not found.');
  const upstream = await videoStore().stream(r.video_public_id, range);
  if (!upstream) return null;
  await audit(database, {
    actorType: 'admin',
    actorId: adminId,
    id,
    action: 'evidence_video_viewed',
    after: { requestId },
    ip,
  });
  return upstream;
}
