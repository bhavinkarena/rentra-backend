'use server';

import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { sql } from '../db/index.js';
import { requireCustomer, getSession } from '../auth/dal.js';
import { getCurrentAdmin } from '../auth/admin.js';
import { createSession, destroySession } from '../auth/session.js';
import { SELECTION_COOKIE, readCustomerSelection } from '../auth/customer-selection.js';
import { customerRequestIp, requestCustomerCode, verifyCustomerCode } from '../auth/customer-identity.js';
import { CustomerAccountError } from '../auth/customer-access.js';
import { saveCustomerProfile, requestCustomerPrivacy } from './account.js';

import { saveProfilePhoto, PROFILE_PHOTO_MAX_BYTES } from './photo.js';

const PHONE_COOKIE = 'rentra_phone_change';
async function actor() {
  if (await getCurrentAdmin()) redirect('/login');
  await requireCustomer();
  return getSession();
}
function failure(error) {
  return { error: error.name === 'ZodError' ? error.issues[0].message
    : error instanceof CustomerAccountError ? error.message : 'We could not save that change. Please try again.' };
}
export async function updateCustomerProfile(_state, form) {
  const session=await actor();
  try {
    await saveCustomerProfile(sql,session,{
      name:form.get('name'),email:form.get('email'),preferredLocale:form.get('preferredLocale'),
      marketingConsent:form.get('marketingConsent')==='on',expectedVersion:Number(form.get('expectedVersion')),
    });
  } catch(error) { return failure(error); }
  revalidatePath('/', 'layout');
  revalidatePath('/account');
  if(form.get('onboarding')==='true') {
    const intent=await readCustomerSelection((await cookies()).get(SELECTION_COOKIE)?.value);
    redirect(intent?.returnTo ?? '/');
  }
  return { ok:'Your profile and preferences were saved.' };
}
export async function submitPrivacyRequest(_state, form) {
  const session=await actor();
  try {
    const request=await requestCustomerPrivacy(sql,session,form.get('kind'));
    revalidatePath('/account/privacy');
    return { ok:`Request recorded. Reference: ${request.id}. You can check its status below.` };
  } catch(error) { return failure(error); }
}
export async function requestPhoneChange(_state, form) {
  const session=await actor();
  const browserToken=randomUUID();
  try {
    const result=await requestCustomerCode(sql,{phone:form.get('phone'),browserToken,ip:customerRequestIp(await headers())},{changeSession:session});
    if(result.error) return result;
    (await cookies()).set(PHONE_COOKIE,`${result.challengeId}.${browserToken}`,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:300});
    return result;
  } catch(error) { return failure(error); }
}
export async function confirmPhoneChange(_state, form) {
  const session=await actor();
  const jar=await cookies();
  const [challengeId,browserToken]=(jar.get(PHONE_COOKIE)?.value ?? '').split('.');
  try {
    const result=await verifyCustomerCode(sql,{phone:form.get('phone'),code:form.get('code'),challengeId,browserToken,ip:customerRequestIp(await headers())},{changeSession:session});
    if(result.error) return result;
    await createSession(result);
    jar.delete(PHONE_COOKIE);
    jar.delete('rentra_customer_challenge');
  } catch(error) { return failure(error); }
  revalidatePath('/', 'layout');
  redirect('/account');
}
export async function logoutCustomer() {
  await actor();
  await destroySession();
  const jar=await cookies();
  for(const name of [SELECTION_COOKIE,PHONE_COOKIE,'rentra_customer_challenge']) jar.delete(name);
  revalidatePath('/', 'layout');
  return { ok:true };
}

export async function updateCustomerPhoto(_state, form) {
  const session = await actor();
  try {
    const remove = form.get('remove') === 'true';
    const file = form.get('photo');
    if (!remove && (!file || typeof file.arrayBuffer !== 'function' || !file.size || file.size > PROFILE_PHOTO_MAX_BYTES)) {
      throw new CustomerAccountError('Choose a JPG, PNG or WebP photo smaller than 2 MB.');
    }
    await saveProfilePhoto(sql, session, {
      remove, buffer: remove ? null : Buffer.from(await file.arrayBuffer()),
      expectedVersion: Number(form.get('expectedVersion')),
    });
  } catch (error) { return failure(error); }
  revalidatePath('/', 'layout');
  revalidatePath('/account');
  return { ok: form.get('remove') === 'true' ? 'Profile photo removed.' : 'Profile photo updated.' };
}
