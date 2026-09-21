import 'server-only';
import { PAYMENT_RUNTIME } from './config.js';

export async function customerPaymentMethods(database, customerId) {
  const [active] = await database`SELECT id FROM "user" WHERE id=${customerId} AND role='customer' AND account_status='active'`;
  if (!active) throw new Error('Active customer account required');
  if (!PAYMENT_RUNTIME.savedMethodsEnabled) return [];
  // Part 22 must implement token handling and an allowlisted display DTO first.
  throw new Error('Saved payment methods are not implemented');
}
