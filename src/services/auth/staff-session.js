import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { sql } from '@/services/db';
import { conflict, unauthorized, unprocessable } from '@/utils/apiError.js';
import { getEnv } from '@/services/schemas/joi/env';
import { issueOtp, verifyOtp } from './otp.js';
import { issuePortalSession, revokePortalSession, validPortalSession } from './portal-sessions.js';
import { capabilitiesFor } from './capabilities.js';
import { consumeInvite, invitePhone, staffForPhone, staffPhone } from './staff-team.js';

/**
 * Caretaker sign-in and session (CP16). A separate cookie and JWT audience:
 * a client, customer or admin session can never be read as a caretaker's,
 * and a caretaker cookie is invisible to the owner and admin guards.
 *
 * Joining needs the owner's one-time link AND a code sent to the invited
 * phone, so a forwarded link alone does not grant access. Codes use the
 * existing OTP rules; no SMS provider is configured yet, so outside
 * development codes cannot be delivered (the same limit as client sign-in).
 */

export const STAFF_COOKIE = 'rentra_staff';
const STAFF_TTL_SECONDS = 60 * 60 * 24 * 14;
const AUDIENCE = 'rentra:staff';
const otpIdentifier = (phone) => `staff:${phone}`;
const key = () => new TextEncoder().encode(getEnv().SESSION_SECRET);

function issueError(result) {
  if (result.reason === 'cooldown')
    return `Wait ${Math.ceil(result.retryInMs / 1000)} seconds before asking for a new code.`;
  return 'Too many codes requested for this number. Try again in an hour.';
}
function verifyError(result) {
  if (result.reason === 'too_many_attempts') return 'Too many wrong attempts. Ask for a new code.';
  if (result.reason === 'wrong_code') return 'That code is not right. Check it and try again.';
  return 'That code has expired. Ask for a new one.';
}

async function createStaffSession(staffId) {
  const sessionId = await issuePortalSession(sql, 'staff', staffId, STAFF_TTL_SECONDS);
  if (!sessionId) throw unauthorized('STAFF_REQUIRED', 'This caretaker access is not active.');
  const token = await new SignJWT({ staffId, sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${STAFF_TTL_SECONDS}s`)
    .sign(key());
  const jar = await cookies();
  jar.set(STAFF_COOKIE, token, {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STAFF_TTL_SECONDS,
  });
}

async function readStaffToken() {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], audience: AUDIENCE });
    return payload;
  } catch {
    return null;
  }
}

/** The live caretaker: re-read every request, so revocation and reassignment apply at once. */
export const getCurrentStaff = cache(async () => {
  const payload = await readStaffToken();
  if (!payload?.staffId || !(await validPortalSession(sql, payload, 'staff'))) return null;
  const [row] = await sql`SELECT s.id, s.name, s.phone, s.client_id, s.permissions, o.name AS owner_name, o.phone AS owner_phone
    FROM client_staff s JOIN "user" o ON o.id=s.client_id WHERE s.id=${payload.staffId}`;
  if (!row) return null;
  const properties = await sql`SELECT r.id, r.title FROM staff_property sp JOIN rentable r ON r.id=sp.rentable_id
    WHERE sp.staff_id=${row.id} AND r.client_id=${row.client_id} ORDER BY r.title`;
  const actor = { active: true, permissions: row.permissions };
  return {
    id: row.id,
    name: row.name,
    ownerId: row.client_id,
    ownerName: row.owner_name,
    ownerPhone: row.owner_phone,
    permissions: { evidence: row.permissions?.evidence === true },
    properties: properties.map((p) => ({ id: p.id, title: p.title })),
    capabilities: capabilitiesFor(actor, 'staff'),
  };
});

export async function endStaffSession() {
  await revokePortalSession(sql, await readStaffToken(), 'staff');
  (await cookies()).delete(STAFF_COOKIE);
}

/* --------------------------------- joining -------------------------------- */

export async function sendJoinCode(token, ip = null) {
  const phone = await invitePhone(sql, token);
  if (!phone) throw conflict('INVITE_UNUSABLE', 'This link can no longer be used. Ask the owner for a new one.');
  const result = await issueOtp({ identifier: otpIdentifier(phone), channel: 'sms', purpose: 'login', ip });
  if (!result.ok) throw unprocessable({ code: issueError(result) });
  return { sent: true, phoneHint: phone.slice(-2) };
}

export async function acceptJoin(token, code) {
  const phone = await invitePhone(sql, token);
  if (!phone) throw conflict('INVITE_UNUSABLE', 'This link can no longer be used. Ask the owner for a new one.');
  const result = await verifyOtp({ identifier: otpIdentifier(phone), purpose: 'login', code });
  if (!result.ok) throw unprocessable({ code: verifyError(result) });
  const { staffId } = await consumeInvite(sql, token);
  await createStaffSession(staffId);
  return { ok: true };
}

/* --------------------------------- sign-in -------------------------------- */

/** The same answer whether or not the number is on a team: no account discovery. */
export async function sendLoginCode(value, ip = null) {
  const phone = staffPhone(value);
  if (!phone) throw unprocessable({ phone: 'Enter a 10-digit Indian mobile number.' });
  if ((await staffForPhone(sql, phone)).length) {
    const result = await issueOtp({ identifier: otpIdentifier(phone), channel: 'sms', purpose: 'login', ip });
    if (!result.ok) throw unprocessable({ phone: issueError(result) });
  }
  return { sent: true };
}

export async function completeLogin(value, code) {
  const phone = staffPhone(value);
  if (!phone) throw unprocessable({ phone: 'Enter a 10-digit Indian mobile number.' });
  const result = await verifyOtp({ identifier: otpIdentifier(phone), purpose: 'login', code });
  if (!result.ok) throw unprocessable({ code: verifyError(result) });
  const rows = await staffForPhone(sql, phone);
  if (!rows.length) throw unauthorized('STAFF_REQUIRED', 'This number has no active caretaker access.');
  if (rows.length > 1)
    throw conflict('MULTIPLE_OWNERS', 'You work with more than one owner. Open the sign-in link from the owner you are working for.');
  await createStaffSession(rows[0].id);
  return { ok: true };
}
