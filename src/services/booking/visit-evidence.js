import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withListingInventory } from './inventory.js';
import { quoteDigest } from './quotes.js';
import { detectMime } from '../uploads/cloudinary.js';
import { evidenceStore } from '../uploads/evidence-store.js';
import {
  EVIDENCE_PHOTO_LIMITS,
  INCIDENT_CATEGORIES,
  correctedTimeAllowed,
  effectiveEvidence,
  incidentReference,
  incidentTimeAllowed,
} from '../domain/visit-evidence.js';

/**
 * CP13 visit evidence: private photos, visit-linked incidents and superseding
 * admin corrections. Nothing here edits or deletes an earlier record; the
 * database triggers in migration 0028 enforce the same rules independently.
 */
export class EvidenceError extends Error {
  constructor(code, message = code, { status = 400, field = null } = {}) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const uuid = z.string().uuid();
const operatorStates = ['confirmed', 'handed_over', 'returned', 'completed', 'disputed'];
const natureOf = (visit) => (visit.visit_provenance === 'real' ? 'actual' : 'simulation');
const instant = (value) => (value ? new Date(value).toISOString() : null);

function requireOperator(actor, kinds = ['owner', 'admin']) {
  if (!kinds.includes(actor?.kind) || !uuid.safeParse(actor.id).success) {
    throw new EvidenceError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
  }
}

/** Inside the listing lock: the owner of this property or an active admin. Same answer for foreign and missing. */
async function lockOperator(tx, actor, listing) {
  const [active] =
    actor.kind === 'owner'
      ? await tx`SELECT id,name FROM "user" WHERE id=${actor.id} AND id=${listing.client_id} AND role='client' AND account_status='active' FOR SHARE`
      : await tx`SELECT id,name FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
  if (!active) throw new EvidenceError('VISIT_NOT_FOUND', 'Visit not found', { status: 404 });
  return active;
}

/** Validate every photo before anything touches storage. Type comes from magic bytes, never the client. */
export async function preparePhotos(files = []) {
  const list = files.filter((file) => file && typeof file.arrayBuffer === 'function' && file.size > 0);
  const fail = (message) => {
    throw new EvidenceError('INVALID_ATTACHMENT', message, { status: 422, field: 'photos' });
  };
  if (list.length > EVIDENCE_PHOTO_LIMITS.files) fail(`Attach up to ${EVIDENCE_PHOTO_LIMITS.files} photos.`);
  const photos = [];
  for (const file of list) {
    if (file.size > EVIDENCE_PHOTO_LIMITS.bytes) fail('Keep each photo under 2MB.');
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = detectMime(buffer);
    if (!EVIDENCE_PHOTO_LIMITS.mimeTypes.includes(mime)) fail('Photos must be JPG, PNG or WebP images.');
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (photos.some((photo) => photo.sha256 === sha256)) fail('The same photo was attached twice.');
    photos.push({ buffer, mime, sha256, bytes: buffer.length });
  }
  return photos;
}

/** Upload outside the transaction; content-addressed keys make a retry land on the same object. */
export async function storePhotos(database, visitId, photos, store = evidenceStore()) {
  if (!photos.length) return photos;
  if (!store.configured()) {
    throw new EvidenceError('UPLOADS_UNAVAILABLE', 'Photo upload is not configured on this server yet.', {
      status: 503,
      field: 'photos',
    });
  }
  const [{ n }] = await database`SELECT count(*)::int n FROM visit_attachment WHERE booking_id=${visitId}`;
  if (n + photos.length > EVIDENCE_PHOTO_LIMITS.perVisit) {
    throw new EvidenceError('ATTACHMENT_LIMIT', `A visit can hold ${EVIDENCE_PHOTO_LIMITS.perVisit} photos.`, {
      status: 422,
      field: 'photos',
    });
  }
  for (const photo of photos) {
    photo.storageKey = (
      await store.put({ folder: `rentra/visit-evidence/${visitId}`, name: photo.sha256, buffer: photo.buffer, mime: photo.mime })
    ).key;
  }
  return photos;
}

export async function insertAttachments(tx, { visitId, evidenceId = null, incidentId = null, nature, actor }, photos) {
  for (const [position, photo] of photos.entries()) {
    await tx`INSERT INTO visit_attachment(booking_id,evidence_id,incident_id,position,storage_key,sha256,mime_type,bytes,retention_class,nature,actor_kind,actor_id)
      VALUES(${visitId},${evidenceId},${incidentId},${position},${photo.storageKey},${photo.sha256},${photo.mime},${photo.bytes},
      ${evidenceId ? 'visit_evidence' : 'incident_evidence'},${nature},${actor.kind},${actor.id})`;
  }
}

export const photoDigest = (photos) => photos.map((photo) => photo.sha256);

/* -------------------------------- incidents ------------------------------- */

const incidentSchema = z
  .object({
    visitId: uuid,
    category: z.enum(INCIDENT_CATEGORIES),
    summary: z.string().trim().min(5).max(120),
    description: z.string().trim().min(20).max(2000),
    occurredAt: z.string().datetime({ offset: true }),
    attested: z.literal(true),
    requestKey: uuid,
  })
  .strict();

export async function reportVisitIncident(database, actor, input, { files = [], store = evidenceStore() } = {}) {
  requireOperator(actor);
  const value = incidentSchema.parse(input);
  const photos = await preparePhotos(files);
  const hash = quoteDigest({ ...value, photos: photoDigest(photos) });
  const [visit] = await database`SELECT id,rentable_id,state FROM booking WHERE id=${value.visitId}`;
  if (!visit) throw new EvidenceError('VISIT_NOT_FOUND', 'Visit not found', { status: 404 });
  const [earlier] = await database`SELECT id FROM visit_incident WHERE actor_kind=${actor.kind} AND actor_id=${actor.id} AND request_key=${value.requestKey}`;
  if (!earlier) {
    if (!operatorStates.includes(visit.state)) throw new EvidenceError('VISIT_CHANGED', 'Visit changed', { status: 409 });
    await storePhotos(database, visit.id, photos, store);
  }
  return withListingInventory(database, visit.rentable_id, async (tx, listing) => {
    await lockOperator(tx, actor, listing);
    const [replay] = await tx`SELECT id,reference,booking_id,request_hash FROM visit_incident WHERE actor_kind=${actor.kind} AND actor_id=${actor.id} AND request_key=${value.requestKey}`;
    const [current] = await tx`SELECT * FROM booking WHERE id=${value.visitId}`;
    if (replay) {
      if (replay.request_hash !== hash || replay.booking_id !== current.id) {
        throw new EvidenceError('IDEMPOTENCY_CONFLICT', 'Idempotency conflict', { status: 409 });
      }
      return { id: replay.id, reference: replay.reference, visitId: current.id, orderId: current.order_id, replayed: true };
    }
    if (!current.order_id || !current.hours_known || !operatorStates.includes(current.state)) {
      throw new EvidenceError('VISIT_CHANGED', 'Visit changed', { status: 409 });
    }
    const [{ now }] = await tx`SELECT clock_timestamp() now`;
    if (!incidentTimeAllowed(value.occurredAt, { startsAt: current.starts_at, now })) {
      throw new EvidenceError('INVALID_EVIDENCE_TIME', 'Choose when it happened, from a day before arrival up to now.', {
        status: 422,
        field: 'occurredAt',
      });
    }
    const id = randomUUID();
    const reference = incidentReference(id);
    const nature = natureOf(current);
    await tx`INSERT INTO visit_incident(id,reference,booking_id,category,summary,description,occurred_at,nature,actor_kind,actor_id,created_at,updated_at,request_key,request_hash)
      VALUES(${id},${reference},${current.id},${value.category},${value.summary},${value.description},${value.occurredAt},${nature},
      ${actor.kind},${actor.id},${now},${now},${value.requestKey},${hash})`;
    await insertAttachments(tx, { visitId: current.id, incidentId: id, nature, actor }, photos);
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after")
      VALUES(${actor.kind === 'owner' ? 'client' : 'admin'},${actor.id},'visit_incident',${id},'visit_incident_reported',
      ${JSON.stringify({ visitId: current.id, orderId: current.order_id, category: value.category, nature, photos: photos.length })}::text::jsonb)`;
    return { id, reference, visitId: current.id, orderId: current.order_id, replayed: false };
  });
}

const closeSchema = z
  .object({ incidentId: uuid, expectedVersion: z.number().int().min(1), resolutionNote: z.string().trim().min(10).max(1000) })
  .strict();

/** Operational follow-up only. Liability, deposits and money belong to a dispute case (CP23). */
export async function closeVisitIncident(database, actor, input) {
  requireOperator(actor, ['admin']);
  const value = closeSchema.parse(input);
  return database.begin(async (tx) => {
    const [admin] = await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (!admin) throw new EvidenceError('OPERATOR_REQUIRED', 'Operator required', { status: 403 });
    const [incident] = await tx`SELECT i.*,b.order_id FROM visit_incident i JOIN booking b ON b.id=i.booking_id WHERE i.id=${value.incidentId} FOR UPDATE OF i`;
    if (!incident) throw new EvidenceError('INCIDENT_NOT_FOUND', 'Incident not found', { status: 404 });
    if (incident.state !== 'open' || incident.version !== value.expectedVersion) {
      throw new EvidenceError('INCIDENT_CHANGED', 'Incident changed', { status: 409 });
    }
    const [closed] = await tx`UPDATE visit_incident SET state='closed',resolution_note=${value.resolutionNote},closed_at=clock_timestamp(),
      closed_by=${actor.id},version=version+1,updated_at=clock_timestamp() WHERE id=${incident.id} RETURNING version`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES('admin',${actor.id},'visit_incident',${incident.id},'visit_incident_closed',
      ${JSON.stringify({ state: 'open', version: incident.version })}::text::jsonb,
      ${JSON.stringify({ state: 'closed', version: closed.version, resolutionNote: value.resolutionNote })}::text::jsonb)`;
    return { id: incident.id, reference: incident.reference, orderId: incident.order_id, version: closed.version };
  });
}

/* ------------------------------- corrections ------------------------------ */

const correctionSchema = z
  .object({
    evidenceId: uuid,
    supersedesId: uuid.nullable(),
    reason: z.string().trim().min(10).max(500),
    correctedOccurredAt: z.string().datetime({ offset: true }).nullable(),
    correctedNote: z.string().trim().min(20).max(1000).nullable(),
    requestKey: uuid,
  })
  .strict()
  .refine((value) => value.correctedOccurredAt || value.correctedNote, {
    message: 'Correct the time, the note, or both.',
    path: ['correctedNote'],
  });

/** An admin evidence decision. It never reverses a visit state and never changes actual/simulation. */
export async function correctVisitEvidence(database, actor, input) {
  requireOperator(actor, ['admin']);
  const value = correctionSchema.parse(input);
  const hash = quoteDigest(value);
  const [scope] = await database`SELECT b.rentable_id FROM visit_evidence e JOIN booking b ON b.id=e.booking_id WHERE e.id=${value.evidenceId}`;
  if (!scope) throw new EvidenceError('EVIDENCE_NOT_FOUND', 'Evidence not found', { status: 404 });
  return withListingInventory(database, scope.rentable_id, async (tx, listing) => {
    await lockOperator(tx, actor, listing);
    const [replay] = await tx`SELECT id,evidence_id,request_hash FROM visit_evidence_correction WHERE actor_kind='admin' AND actor_id=${actor.id} AND request_key=${value.requestKey}`;
    if (replay) {
      if (replay.request_hash !== hash || replay.evidence_id !== value.evidenceId) {
        throw new EvidenceError('IDEMPOTENCY_CONFLICT', 'Idempotency conflict', { status: 409 });
      }
      const [{ order_id }] = await tx`SELECT b.order_id FROM visit_evidence e JOIN booking b ON b.id=e.booking_id WHERE e.id=${value.evidenceId}`;
      return { id: replay.id, evidenceId: value.evidenceId, orderId: order_id, replayed: true };
    }
    const [evidence] = await tx`SELECT e.*,b.starts_at,b.order_id FROM visit_evidence e JOIN booking b ON b.id=e.booking_id WHERE e.id=${value.evidenceId}`;
    const siblings = await tx`SELECT id,kind,occurred_at,note FROM visit_evidence WHERE booking_id=${evidence.booking_id}`;
    const corrections = await tx`SELECT id,evidence_id,supersedes_id,corrected_occurred_at,corrected_note FROM visit_evidence_correction WHERE booking_id=${evidence.booking_id}`;
    const effective = new Map(
      siblings.map((row) => [
        row.id,
        {
          kind: row.kind,
          ...effectiveEvidence(
            { occurredAt: instant(row.occurred_at), note: row.note },
            corrections.filter((c) => c.evidence_id === row.id).map(correctionShape),
          ),
        },
      ]),
    );
    const own = effective.get(evidence.id);
    if (own.headId !== value.supersedesId) throw new EvidenceError('EVIDENCE_CHANGED', 'Evidence changed', { status: 409 });
    const [{ now }] = await tx`SELECT clock_timestamp() now`;
    if (value.correctedOccurredAt) {
      const effectiveTimes = Object.fromEntries([...effective.values()].map((row) => [row.kind, row.occurredAt]));
      delete effectiveTimes[evidence.kind];
      if (!correctedTimeAllowed(evidence.kind, value.correctedOccurredAt, { startsAt: evidence.starts_at, now, effectiveTimes })) {
        throw new EvidenceError('INVALID_EVIDENCE_TIME', 'The corrected time must be within the visit and keep handover, return and completion in order.', {
          status: 422,
          field: 'correctedOccurredAt',
        });
      }
    }
    const sameTime = !value.correctedOccurredAt || +new Date(value.correctedOccurredAt) === +new Date(own.occurredAt);
    const sameNote = !value.correctedNote || value.correctedNote === own.note;
    if (sameTime && sameNote) {
      throw new EvidenceError('NO_CHANGE', 'This matches the current evidence. Change the time or the note.', {
        status: 422,
        field: 'correctedNote',
      });
    }
    const id = randomUUID();
    await tx`INSERT INTO visit_evidence_correction(id,evidence_id,booking_id,supersedes_id,reason,corrected_occurred_at,corrected_note,nature,actor_kind,actor_id,created_at,request_key,request_hash)
      VALUES(${id},${evidence.id},${evidence.booking_id},${value.supersedesId},${value.reason},${value.correctedOccurredAt},${value.correctedNote},
      ${evidence.nature},'admin',${actor.id},${now},${value.requestKey},${hash})`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES('admin',${actor.id},'visit_evidence',${evidence.id},'visit_evidence_corrected',
      ${JSON.stringify({ occurredAt: own.occurredAt, note: own.note, supersedes: value.supersedesId })}::text::jsonb,
      ${JSON.stringify({ correctionId: id, occurredAt: value.correctedOccurredAt ?? own.occurredAt, note: value.correctedNote ?? own.note, reason: value.reason })}::text::jsonb)`;
    return { id, evidenceId: evidence.id, orderId: evidence.order_id, replayed: false };
  });
}

const correctionShape = (row) => ({
  id: row.id,
  supersedesId: row.supersedes_id,
  correctedOccurredAt: instant(row.corrected_occurred_at),
  correctedNote: row.corrected_note,
});

/* ------------------------------- attachments ------------------------------ */

/**
 * One photo's bytes for an authorized operator. The order id in the path must
 * match; a foreign, guessed or mismatched id is the same 404. Each successful
 * read is audited (CA19). Storage keys never leave this function.
 */
export async function readVisitAttachment(database, actor, orderId, attachmentId, { store = evidenceStore(), ip = null } = {}) {
  requireOperator(actor, ['owner', 'admin', 'staff']);
  if (!uuid.safeParse(orderId).success || !uuid.safeParse(attachmentId).success) return { status: 404 };
  const allowed =
    actor.kind === 'owner'
      ? database`EXISTS(SELECT 1 FROM "user" u WHERE u.id=${actor.id} AND u.id=r.client_id AND u.role='client' AND u.account_status='active')`
      : actor.kind === 'staff'
        ? database`EXISTS(SELECT 1 FROM client_staff s JOIN staff_property sp ON sp.staff_id=s.id AND sp.rentable_id=r.id
            WHERE s.id=${actor.id} AND s.client_id=r.client_id AND s.is_active AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL)`
        : database`EXISTS(SELECT 1 FROM admin_user x WHERE x.id=${actor.id} AND x.is_active)`;
  const [row] = await database`SELECT a.id,a.storage_key,a.mime_type,a.retention_class,a.booking_id,b.order_id FROM visit_attachment a
    JOIN booking b ON b.id=a.booking_id JOIN rentable r ON r.id=b.rentable_id
    WHERE a.id=${attachmentId} AND b.order_id=${orderId} AND ${allowed}`;
  if (!row) return { status: 404 };
  const file = await store.get(row.storage_key).catch(() => null);
  if (!file) return { status: 502 };
  await database`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after",ip)
    VALUES(${{ owner: 'client', staff: 'staff' }[actor.kind] ?? 'admin'},${actor.id},'visit_attachment',${row.id},'visit_attachment_viewed',
    ${JSON.stringify({ orderId: row.order_id, visitId: row.booking_id, retentionClass: row.retention_class })}::text::jsonb,${ip})`;
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[row.mime_type];
  return { status: 200, body: file.body, contentType: row.mime_type, filename: `visit-photo-${row.id.slice(0, 8)}.${extension}` };
}

/* ------------------------------- read model ------------------------------- */

/**
 * Evidence, corrections, incidents and photo metadata for one order's visits.
 * Operators see notes, actors and photos; customers see only the effective time.
 */
export async function visitEvidenceRecords(tx, orderId, viewer) {
  const operational = viewer !== 'customer';
  const evidence = await tx`SELECT e.id,e.booking_id,e.kind,e.nature,e.occurred_at,e.recorded_at,e.note,e.visit_version,e.actor_kind,
    CASE e.actor_kind WHEN 'owner' THEN (SELECT name FROM "user" WHERE id=e.actor_id) WHEN 'staff' THEN (SELECT name FROM client_staff WHERE id=e.actor_id)
      ELSE (SELECT name FROM admin_user WHERE id=e.actor_id) END actor_name
    FROM visit_evidence e JOIN booking b ON b.id=e.booking_id WHERE b.order_id=${orderId} ORDER BY e.recorded_at,e.id`;
  const corrections = await tx`SELECT c.*,(SELECT name FROM admin_user WHERE id=c.actor_id) actor_name FROM visit_evidence_correction c
    JOIN booking b ON b.id=c.booking_id WHERE b.order_id=${orderId} ORDER BY c.created_at,c.id`;
  const incidents = operational
    ? await tx`SELECT i.*,CASE i.actor_kind WHEN 'owner' THEN (SELECT name FROM "user" WHERE id=i.actor_id) ELSE (SELECT name FROM admin_user WHERE id=i.actor_id) END actor_name
      FROM visit_incident i JOIN booking b ON b.id=i.booking_id WHERE b.order_id=${orderId} ORDER BY i.created_at,i.id`
    : [];
  const attachments = operational
    ? await tx`SELECT a.id,a.evidence_id,a.incident_id,a.position,a.mime_type,a.bytes FROM visit_attachment a
      JOIN booking b ON b.id=a.booking_id WHERE b.order_id=${orderId} ORDER BY a.position`
    : [];
  const photos = (key, id) =>
    attachments.filter((a) => a[key] === id).map((a) => ({ id: a.id, position: a.position, mimeType: a.mime_type, bytes: a.bytes }));
  const actorName = (name, kind) => (viewer === 'admin' || kind === 'staff' ? name || null : undefined);
  const byVisit = new Map();
  for (const row of evidence) {
    const own = corrections.filter((c) => c.evidence_id === row.id);
    const effective = effectiveEvidence({ occurredAt: instant(row.occurred_at), note: row.note }, own.map(correctionShape));
    const item = {
      id: row.id,
      kind: row.kind,
      nature: row.nature,
      occurredAt: effective.occurredAt,
      recordedAt: instant(row.recorded_at),
      corrected: effective.corrected,
      ...(operational
        ? {
            note: effective.note,
            visitVersion: row.visit_version,
            actorKind: row.actor_kind,
            actorName: actorName(row.actor_name, row.actor_kind),
            original: effective.corrected ? { occurredAt: instant(row.occurred_at), note: row.note } : null,
            headCorrectionId: effective.headId,
            corrections: effective.chain.map((c) => {
              const full = own.find((x) => x.id === c.id);
              return {
                id: c.id,
                reason: full.reason,
                correctedOccurredAt: c.correctedOccurredAt,
                correctedNote: c.correctedNote,
                createdAt: instant(full.created_at),
                actorName: actorName(full.actor_name),
              };
            }),
            attachments: photos('evidence_id', row.id),
          }
        : {}),
    };
    byVisit.set(row.booking_id, [...(byVisit.get(row.booking_id) ?? []), item]);
  }
  const incidentsByVisit = new Map();
  for (const row of incidents) {
    incidentsByVisit.set(row.booking_id, [
      ...(incidentsByVisit.get(row.booking_id) ?? []),
      {
        id: row.id,
        reference: row.reference,
        category: row.category,
        summary: row.summary,
        description: row.description,
        occurredAt: instant(row.occurred_at),
        createdAt: instant(row.created_at),
        nature: row.nature,
        state: row.state,
        version: row.version,
        actorKind: row.actor_kind,
        actorName: actorName(row.actor_name),
        resolutionNote: row.resolution_note,
        closedAt: instant(row.closed_at),
        attachments: photos('incident_id', row.id),
      },
    ]);
  }
  return { evidence: byVisit, incidents: incidentsByVisit };
}
