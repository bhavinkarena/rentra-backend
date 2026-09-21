'use server';
import { z } from 'zod';
import { sql } from '../db/index.js';
import { getSession } from '../auth/dal.js';
import { getCurrentAdmin } from '../auth/admin.js';
import { validCustomerSession, authHash } from '../auth/customer-identity.js';
import { CustomerAccountError, CustomerSessionError } from '../auth/customer-access.js';
import { guestSavedSchema } from '../domain/saved-places.js';
import { readCustomerSaved, savedPlaceCards, changeCustomerSaved, mergeCustomerSaved } from './saved.js';

async function identity() {
  const session = await getSession();
  if (await getCurrentAdmin() || session?.role === 'client') return { mode:'other' };
  if (!session || !await validCustomerSession(sql,session)) return { mode:'guest' };
  return { mode:'customer',scope:authHash(`saved:${session.userId}:${session.sessionId}`),owner:authHash(`saved-owner:${session.userId}`),session };
}
function failure(error) {
  return { accountChanged:error instanceof CustomerSessionError, error:error instanceof CustomerAccountError ? error.message : 'Saved places could not be updated. Please try again.' };
}
export async function loadSavedPlaces() {
  try {
    const actor = await identity();
    return { mode:actor.mode,scope:actor.scope ?? null,owner:actor.owner ?? null,entries:actor.mode==='customer' ? await readCustomerSaved(sql,actor.session) : [] };
  } catch (error) { return failure(error); }
}
export async function loadGuestSavedPlaces(input) {
  try { return { entries:await savedPlaceCards(sql,guestSavedSchema.parse(input)) }; }
  catch (error) { return failure(error); }
}
export async function updateSavedPlace(scope,input) {
  try {
    z.string().length(64).parse(scope);
    const actor = await identity();
    if (actor.mode!=='customer' || actor.scope!==scope) return { error:'Your account changed. Reload saved places.',accountChanged:true };
    return { entries:await changeCustomerSaved(sql,actor.session,input) };
  } catch (error) { return failure(error); }
}
export async function mergeGuestSavedPlaces(scope,input) {
  try {
    const actor = await identity();
    if (actor.mode!=='customer' || actor.scope!==scope) return { error:'Your account changed. Reload saved places.',accountChanged:true };
    return { entries:await mergeCustomerSaved(sql,actor.session,input) };
  } catch (error) { return failure(error); }
}
