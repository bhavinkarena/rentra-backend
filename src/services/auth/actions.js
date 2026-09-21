'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { db } from '@/services/db';
import { users } from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
import {
  requestEmailOtpSchema,
  verifyEmailOtpSchema,
  requestPhoneOtpSchema,
  verifyPhoneOtpSchema,
} from '@/services/schemas/zod/auth';
import { issueOtp, verifyOtp, normaliseEmail, normalisePhone } from './otp';
import { createSession, destroySession } from './session';
import { getCurrentUser } from './dal';

/**
 * Server Actions for authentication.
 *
 * These are the writes: reads go through Server Components and lib/auth/dal.js.
 * There are no /api/* routes for our own frontend — route handlers here are
 * reserved for external callers (Razorpay, WhatsApp, cron).
 */

async function clientIp() {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? h.get('x-real-ip')
    ?? null
  );
}

function friendlyIssueError(result) {
  if (result.reason === 'cooldown') {
    const secs = Math.ceil(result.retryInMs / 1000);
    return `Wait ${secs} second${secs === 1 ? '' : 's'} before asking for a new code.`;
  }
  return 'Too many codes requested for this address. Try again in an hour.';
}

function friendlyVerifyError(result) {
  switch (result.reason) {
    case 'no_code': return 'That code has expired. Ask for a new one.';
    case 'expired': return 'That code has expired. Ask for a new one.';
    case 'too_many_attempts': return 'Too many wrong attempts. Ask for a new code.';
    default: return 'That code is not right. Check it and try again.';
  }
}

/* ------------------------------------------------------------------ *
 * CLIENT — email is the credential
 * ------------------------------------------------------------------ */

export async function requestClientOtp(_prev, formData) {
  const parsed = requestEmailOtpSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { step: 'email', errors: fieldErrors(parsed.error) };
  }

  const email = normaliseEmail(parsed.data.email);
  const ip = await clientIp();

  const result = await issueOtp({
    identifier: email, channel: 'email', purpose: 'login', ip,
  });

  if (!result.ok) {
    return { step: 'email', email, errors: { email: friendlyIssueError(result) } };
  }

  await audit({
    actorType: 'system', entity: 'user', entityId: email,
    action: 'otp_issued', after: { channel: 'email', purpose: 'login' }, ip,
  });

  return { step: 'code', email, sent: true };
}

export async function verifyClientOtp(_prev, formData) {
  const parsed = verifyEmailOtpSchema.safeParse({
    email: formData.get('email'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return {
      step: 'code',
      email: normaliseEmail(formData.get('email')),
      errors: fieldErrors(parsed.error),
    };
  }

  const email = normaliseEmail(parsed.data.email);
  const ip = await clientIp();

  const result = await verifyOtp({
    identifier: email, purpose: 'login', code: parsed.data.code,
  });

  if (!result.ok) {
    await audit({
      actorType: 'system', entity: 'user', entityId: email,
      action: 'otp_failed', after: { reason: result.reason }, ip,
    });
    return { step: 'code', email, errors: { code: friendlyVerifyError(result) } };
  }

  /**
   * Find-or-create, scoped by role.
   *
   * Uniqueness is on (email, role), so the same address can hold one Client
   * account and one Customer account. Logging in here only ever resolves the
   * CLIENT row — it never adopts or upgrades a Customer account.
   */
  let [user] = await db
    .select({ id: users.id, role: users.role, accountStatus: users.accountStatus })
    .from(users)
    .where(and(eq(users.email, email), eq(users.role, 'client')))
    .limit(1);

  const isNew = !user;

  if (isNew) {
    // Logged in immediately, but pending_application — inside the product,
    // working the stepper, not able to publish. See docs §Stage 1.
    [user] = await db
      .insert(users)
      .values({
        email,
        role: 'client',
        emailVerifiedAt: new Date(),
        accountStatus: 'pending_application',
        lastLoginAt: new Date(),
      })
      .returning({ id: users.id, role: users.role, accountStatus: users.accountStatus });
  } else {
    await db
      .update(users)
      .set({
        emailVerifiedAt: new Date(),
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
  }

  await createSession({
    userId: user.id,
    role: user.role,
    accountStatus: user.accountStatus,
  });

  await audit({
    actorType: 'client', actorId: user.id, entity: 'user', entityId: user.id,
    action: isNew ? 'account_created' : 'login',
    after: { via: result.viaBypass ? 'dev_bypass' : 'email_otp' },
    ip,
  });

  redirect('/partner');
}

/* ------------------------------------------------------------------ *
 * CLIENT — phone, verified inside the stepper (blocks submit, not login)
 * ------------------------------------------------------------------ */

export async function requestPhoneVerification(_prev, formData) {
  const user = await getCurrentUser();
  if (!user || user.role !== 'client') redirect('/partner/login');

  const parsed = requestPhoneOtpSchema.safeParse({ phone: formData.get('phone') });
  if (!parsed.success) {
    return { step: 'phone', errors: fieldErrors(parsed.error) };
  }

  const phone = normalisePhone(parsed.data.phone);
  const ip = await clientIp();

  // Reject a number already held by another Client before sending anything —
  // the unique index would otherwise fail after the OTP round trip.
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), eq(users.role, 'client')))
    .limit(1);

  if (taken && taken.id !== user.id) {
    return {
      step: 'phone',
      phone,
      errors: { phone: 'That number is already registered to another partner account.' },
    };
  }

  const result = await issueOtp({
    identifier: phone, channel: 'sms', purpose: 'verify_phone', ip,
  });

  if (!result.ok) {
    return { step: 'phone', phone, errors: { phone: friendlyIssueError(result) } };
  }

  return { step: 'code', phone, sent: true };
}

export async function confirmPhoneVerification(_prev, formData) {
  const user = await getCurrentUser();
  if (!user || user.role !== 'client') redirect('/partner/login');

  const parsed = verifyPhoneOtpSchema.safeParse({
    phone: formData.get('phone'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return {
      step: 'code',
      phone: normalisePhone(formData.get('phone')),
      errors: fieldErrors(parsed.error),
    };
  }

  const phone = normalisePhone(parsed.data.phone);
  const result = await verifyOtp({
    identifier: phone, purpose: 'verify_phone', code: parsed.data.code,
  });

  if (!result.ok) {
    return { step: 'code', phone, errors: { code: friendlyVerifyError(result) } };
  }

  await db
    .update(users)
    .set({ phone, phoneVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'user', entityId: user.id,
    action: 'phone_verified', after: { phone }, ip: await clientIp(),
  });

  redirect('/partner');
}

/* ------------------------------------------------------------------ */

export async function logout() {
  const user = await getCurrentUser();
  if (user) {
    await audit({
      actorType: user.role, actorId: user.id, entity: 'user',
      entityId: user.id, action: 'logout',
    });
  }
  await destroySession();
  redirect('/');
}

/**
 * Gap 12: someone hammering the locked "Add place" button has a property
 * ready and is stuck on paperwork. That is the strongest intent signal ops
 * will get, so record it — it sorts their application to the top of the
 * review queue and, past a few clicks, is worth a phone call rather than
 * another automated nudge.
 */
export async function recordLockedCtaClick(count) {
  const user = await getCurrentUser();
  if (!user) return;

  await audit({
    actorType: 'client',
    actorId: user.id,
    entity: 'user',
    entityId: user.id,
    action: 'locked_cta_click',
    after: { cta: 'add_place', count },
    ip: await clientIp(),
  });
}
