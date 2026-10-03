'use server';
import { revalidatePath } from 'next/cache';
import { bookingActor } from '../booking/record-page.js';
import { sql } from '../db/index.js';
import {
  submitReview,
  moderateReview,
  replyToReview,
  reportReview,
  closeReviewReport,
} from './service.js';
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
  return run(() =>
    submitReview(sql, actor.session, {
      visitId: form.get('visitId'),
      rating: Number(form.get('rating')),
      body: form.get('body'),
      ...Object.fromEntries(
        ['cleanliness', 'accuracy', 'valueForMoney'].map((k) => [
          k,
          form.get(k) ? Number(form.get(k)) : null,
        ]),
      ),
    }),
  );
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
  return run(() =>
    replyToReview(sql, actor.id, {
      id: form.get('id'),
      version: Number(form.get('version')),
      body: form.get('mode') === 'delete' ? null : form.get('body'),
      preview: form.get('mode') === 'preview',
      previewToken: form.get('previewToken') || undefined,
    }),
  );
}
export async function customerReviewReport(previous, form) {
  const actor = await bookingActor('customer');
  return run(() => reportReview(sql, actor, { id: form.get('id'), reason: form.get('reason') }));
}
export async function ownerReviewReport(previous, form) {
  const actor = await bookingActor('owner');
  return run(() => reportReview(sql, actor, { id: form.get('id'), reason: form.get('reason') }));
}
export async function resolveReviewReport(previous, form) {
  const actor = await bookingActor('admin');
  return run(() =>
    closeReviewReport(sql, actor.id, { id: form.get('id'), resolution: form.get('resolution') }),
  );
}
