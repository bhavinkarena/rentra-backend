import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { bookingActor } from './record-page.js';
import {
  EvidenceError,
  closeVisitIncident,
  correctVisitEvidence,
  readVisitAttachment,
  reportVisitIncident,
} from './visit-evidence.js';
import { sql } from '../db/index.js';

/**
 * CP13 actions: incident reports, admin closure and admin evidence corrections.
 * Actors come from the authenticated session, never from the form.
 */

/** `YYYY-MM-DDTHH:mm` typed in India time → ISO instant; anything else is left invalid. */
export function indiaInstant(raw) {
  const local = String(raw || '');
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(local)
    ? local + (local.length === 16 ? ':00' : '') + '+05:30'
    : '';
}

export function evidenceFailure(error) {
  if (error.field) return { errors: { [error.field]: error.message } };
  const messages = {
    VISIT_NOT_FOUND: 'This visit is not available to your account.',
    INCIDENT_NOT_FOUND: 'This incident is not available.',
    EVIDENCE_NOT_FOUND: 'This evidence is not available.',
    VISIT_CHANGED: 'The visit changed. Reload before trying again.',
    INCIDENT_CHANGED: 'Someone else updated this incident. Reload to see the latest version.',
    EVIDENCE_CHANGED: 'This evidence was corrected in another session. Reload before correcting it again.',
    IDEMPOTENCY_CONFLICT: 'This form was already submitted with different details. Reload and try again.',
    OPERATOR_REQUIRED: 'Your account cannot do this.',
  };
  return { error: messages[error.code] ?? 'Could not save this. Nothing was changed.', code: error.code, status: error.status };
}

function fieldErrors(error) {
  return {
    errors: Object.fromEntries(
      error.issues.map((issue) => [issue.path[0] ?? '_', issue.message]),
    ),
  };
}

function refresh(orderId) {
  for (const base of ['/partner/bookings', '/admin/bookings']) revalidatePath(`${base}/${orderId}`);
}

async function incident(kind, form) {
  const actor = await bookingActor(kind);
  try {
    const result = await reportVisitIncident(
      sql,
      actor,
      {
        visitId: form.get('visitId'),
        category: form.get('category'),
        summary: form.get('summary'),
        description: form.get('description'),
        occurredAt: indiaInstant(form.get('occurredAt')),
        attested: form.get('attested') === 'on',
        requestKey: form.get('requestKey'),
      },
      { files: form.getAll('photos') },
    );
    refresh(result.orderId);
    return { message: `Incident ${result.reference} recorded. Rentra operations can see it now.`, reference: result.reference };
  } catch (error) {
    if (error instanceof ZodError) return fieldErrors(error);
    if (error instanceof EvidenceError) return evidenceFailure(error);
    throw error;
  }
}

export async function reportOwnerIncident(_previous, form) {
  return incident('owner', form);
}
export async function reportAdminIncident(_previous, form) {
  return incident('admin', form);
}

export async function closeAdminIncident(_previous, form) {
  const actor = await bookingActor('admin');
  try {
    const result = await closeVisitIncident(sql, actor, {
      incidentId: form.get('incidentId'),
      expectedVersion: Number(form.get('version')),
      resolutionNote: form.get('resolutionNote'),
    });
    refresh(result.orderId);
    return { message: `Incident ${result.reference} closed.` };
  } catch (error) {
    if (error instanceof ZodError) return fieldErrors(error);
    if (error instanceof EvidenceError) return evidenceFailure(error);
    throw error;
  }
}

export async function correctAdminEvidence(_previous, form) {
  const actor = await bookingActor('admin');
  const time = String(form.get('correctedOccurredAt') || '');
  const note = String(form.get('correctedNote') || '').trim();
  try {
    const result = await correctVisitEvidence(sql, actor, {
      evidenceId: form.get('evidenceId'),
      supersedesId: form.get('supersedesId') || null,
      reason: form.get('reason'),
      correctedOccurredAt: time ? indiaInstant(time) : null,
      correctedNote: note || null,
      requestKey: form.get('requestKey'),
    });
    refresh(result.orderId);
    return { message: 'Correction recorded. The original evidence is kept above it.' };
  } catch (error) {
    if (error instanceof ZodError) return fieldErrors(error);
    if (error instanceof EvidenceError) return evidenceFailure(error);
    throw error;
  }
}

export async function visitAttachmentFile(kind, orderId, attachmentId, ip) {
  const actor = await bookingActor(kind);
  return readVisitAttachment(sql, actor, orderId, attachmentId, { ip });
}
