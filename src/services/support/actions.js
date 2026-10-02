'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { supportActor } from './actor.js';
import { sql } from '../db/index.js';
import {
  createSupportRequest,
  replySupportRequest,
  manageSupportRequest,
  SupportError,
} from './service.js';

async function open(kind, form) {
  const actor = await supportActor(kind);
  let result;
  try {
    result = await createSupportRequest(sql, actor, {
      category: form.get('category'),
      subject: form.get('subject'),
      body: form.get('body'),
      orderId: form.get('orderId') || null,
      privacyRequestId: form.get('privacyRequestId') || null,
      propertyId: form.get('propertyId') || null,
      visitId: form.get('visitId') || null,
      requestKey: form.get('requestKey'),
    }, process.env, form.getAll('photos'));
  } catch (error) {
    if (error instanceof SupportError) throw error;
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
  revalidatePath('/support');
  revalidatePath('/admin/support');
  redirect((kind === 'owner' ? '/partner/support/' : '/support/') + result.id);
}
async function reply(kind, form) {
  const actor = await supportActor(kind);
  try {
    const result = await replySupportRequest(
      sql,
      actor,
      {
        id: form.get('id'),
        body: form.get('body'),
        state: form.get('state'),
        version: Number(form.get('version')),
        requestKey: form.get('requestKey'),
        internal: form.get('internal') === 'true',
      },
      process.env,
      form.getAll('photos'),
    );
    for (const base of ['/support', '/admin/support', '/partner/support']) {
      revalidatePath(base);
      revalidatePath(`${base}/${result.id}`);
    }
    return { message: 'Reply saved. The conversation status is updated.' };
  } catch (error) {
    if (error instanceof SupportError) throw error;
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
}
export async function replyCustomerSupport(previous, form) {
  return reply('customer', form);
}
export async function replyAdminSupport(previous, form) {
  return reply('admin', form);
}

export async function openSupport(previous, form) {
  return open('customer', form);
}
export async function openOwnerSupport(previous, form) {
  return open('owner', form);
}
export async function replyOwnerSupport(previous, form) {
  return reply('owner', form);
}
export async function manageSupport(previous, form) {
  try {
    const result = await manageSupportRequest(sql, await supportActor('admin'), {
      id: form.get('id'),
      version: Number(form.get('version')),
      assignedTo: form.get('assignedTo') || null,
      priority: form.get('priority'),
      relatedRequestId: form.get('relatedRequestId') || null,
      reason: form.get('reason'),
    });
    revalidatePath('/admin/support');
    revalidatePath('/admin/support/' + result.id);
    return { message: 'Assignment and case details saved.' };
  } catch (error) {
    if (error.name === 'ZodError') return { errors: error.flatten().fieldErrors };
    throw error;
  }
}
