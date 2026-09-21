import 'server-only';
import { z } from 'zod';
import { CustomerAccountError, lockCustomerAccount } from '../auth/customer-access.js';

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least two characters for your name.').max(160).refine(v => !/[\u0000-\u001f\u007f]/.test(v)),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]),
  preferredLocale: z.enum(['en', 'hi', 'gu']),
  marketingConsent: z.boolean(),
  expectedVersion: z.number().int().nonnegative().max(2147483646),
}).strict();

export async function readCustomerAccount(database, session, env = process.env) {
  return database.begin(async tx => {
    const user = await lockCustomerAccount(tx, session, env);
    const [profile] = await tx`SELECT marketing_consent,version FROM customer_profile WHERE user_id=${user.id}`;
    const requests = await tx`SELECT id,kind,state,created_at FROM customer_privacy_request
      WHERE customer_id=${user.id} ORDER BY created_at DESC LIMIT 20`;
    return { name: user.name ?? '', email: user.email ?? '', phone: user.phone,
      emailVerified: Boolean(user.email_verified_at), preferredLocale: user.preferred_locale,
      marketingConsent: profile?.marketing_consent ?? false, version: profile?.version ?? 0,
      complete: Boolean(profile && user.name?.trim()),
      requests: requests.map(r => ({ id:r.id,kind:r.kind,state:r.state,createdAt:new Date(r.created_at).toISOString() })) };
  });
}

export async function saveCustomerProfile(database, session, input, env = process.env) {
  const value = profileSchema.parse(input);
  try {
    return await database.begin(async tx => {
      const user = await lockCustomerAccount(tx, session, env);
      const [before] = await tx`SELECT version,marketing_consent FROM customer_profile WHERE user_id=${user.id}`;
      if ((before?.version ?? 0) !== value.expectedVersion) throw new CustomerAccountError('Your profile changed in another tab. Reload before saving.');
      const email = value.email || null;
      await tx`UPDATE "user" SET name=${value.name},email=${email},preferred_locale=${value.preferredLocale},
        email_verified_at=CASE WHEN email IS NOT DISTINCT FROM ${email} THEN email_verified_at ELSE NULL END,updated_at=now()
        WHERE id=${user.id}`;
      await tx`INSERT INTO customer_profile(user_id,marketing_consent) VALUES (${user.id},${value.marketingConsent})
        ON CONFLICT(user_id) DO UPDATE SET marketing_consent=excluded.marketing_consent,
        consent_updated_at=CASE WHEN customer_profile.marketing_consent<>excluded.marketing_consent THEN now() ELSE customer_profile.consent_updated_at END,
        version=customer_profile.version+1,updated_at=now()`;
      // Audit consent without placing names/contact details in an operational log.
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES
        ('customer',${user.id},'customer_profile',${user.id},'customer_profile_saved',
        ${JSON.stringify({ marketingConsent:value.marketingConsent,version:value.expectedVersion+1 })}::jsonb)`;
      return { version:value.expectedVersion+1 };
    });
  } catch(error) {
    if(error.code==='23505') throw new CustomerAccountError('That email cannot be used. Try another email or leave it empty.');
    throw error;
  }
}

export async function requestCustomerPrivacy(database, session, kind, env = process.env) {
  z.enum(['access','deletion']).parse(kind);
  return database.begin(async tx => {
    const user=await lockCustomerAccount(tx,session,env);
    const [existing]=await tx`SELECT id FROM customer_privacy_request WHERE customer_id=${user.id} AND kind=${kind} AND state<>'closed'`;
    if(existing) return existing;
    const [count]=await tx`SELECT count(*)::int AS n FROM customer_privacy_request WHERE customer_id=${user.id} AND created_at>now()-interval '1 day'`;
    if(count.n>=5) throw new CustomerAccountError('Please wait until tomorrow before opening another privacy request.');
    const [request]=await tx`INSERT INTO customer_privacy_request(customer_id,kind) VALUES(${user.id},${kind}) RETURNING id`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES
      ('customer',${user.id},'customer_privacy_request',${request.id},'privacy_requested')`;
    return request;
  });
}
