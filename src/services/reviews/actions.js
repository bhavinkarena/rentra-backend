'use server';
import { revalidatePath } from 'next/cache';
import { bookingActor } from '../booking/record-page.js';
import { sql } from '../db/index.js';
import {
  submitReview,
  moderateReview,
  replyToReview,
  reportReview,
  resolveReviewReport as resolveReport,
} from './service.js';
import { REVIEW_STATE_MESSAGES } from './policy.js';
async function run(operation) {
  try {
    const result = await operation();
    if (result?.preview) return result;
    revalidatePath('/', 'layout');
    return { ...result, message: result?.alreadyReported ? `Already reported on ${new Date(result.reportedAt).toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}.` : 'Saved.' };
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    if (!['ALREADY_REVIEWED','NOT_ELIGIBLE','CHANGED'].includes(error.code)) throw error;
    return {
      error:
        {
          ALREADY_REVIEWED: 'You already reviewed this visit. Your original review is kept.',
          NOT_ELIGIBLE:
            'This visit does not have the actual completion evidence required for a review.',
          CHANGED: 'This item changed. Reload and try again.',
        }[error.code] ||
        'Could not save. Check the fields and your account access, then try again.',
    };
  }
}
export async function submitCustomerReview(previous, form) {
  const actor = await bookingActor('customer');
  const input = {
    visitId: form.get('visitId') || undefined,
    ref: form.get('ref') || undefined,
    rating: Number(form.get('rating')),
    body: form.get('body'),
    ...Object.fromEntries(
      ['cleanliness', 'accuracy', 'valueForMoney', 'staff', 'location', 'comfort', 'facilities'].map((k) => [
        k,
        form.get(k) ? Number(form.get(k)) : null,
      ]),
    ),
    travellerType: form.get('travellerType') || null,
  };
  const result = await run(() => submitReview(sql, actor.session, input));
  // A failed submit hands the entered values back so the form keeps them.
  if (result.error || result.errors) return { ...result, values: input };
  return { ...result, message: REVIEW_STATE_MESSAGES[result.state] ?? result.message };
}
export async function moderateCustomerReview(previous, form) {
  const actor = await bookingActor('admin');
  return run(() =>
    moderateReview(sql, actor.id, {
      id: form.get('id'),
      version: Number(form.get('version')),
      state: form.get('state'),
      reason: form.get('reason'),
      category: form.get('category'),
      preview: form.get('mode') === 'preview',
      previewToken: form.get('previewToken') || undefined,
    }),
  );
}
export async function ownerReviewReply(previous, form) {
  const actor = await bookingActor('owner');
  const get = (k) => (form?.get ? form.get(k) : form?.[k]);
  return run(() =>
    replyToReview(sql, actor.id, {
      id: get('id'),
      version: Number(get('version') ?? 0),
      body: get('mode') === 'delete' ? null : get('body'),
      preview: get('mode') === 'preview' || get('preview') === true,
      previewToken: get('previewToken') || undefined,
    }),
  );
}
export async function customerReviewReport(previous, form) {
  const actor = await bookingActor('customer');
  return report(actor, form);
}
export async function ownerReviewReport(previous, form) {
  return report(await bookingActor('owner'), form);
}
async function report(actor, form) {
  const input = { id: form.get('id'), reason: form.get('reason') };
  const values = { reason: input.reason };
  let result;
  try {
    result = await run(() => reportReview(sql, actor, input, process.env, form.getAll('photos')));
  } catch (error) {
    // Photo refusals keep the typed reason so the form refills.
    if (!['INVALID_ATTACHMENT', 'UPLOADS_UNAVAILABLE'].includes(error.code)) throw error;
    return { error: error.message, code: error.code, status: error.statusCode, values };
  }
  if (result.error || result.errors) return { ...result, values };
  if (result.photosIgnored)
    return { ...result, message: 'You already reported this review; new photos were not added.' };
  return result;
}
export async function resolveReviewReport(previous, form) {
  const actor = await bookingActor('admin');
  const outcome = form.get('outcome');
  return run(() =>
    resolveReport(sql, actor.id, {
      reportId: form.get('id'),
      outcome,
      note: form.get('note'),
      ...(outcome === 'upheld' && form.get('state')
        ? {
            moderation: {
              state: form.get('state'),
              reason: form.get('category'),
              version: form.get('version') ? Number(form.get('version')) : undefined,
              preview: form.get('mode') === 'preview',
              previewToken: form.get('previewToken') || undefined,
            },
          }
        : {}),
    }),
  );
}
