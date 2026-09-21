import 'server-only';
import { z } from 'zod';

export class CustomerAccountError extends Error {}
export class CustomerSessionError extends CustomerAccountError {}

/** User then session locks match account-status revocation trigger ordering. */
export async function lockCustomerAccount(tx, session, env = process.env) {
  if (session?.role !== 'customer' || !z.string().uuid().safeParse(session.userId).success
    || !z.string().uuid().safeParse(session.sessionId).success
    || (session.development && !['development', 'test'].includes(env.NODE_ENV))) {
    throw new CustomerSessionError('Please log in to your customer account again.');
  }
  const [user] = await tx`SELECT id,name,email,phone,preferred_locale,email_verified_at FROM "user"
    WHERE id=${session.userId} AND role='customer' AND account_status='active' FOR UPDATE`;
  const [active] = user ? await tx`SELECT id FROM customer_session WHERE id=${session.sessionId}
    AND user_id=${user.id} AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE` : [];
  if (!active) throw new CustomerSessionError('Please log in to your customer account again.');
  return user;
}
