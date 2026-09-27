import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { bookingActor } from '../booking/record-page.js';
import {
  RefundOperationError,
  listRefunds,
  previewOperatorRefund,
  readRefund,
  refundableVisits,
  reconcileRefundObligation,
  requestOperatorRefund,
} from './refund-operations.js';
import { sql } from '../db/index.js';

/** CP20 admin refund operations. The admin comes from the session, never the form. */

export async function adminRefundList(query) {
  return listRefunds(sql, await bookingActor('admin'), query);
}

export async function adminRefundDetail(id) {
  try {
    return await readRefund(sql, await bookingActor('admin'), id);
  } catch (error) {
    if (error instanceof RefundOperationError && error.code === 'REFUND_NOT_FOUND') return null;
    throw error;
  }
}

export async function adminRefundableVisits(orderId) {
  try {
    return await refundableVisits(sql, await bookingActor('admin'), orderId);
  } catch (error) {
    if (error instanceof RefundOperationError && error.code === 'ORDER_NOT_FOUND') return null;
    throw error;
  }
}

function failure(error) {
  if (error instanceof ZodError) {
    const fields = Object.fromEntries(error.issues.map((issue) => [issue.path[0] ?? '_', issue.message]));
    return { errors: fields, error: 'Check the highlighted fields.', status: 422 };
  }
  if (error instanceof RefundOperationError) return { error: error.message, code: error.code, status: error.status };
  throw error;
}

const amounts = (form) => ({
  orderId: String(form.get('orderId') ?? ''),
  visitId: String(form.get('visitId') ?? ''),
  rent: form.get('rent') || 0,
  fee: form.get('fee') || 0,
  deposit: form.get('deposit') || 0,
});

export async function previewAdminRefund(_previous, form) {
  try {
    return { preview: await previewOperatorRefund(sql, await bookingActor('admin'), amounts(form)) };
  } catch (error) {
    return failure(error);
  }
}

export async function requestAdminRefund(_previous, form) {
  try {
    const result = await requestOperatorRefund(sql, await bookingActor('admin'), {
      ...amounts(form),
      reason: String(form.get('reason') ?? ''),
      hash: String(form.get('hash') ?? ''),
      requestKey: String(form.get('requestKey') ?? ''),
    });
    revalidatePath('/admin/finance/refunds');
    revalidatePath(`/admin/bookings/${amounts(form).orderId}`);
    return { message: 'Refund requested. It is sent to Razorpay Test once and is not refunded until Razorpay confirms it.', ...result };
  } catch (error) {
    return failure(error);
  }
}

const OUTCOME = {
  refunded: 'Razorpay confirmed the refund as processed.',
  pending: 'Razorpay has the refund and is processing it. It is not refunded yet.',
  unresolved: 'Razorpay could not confirm an outcome. Nothing was resent; the refund stays pending.',
};

export async function reconcileAdminRefund(_previous, form) {
  const id = String(form.get('id') ?? '');
  try {
    const result = await reconcileRefundObligation(sql, await bookingActor('admin'), {
      id,
      requestKey: String(form.get('requestKey') ?? ''),
    });
    revalidatePath(`/admin/finance/refunds/${id}`);
    revalidatePath('/admin/finance/refunds');
    return { message: OUTCOME[result.outcome], ...result };
  } catch (error) {
    return failure(error);
  }
}
