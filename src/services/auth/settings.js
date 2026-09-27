'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/services/db';
import { users } from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
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
