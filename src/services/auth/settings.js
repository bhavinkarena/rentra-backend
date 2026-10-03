'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { sql } from '@/services/db';
import { saveOwnerAccount } from './owner-account.js';
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

export async function saveAccountSettings(_prev, formData) {
  const user = await requireClient();
  const saved = await saveOwnerAccount(sql, user.id, {
    name: formData.get('name'),
    preferredLocale: formData.get('preferredLocale'),
  }, await clientIp());
  if (!saved.ok) return saved;
  revalidatePath('/partner/settings');
  revalidatePath('/partner');
  return saved;
}
