import 'server-only';
import { requireActiveClient, requireCustomer } from '@/services/auth/dal';
import { sql } from '@/services/db';
import { customerPaymentMethods } from './customer-methods.js';
import { ownerFinancialSummary, ownerPayoutSources } from './accounting.js';

export async function getPartnerFinancialSummary() {
  const actor = await requireActiveClient();
  // The query revalidates active status and ownership at the database boundary.
  const result = await ownerFinancialSummary(sql, actor.id);
  if (!result) throw new Error('Active partner account required');
  return result;
}

export async function getPartnerPayoutSources() {
  const actor = await requireActiveClient();
  return ownerPayoutSources(sql, actor.id);
}

export async function getCustomerPaymentMethods() {
  const actor = await requireCustomer();
  return customerPaymentMethods(sql, actor.id);
}
