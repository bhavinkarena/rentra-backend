'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { bookingActor } from './record-page.js';
import { recordVisitTransition } from './visit-lifecycle.js';
import { EvidenceError } from './visit-evidence.js';
import { evidenceFailure, indiaInstant } from './evidence-actions.js';
import { quoteBookAgain } from './book-again.js';
import { sql } from '../db/index.js';

async function transition(kind, form) {
  const actor = await bookingActor(kind);
  try {
    const result = await recordVisitTransition(sql, actor, { visitId: form.get('visitId'), phase: form.get('phase'),
      occurredAt: indiaInstant(form.get('occurredAt')), note: form.get('note'), attested: form.get('attested') === 'on', expectedVersion: Number(form.get('version')), requestKey: form.get('requestKey') },
      { files: form.getAll('photos') });
    for (const base of ['/bookings','/partner/bookings','/admin/bookings']) revalidatePath(`${base}/${result.orderId}`);
    return { message: 'Evidence recorded. The visit status has been updated.' };
  } catch (error) {
    if (error instanceof EvidenceError) return evidenceFailure(error);
    if (error.code === 'VISIT_CHANGED') return { error: 'The visit changed. Reload before recording another transition.', code: 'VISIT_CHANGED', status: 409 };
    return { error: 'Could not record this transition. Check the current status, time and required evidence.' };
  }
}
export async function recordOwnerVisit(previous, form) { return transition('owner', form); }
export async function recordAdminVisit(previous, form) { return transition('admin', form); }
export async function bookAgain(previous, form) {
  const actor = await bookingActor('customer');
  let quote;
  try {
    quote = await quoteBookAgain(sql, actor.session, form.get('orderId'), { dates: form.getAll('date').filter(Boolean), slot: form.get('slot'), guests: Number(form.get('guests')) });
  } catch { return { error: 'These dates, guests or listing are unavailable. Change your selection and check again; no dates have been reserved.' }; }
  redirect(`/checkout/review/${quote.id}`);
}
