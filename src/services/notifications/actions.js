'use server';
import { revalidatePath } from 'next/cache';
import { bookingActor } from '../booking/record-page.js';
import { requireAdmin } from '../auth/admin.js';
import { sql } from '../db/index.js';
import { markNotificationRead, retryNotification, reconcileUnknownNotification } from './records.js';
export async function readNotification(form) {
  const actor = await bookingActor('customer');
  await markNotificationRead(sql, actor.session, form.get('id'));
  revalidatePath('/account/notifications');
}
export async function manageNotification(previous, form) {
  const admin = await requireAdmin();
  try {
    if (form.get('operation') === 'reconcile') await reconcileUnknownNotification(sql, admin.id, form.get('id'), form.get('sid'));
    else await retryNotification(sql, admin.id, form.get('id'));
    revalidatePath('/admin/notifications');
    return { message: 'Notification status updated. The worker will continue any due work.' };
  } catch { return { error: 'This operation could not complete. Check the pinned provider account, message SID and current delivery state. Unknown sends cannot be retried.' }; }
}
