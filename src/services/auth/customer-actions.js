'use server';

import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from '../db/index.js';
import { getCurrentUser } from './dal.js';
import { getCurrentAdmin, destroyAdminSession } from './admin.js';
import { createSession, destroySession } from './session.js';
import { customerPhone, customerRequestIp, requestCustomerCode, verifyCustomerCode } from './customer-identity.js';
import { SELECTION_COOKIE, SELECTION_TTL, signCustomerSelection, readCustomerSelection } from './customer-selection.js';
import { bookingSelectionSchema } from '../schemas/zod/booking.js';
import { listingPath } from '../domain/listing-url.js';
import { measure } from '../operations/measurement.js';

const CHALLENGE_COOKIE = 'rentra_customer_challenge';
const cookieOptions = (maxAge) => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge });
async function roleConflict() {
  const user = await getCurrentUser();
  return (user && user.role !== 'customer') || Boolean(await getCurrentAdmin());
}

export async function beginCustomerLogin(input) {
  const parsed = bookingSelectionSchema.safeParse(input);
  if (!parsed.success) return { error: 'Choose valid dates, slot and guests before logging in.' };
  const [listing] = await sql`SELECT slug,public_code FROM rentable WHERE id=${parsed.data.rentableId} AND status='live'`;
  if (!listing) return { error: 'This listing is no longer available.' };
  const jar = await cookies();
  jar.set(SELECTION_COOKIE, await signCustomerSelection(parsed.data, listingPath(listing.slug, listing.public_code)), cookieOptions(SELECTION_TTL));
  redirect('/login');
}

export async function requestCustomerOtp(_previous, formData) {
  if (await roleConflict()) return { error: 'Sign out of your current role before customer login.' };
  const phone = customerPhone.safeParse(formData.get('phone'));
  if (!phone.success) return { error: 'Enter a valid Indian mobile number.' };
  const browserToken = randomUUID();
  try {
    const result = await requestCustomerCode(sql, { phone: phone.data, browserToken, ip: customerRequestIp(await headers()) });
    if (result.error) { await measure(sql, 'otp_request_rejected'); return result; }
    (await cookies()).set(CHALLENGE_COOKIE, `${result.challengeId}.${browserToken}`, cookieOptions(300));
    return result;
  } catch { await measure(sql, 'otp_request_rejected'); return { error: 'Phone login is temporarily unavailable. Please try again later.' }; }
}

export async function verifyCustomerOtp(_previous, formData) {
  if (await roleConflict()) return { error: 'Sign out of your current role before customer login.' };
  let result;
  const jar = await cookies();
  const [challengeId, browserToken] = (jar.get(CHALLENGE_COOKIE)?.value ?? '').split('.');
  try {
    result = await verifyCustomerCode(sql, { phone: formData.get('phone'), code: formData.get('code'), challengeId, browserToken, ip: customerRequestIp(await headers()) });
    if (result.error) { await measure(sql, 'otp_rejected'); return result; }
  } catch { return { error: 'Phone login is temporarily unavailable. Please try again later.' }; }
  await destroySession();
  await createSession(result);
  if (!result.development) await measure(sql, 'login_completed');
  jar.delete(CHALLENGE_COOKIE);
  const [profile] = await sql`SELECT p.user_id FROM customer_profile p JOIN "user" u ON u.id=p.user_id
    WHERE p.user_id=${result.userId} AND length(trim(u.name))>=2`;
  if (!profile) redirect('/onboarding');
  const intent = await readCustomerSelection(jar.get(SELECTION_COOKIE)?.value);
  // No anonymous quote survives this navigation. The listing requests a fresh owned quote.
  redirect(intent?.returnTo ?? '/account');
}

/** Explicit user action; keeps the saved listing selection while changing role. */
export async function switchToCustomer() {
  await destroySession();
  await destroyAdminSession();
  (await cookies()).delete(CHALLENGE_COOKIE);
  redirect('/login');
}

/** Called after hydration so public listing pages remain cacheable and identity-free. */
export async function restoreCustomerSelection(rentableId) {
  const user = await getCurrentUser();
  const intent = await readCustomerSelection((await cookies()).get(SELECTION_COOKIE)?.value);
  return {
    isCustomer: user?.role === 'customer' && user.accountStatus === 'active',
    selection: intent?.selection.rentableId === rentableId ? intent.selection : null,
  };
}
