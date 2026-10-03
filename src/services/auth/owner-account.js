import 'server-only';
import { z } from 'zod';
import { fieldErrors } from '@/services/schemas/zod';

const accountSchema = z.object({
  name: z.string().trim().min(3, 'Enter your full name').max(160),
  preferredLocale: z.enum(['en', 'hi', 'gu']),
}).strict();

export async function saveOwnerAccount(database, id, input, ip = null) {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const d = parsed.data;
  return database.begin(async tx => {
    const [owner] = await tx`SELECT name,preferred_locale FROM "user" WHERE id=${id} AND role='client' AND account_status IN ('active','pending_application') FOR UPDATE`;
    if (!owner) return { errors: { name: 'Your account access changed. Reload and try again.' } };
    const [application] = await tx`SELECT status FROM client_application WHERE user_id=${id} FOR UPDATE`;
    if (['submitted', 'approved'].includes(application?.status) && d.name !== owner.name)
      return { errors: { name: 'Contact support to change your name after submission.' } };
    await tx`UPDATE "user" SET name=${d.name},preferred_locale=${d.preferredLocale},profile_version=profile_version+1,updated_at=now() WHERE id=${id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",ip) VALUES('client',${id},'user',${id},'account_settings_saved',${JSON.stringify({name:owner.name,preferredLocale:owner.preferred_locale})}::text::jsonb,${JSON.stringify(d)}::text::jsonb,${ip})`;
    return { ok: true };
  });
}
