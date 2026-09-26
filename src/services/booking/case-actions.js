import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { bookingActor } from './record-page.js';
import {
  CaseError,
  addCaseUpdate,
  assignBookingCase,
  createBookingCase,
  listBookingCases,
  previewCaseResolution,
  readBookingCase,
  resolveBookingCase,
} from './booking-cases.js';
import { sql } from '../db/index.js';

/** CP14 case actions. Actors come from the session; forms never name an actor. */

const MESSAGES = {
  BOOKING_NOT_FOUND: 'This booking is not available to your account.',
  CASE_NOT_FOUND: 'This case is not available.',
  CASE_CHANGED: 'This case changed in another session. Reload to see the latest version.',
  PREVIEW_CHANGED: 'The visits or refunds changed since your preview. Preview again before confirming.',
  IDEMPOTENCY_CONFLICT: 'This form was already submitted with different details. Reload and try again.',
  OPERATOR_REQUIRED: 'Your account cannot do this.',
};

function failure(error) {
  if (error instanceof ZodError) {
    return { errors: Object.fromEntries(error.issues.map((issue) => [issue.path[0] ?? '_', issue.message])) };
  }
  if (error instanceof CaseError) {
    if (error.field) return { errors: { [error.field]: error.message } };
    return { error: MESSAGES[error.code] ?? 'Could not save this. Nothing was changed.', code: error.code, status: error.status };
  }
  throw error;
}

function refresh(orderId, caseId) {
  for (const base of ['/bookings', '/partner/bookings', '/admin/bookings']) revalidatePath(`${base}/${orderId}`);
  revalidatePath('/admin/booking-cases');
  if (caseId) revalidatePath(`/admin/booking-cases/${caseId}`);
}

const text = (form, name) => {
  const value = form.get(name);
  return value == null ? undefined : String(value);
};

function requestedChange(form) {
  const dates = form.getAll('changeDate').map(String).filter(Boolean);
  if (!dates.length) return null;
  return { dates, slot: text(form, 'changeSlot') ?? 'day', guests: Number(text(form, 'changeGuests') || 0) };
}

async function create(kind, form) {
  const actor = await bookingActor(kind);
  try {
    const result = await createBookingCase(sql, actor, {
      orderId: text(form, 'orderId'),
      type: text(form, 'type'),
      visitIds: form.getAll('visitId').map(String),
      reason: text(form, 'reason'),
      requestedOutcome: text(form, 'requestedOutcome') || null,
      ...(kind === 'admin'
        ? { requesterKind: text(form, 'requesterKind'), source: text(form, 'source'), requestedChange: requestedChange(form) }
        : {}),
      requestKey: text(form, 'requestKey'),
    });
    refresh(result.orderId, result.id);
    return { message: `Case ${result.reference} opened. Nothing about the booking has changed yet.`, caseId: result.id, reference: result.reference };
  } catch (error) {
    return failure(error);
  }
}
export const createOwnerCase = (_previous, form) => create('owner', form);
export const createAdminCase = (_previous, form) => create('admin', form);

async function update(kind, form) {
  const actor = await bookingActor(kind);
  try {
    const result = await addCaseUpdate(sql, actor, {
      caseId: text(form, 'caseId'),
      ...(kind === 'admin' ? { audience: text(form, 'audience') } : {}),
      body: text(form, 'body'),
      requestKey: text(form, 'requestKey'),
    });
    refresh(result.orderId, text(form, 'caseId'));
    return { message: 'Update added.' };
  } catch (error) {
    return failure(error);
  }
}
export const addOwnerCaseUpdate = (_previous, form) => update('owner', form);
export const addAdminCaseUpdate = (_previous, form) => update('admin', form);

export async function assignAdminCase(_previous, form) {
  const actor = await bookingActor('admin');
  try {
    const result = await assignBookingCase(sql, actor, {
      caseId: text(form, 'caseId'),
      expectedVersion: Number(text(form, 'version')),
      assigneeId: text(form, 'assigneeId') || null,
    });
    refresh(result.orderId, result.id);
    return { message: 'Assignment saved.' };
  } catch (error) {
    return failure(error);
  }
}

export async function previewAdminCase(_previous, form) {
  const actor = await bookingActor('admin');
  try {
    return await previewCaseResolution(sql, actor, { caseId: text(form, 'caseId'), basis: text(form, 'basis') });
  } catch (error) {
    return failure(error);
  }
}

export async function resolveAdminCase(_previous, form) {
  const actor = await bookingActor('admin');
  try {
    const result = await resolveBookingCase(sql, actor, {
      caseId: text(form, 'caseId'),
      expectedVersion: Number(text(form, 'version')),
      outcome: text(form, 'outcome'),
      basis: text(form, 'basis') || null,
      hash: text(form, 'hash') || null,
      note: text(form, 'note'),
      audience: text(form, 'audience'),
      requestKey: text(form, 'requestKey'),
    });
    refresh(result.orderId, result.id);
    return { message: `Case ${result.reference} resolved.`, outcome: result.outcome };
  } catch (error) {
    return failure(error);
  }
}

export async function adminCaseList(query) {
  return listBookingCases(sql, await bookingActor('admin'), query);
}

export async function adminCaseDetail(caseId) {
  try {
    return await readBookingCase(sql, await bookingActor('admin'), caseId);
  } catch (error) {
    if (error instanceof CaseError && error.code === 'CASE_NOT_FOUND') return null;
    throw error;
  }
}
