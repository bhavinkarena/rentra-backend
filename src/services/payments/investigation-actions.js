import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { bookingActor } from '../booking/record-page.js';
import {
  InvestigationError,
  listPaymentOrders,
  readPaymentOrder,
  reconcilePaymentOrder,
} from './investigation.js';
import { sql } from '../db/index.js';

/** CP19 admin payment investigation. The admin comes from the session, never the form. */

export async function adminPaymentList(query) {
  return listPaymentOrders(sql, await bookingActor('admin'), query);
}

export async function adminPaymentDetail(id) {
  try {
    return await readPaymentOrder(sql, await bookingActor('admin'), id);
  } catch (error) {
    if (error instanceof InvestigationError && error.code === 'PAYMENT_NOT_FOUND') return null;
    throw error;
  }
}

const OUTCOME = {
  checked: 'Re-fetched from the provider. Only what the provider verified was recorded.',
  unresolved: 'The provider could not confirm an outcome. Nothing was marked paid; the payment stays pending.',
};

export async function reconcileAdminPayment(_previous, form) {
  const actor = await bookingActor('admin');
  const id = String(form.get('id') ?? '');
  try {
    const result = await reconcilePaymentOrder(sql, actor, { id, requestKey: String(form.get('requestKey') ?? '') });
    revalidatePath(`/admin/finance/payments/${id}`);
    revalidatePath('/admin/finance/payments');
    return { message: OUTCOME[result.outcome], ...result };
  } catch (error) {
    if (error instanceof ZodError) return { error: 'Reload the page and try again.', code: 'INVALID_REQUEST', status: 422 };
    if (error instanceof InvestigationError) return { error: error.message, code: error.code, status: error.status };
    throw error;
  }
}
