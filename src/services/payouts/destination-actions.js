import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { requireClient, getSession } from '../auth/dal.js';
import { requireAdmin, currentAdminSession } from '../auth/admin.js';
import {
  DestinationError,
  clientDestinationPage,
  failDestination,
  saveClientDestination,
  submitClientDraft,
} from './destinations.js';
import { sql } from '../db/index.js';

/** CP21 actions. Actors and their session ids come from the signed session cookies. */

async function owner() {
  const user = await requireClient();
  const session = await getSession();
  return { kind: 'owner', id: user.id, sessionId: session?.sessionId ?? null };
}

function failure(error) {
  if (error instanceof ZodError) return { error: 'Reload the page and try again.', code: 'INVALID_REQUEST', status: 422 };
  if (error instanceof DestinationError) {
    if (error.fields) return { errors: error.fields };
    return { error: error.message, code: error.code, status: error.status };
  }
  throw error;
}

function refresh() {
  for (const path of ['/partner/settings', '/partner/settings/payout', '/partner/earnings', '/partner']) revalidatePath(path);
}

export async function payoutDestinationPage() {
  return clientDestinationPage(sql, await owner());
}

export async function changePayoutDestination(_previous, form) {
  try {
    const result = await saveClientDestination(sql, await owner(), {
      method: form.get('method'),
      upiId: form.get('upiId') ?? '',
      accountNumber: form.get('accountNumber') ?? '',
      confirmAccountNumber: form.get('confirmAccountNumber') ?? '',
      ifsc: form.get('ifsc') ?? '',
      holderName: form.get('holderName') ?? '',
      expectedLatest: Number(form.get('expectedLatest')),
      mode: form.get('mode'),
      requestKey: form.get('requestKey'),
    });
    if (result.preview) return result;
    refresh();
    return {
      ...result,
      message:
        result.state === 'draft'
          ? 'Saved as a draft. Confirm your identity to submit it — payout changes need a recent sign-in.'
          : `Version ${result.version} submitted. Payouts stay disabled until a provider can verify it.`,
    };
  } catch (error) {
    return failure(error);
  }
}

export async function submitPayoutDraft(_previous, form) {
  try {
    const result = await submitClientDraft(sql, await owner(), {
      draftId: form.get('draftId'),
      expectedLatest: Number(form.get('expectedLatest')),
    });
    refresh();
    return { ...result, message: `Version ${result.version} submitted. Payouts stay disabled until a provider can verify it.` };
  } catch (error) {
    return failure(error);
  }
}

export async function failPayoutDestination(_previous, form) {
  const admin = await requireAdmin();
  const session = await currentAdminSession();
  try {
    const result = await failDestination(
      sql,
      { kind: 'admin', id: admin.id, sessionId: session?.sessionId ?? null },
      {
        destinationId: form.get('destinationId'),
        expectedState: form.get('expectedState'),
        reason: form.get('reason'),
        mode: form.get('mode'),
        requestKey: form.get('requestKey'),
      },
    );
    if (result.preview) return result;
    revalidatePath(`/admin/clients/${form.get('clientId')}`);
    return { ...result, message: `Version ${result.version} marked failed. The owner has been asked for a new destination.` };
  } catch (error) {
    return failure(error);
  }
}
