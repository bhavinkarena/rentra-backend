'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { bookingActor } from '../booking/record-page.js';
import { sql } from '../db/index.js';
import { createSupportRequest, replySupportRequest } from './service.js';
const message = error => error.code === 'STALE_REQUEST' ? 'This conversation changed. Reload and review the latest reply before sending.'
  : error.code === 'RATE_LIMIT' ? 'Too many requests or replies. Please try again later.'
  : 'Could not save your message. Check the fields and linked record, then try again.';
export async function openSupport(previous, form) {
  const actor = await bookingActor('customer'); let result;
  try { result = await createSupportRequest(sql, actor, { category: form.get('category'), subject: form.get('subject'), body: form.get('body'),
    orderId: form.get('orderId') || null, privacyRequestId: form.get('privacyRequestId') || null, requestKey: form.get('requestKey') }); }
  catch (error) { return { error: message(error) }; }
  revalidatePath('/support'); revalidatePath('/admin/support');
  redirect('/support/' + result.id);
}
async function reply(kind, form) {
  const actor = await bookingActor(kind);
  try {
    const result = await replySupportRequest(sql, actor, { id: form.get('id'), body: form.get('body'), state: form.get('state'), version: Number(form.get('version')), requestKey: form.get('requestKey') });
    for (const base of ['/support','/admin/support']) { revalidatePath(base); revalidatePath(`${base}/${result.id}`); }
    return { message: 'Reply saved. The conversation status is updated.' };
  } catch (error) { return { error: message(error) }; }
}
export async function replyCustomerSupport(previous, form) { return reply('customer', form); }
export async function replyAdminSupport(previous, form) { return reply('admin', form); }
