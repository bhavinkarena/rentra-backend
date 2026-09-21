import 'server-only';
import { redirect } from 'next/navigation';
import { requireCustomer, getSession } from '../auth/dal.js';
import { getCurrentAdmin } from '../auth/admin.js';
import { readCustomerAccount } from './account.js';
import { sql } from '../db/index.js';
import { CustomerAccountError } from '../auth/customer-access.js';

export async function customerPageAccount({ onboarding = false } = {}) {
  if (await getCurrentAdmin()) redirect('/login');
  await requireCustomer();
  let account;
  try { account = await readCustomerAccount(sql, await getSession()); }
  catch(error) { if(error instanceof CustomerAccountError) redirect('/login'); throw error; }
  if (!onboarding && !account.complete) redirect('/onboarding');
  return account;
}
