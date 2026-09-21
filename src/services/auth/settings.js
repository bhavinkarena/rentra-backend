'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/services/db';
import { users, clientApplication } from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
import { payoutSchema } from '@/services/schemas/zod/application';
import { getOrCreateApplication } from './application';
import { requireClient } from './dal';

/**
 * Account settings — the fields onboarding collects once and then never let go
 * of again.
 *
 * `requireClient`, not `requireActiveClient`: a Client whose application was
 * sent back for a payout-name mismatch has to be able to fix exactly that, and
 * he is by definition not active yet. Locking this surface behind approval
 * would make the one problem it exists to solve unfixable.
 */

async function clientIp() {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
}

const accountSchema = z.object({
  name: z.string().trim().min(3, 'Enter your full name').max(160),
  preferredLocale: z.enum(['en', 'hi', 'gu']),
});

export async function saveAccountSettings(_prev, formData) {
  const user = await requireClient();
  const parsed = accountSchema.safeParse({
    name: formData.get('name'),
    preferredLocale: formData.get('preferredLocale'),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;

  await db.update(users).set({
    name: d.name,
    preferredLocale: d.preferredLocale,
    updatedAt: new Date(),
  }).where(eq(users.id, user.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'user', entityId: user.id,
    action: 'account_settings_saved',
    before: { name: user.name, preferredLocale: user.preferredLocale },
    after: { name: d.name, preferredLocale: d.preferredLocale },
    ip: await clientIp(),
  });

  revalidatePath('/partner/settings');
  revalidatePath('/partner');

  return { ok: true };
}

/**
 * Change where the money goes.
 *
 * The name match is recomputed on every save rather than trusted from the
 * original application — otherwise an approved account could be redirected to
 * a third party after review, which is the exact hole the check was put there
 * to close. A mismatch does not block the save; it blocks the payout, and the
 * Client is told which.
 */
export async function savePayoutDestination(_prev, formData) {
  const user = await requireClient();
  const app = await getOrCreateApplication(user.id);

  const parsed = payoutSchema.safeParse({
    method: formData.get('method'),
    upiId: formData.get('upiId') ?? '',
    accountNumber: formData.get('accountNumber') ?? '',
    ifsc: formData.get('ifsc') ?? '',
    holderName: formData.get('holderName'),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;

  // Same comparison the onboarding step makes, and the same weakness: until a
  // real penny-drop returns the name the BANK holds, this only catches an
  // obviously different name. See lib/auth/application.js.
  const kycName = (app.kycNameOnDoc ?? user.name ?? '').trim().toLowerCase();
  const holder = d.holderName.trim().toLowerCase();
  const nameMatch = kycName.length > 0 ? kycName === holder : null;

  // Never store a full account number in the clear.
  const maskedAccount = d.method === 'bank' ? `••••${d.accountNumber.slice(-4)}` : null;

  await db.update(clientApplication).set({
    payoutUpiId: d.method === 'upi' ? d.upiId : null,
    payoutAccountRef: maskedAccount,
    payoutIfsc: d.method === 'bank' ? d.ifsc : null,
    payoutHolderName: d.holderName,
    payoutNameMatch: nameMatch,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  await db.update(users).set({
    payoutUpiId: d.method === 'upi' ? d.upiId : null,
    payoutBankRef: maskedAccount,
    updatedAt: new Date(),
  }).where(eq(users.id, user.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'payout_changed',
    before: { method: app.payoutUpiId ? 'upi' : app.payoutAccountRef ? 'bank' : null },
    after: { method: d.method, nameMatch },
    ip: await clientIp(),
  });

  revalidatePath('/partner/settings');
  revalidatePath('/partner');

  return { ok: true, nameMatch };
}
