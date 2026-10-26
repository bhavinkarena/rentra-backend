import 'server-only';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { bookingSelectionSchema } from '../schemas/zod/booking.js';

/** A hotel search the guest was pricing before login (hotel plan, Phase 7): dates and party only. */
const stayIntentSchema = z.object({
  kind: z.literal('stay'), rentableId: z.string().uuid(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms: z.number().int().min(1).max(8), adults: z.number().int().min(1).max(48),
  children: z.array(z.number().int().min(0).max(17)).max(16).default([]),
  replacesOrderId: z.string().uuid().optional(),
}).strict();
export const loginSelectionSchema = z.union([stayIntentSchema, bookingSelectionSchema]);

export const SELECTION_COOKIE = 'rentra_login_selection';
export const SELECTION_TTL = 15 * 60;
/** An allowlist, not a generic URL parser: no origins, query redirects or encodings. */
export function safeCustomerReturnPath(value) {
  return typeof value === 'string' && /^\/listing\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 240 ? value : '/';
}
/** Story 2.3: a signed-in customer page to return to after login. Same-origin paths only, no query. */
export function safeCustomerAreaPath(value) {
  return typeof value === 'string' && value.length <= 240
    && /^\/(checkout|bookings|account|support|disputes|reviews)(\/[A-Za-z0-9_-]+)*$/.test(value) ? value : null;
}
function key(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('Session secret is not configured.');
  return new TextEncoder().encode(env.SESSION_SECRET);
}
export async function signCustomerSelection(selection, returnTo, env = process.env) {
  return new SignJWT({ selection: loginSelectionSchema.parse(selection), returnTo: safeCustomerReturnPath(returnTo) })
    .setProtectedHeader({ alg: 'HS256' }).setAudience('rentra:customer-selection').setIssuedAt().setExpirationTime(`${SELECTION_TTL}s`).sign(key(env));
}
export async function readCustomerSelection(token, env = process.env) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(env), { algorithms: ['HS256'], audience: 'rentra:customer-selection', maxTokenAge: `${SELECTION_TTL}s` });
    return { selection: loginSelectionSchema.parse(payload.selection), returnTo: safeCustomerReturnPath(payload.returnTo) };
  } catch { return null; }
}
