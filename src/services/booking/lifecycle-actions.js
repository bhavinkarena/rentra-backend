'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { bookingActor } from './record-page.js';
import { recordVisitTransition } from './visit-lifecycle.js';
import { quoteBookAgain } from './book-again.js';
import { sql } from '../db/index.js';

async function transition(kind, form) {
  const actor = await bookingActor(kind);
  try {
    const local = String(form.get('occurredAt') || '');
    const occurredAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(local) ? local + (local.length === 16 ? ':00' : '') + '+05:30' : '';
    const result = await recordVisitTransition(sql, actor, { visitId: form.get('visitId'), phase: form.get('phase'),
      occurredAt, note: form.get('note'), attested: form.get('attested') === 'on', expectedVersion: Number(form.get('version')), requestKey: form.get('requestKey') });
    for (const base of ['/bookings','/partner/bookings','/admin/bookings']) revalidatePath(`${base}/${result.orderId}`);
    return { message: 'Evidence recorded. The visit status has been updated.' };
  } catch (error) { return { error: error.code === 'VISIT_CHANGED' ? 'The visit changed. Reload before recording another transition.' : 'Could not record this transition. Check the current status, time and required evidence.' }; }
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
