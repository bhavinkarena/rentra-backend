import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { bookingSelectionSchema } from '../schemas/zod/booking.js';

export const SELECTION_COOKIE = 'rentra_login_selection';
export const SELECTION_TTL = 15 * 60;
/** An allowlist, not a generic URL parser: no origins, query redirects or encodings. */
export function safeCustomerReturnPath(value) {
  return typeof value === 'string' && /^\/listing\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 240 ? value : '/';
}
function key(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('Session secret is not configured.');
  return new TextEncoder().encode(env.SESSION_SECRET);
}
export async function signCustomerSelection(selection, returnTo, env = process.env) {
  return new SignJWT({ selection: bookingSelectionSchema.parse(selection), returnTo: safeCustomerReturnPath(returnTo) })
    .setProtectedHeader({ alg: 'HS256' }).setAudience('rentra:customer-selection').setIssuedAt().setExpirationTime(`${SELECTION_TTL}s`).sign(key(env));
}
export async function readCustomerSelection(token, env = process.env) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(env), { algorithms: ['HS256'], audience: 'rentra:customer-selection', maxTokenAge: `${SELECTION_TTL}s` });
    return { selection: bookingSelectionSchema.parse(payload.selection), returnTo: safeCustomerReturnPath(payload.returnTo) };
  } catch { return null; }
}
