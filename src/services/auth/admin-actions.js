'use server';

import { redirect } from 'next/navigation';
import { decideApplication } from '@/services/admin/applications.js';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, sql } from '@/services/db';
import { adminUsers, documents } from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
import { getEnv } from '@/services/schemas/joi/env';
import { verifyPassword, verifyTotp, LOCKOUT } from './admin-crypto';
import { createAdminSession, destroyAdminSession, requireAdmin } from './admin';

/* ------------------------------- login ------------------------------- */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter your email'),
  password: z.string().min(1, 'Enter your password'),
  totp: z.string().trim().optional().or(z.literal('')),
});

async function adminIp() {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
}

export async function adminLogin(_prev, formData) {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    totp: formData.get('totp') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const { email, password, totp } = parsed.data;
  const ip = await adminIp();

  const [admin] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  /**
   * One generic message for "no such admin", "wrong password" and
   * "inactive account". Distinguishing them tells an attacker which admin
   * emails exist, which is exactly the thing worth not telling them.
   */
  const generic = { errors: { password: 'Those details are not right.' } };

  if (!admin || !admin.isActive) {
    await audit({
      actorType: 'system', entity: 'admin_user', entityId: email,
      action: 'admin_login_failed', after: { reason: 'unknown_or_inactive' }, ip,
    });
    return generic;
  }

  if (admin.lockedUntil && new Date(admin.lockedUntil) > new Date()) {
    const mins = Math.ceil((new Date(admin.lockedUntil) - Date.now()) / 60000);
    return { errors: { password: `Locked for ${mins} more minute${mins === 1 ? '' : 's'}.` } };
  }

  if (!verifyPassword(password, admin.passwordHash)) {
    const attempts = admin.failedAttempts + 1;
    const lock = attempts >= LOCKOUT.maxAttempts;

    await db.update(adminUsers).set({
      failedAttempts: attempts,
      lockedUntil: lock ? new Date(Date.now() + LOCKOUT.lockMinutes * 60_000) : null,
    }).where(eq(adminUsers.id, admin.id));

    await audit({
      actorType: 'system', entity: 'admin_user', entityId: admin.id,
      action: 'admin_login_failed',
      after: { reason: 'bad_password', attempts, locked: lock }, ip,
    });

    return lock
      ? { errors: { password: `Too many attempts. Locked for ${LOCKOUT.lockMinutes} minutes.` } }
      : generic;
  }

  /**
   * PRODUCTION HARD-STOP. TOTP is optional in development so nobody is
   * fighting an authenticator app while building, but an admin account with
   * no second factor must not be usable in production — it approves listings
   * and releases payouts, so a leaked password would be the whole system.
   *
   * Refusing at login, rather than warning in a comment, is what makes this
   * real. Same posture as the OTP bypass guard.
   */
  if (getEnv().NODE_ENV === 'production' && !admin.totpSecret) {
    await audit({
      actorType: 'system', entity: 'admin_user', entityId: admin.id,
      action: 'admin_login_blocked', after: { reason: 'no_totp_in_production' }, ip,
    });
    return {
      errors: {
        password: 'This account needs two-factor authentication set up before it '
          + 'can be used in production. Run the admin seed script to enrol it.',
      },
    };
  }

  // Otherwise TOTP is enforced whenever a secret exists.
  if (admin.totpSecret) {
    if (!totp) return { errors: { totp: 'Enter your 6-digit authenticator code.' }, needsTotp: true };
    if (!verifyTotp({ secret: admin.totpSecret, token: totp })) {
      await audit({
        actorType: 'system', entity: 'admin_user', entityId: admin.id,
        action: 'admin_login_failed', after: { reason: 'bad_totp' }, ip,
      });
      return { errors: { totp: 'That code is not right.' }, needsTotp: true };
    }
  }

  await db.update(adminUsers).set({
    failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(),
  }).where(eq(adminUsers.id, admin.id));

  await createAdminSession(admin.id, { email: admin.email, passwordHash: admin.passwordHash, totpSecret: admin.totpSecret });

  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'admin_user',
    entityId: admin.id, action: 'admin_login',
    after: { totpUsed: Boolean(admin.totpSecret) }, ip,
  });

  redirect('/admin');
}

export async function adminLogout() {
  const admin = await requireAdmin();
  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'admin_user',
    entityId: admin.id, action: 'admin_logout',
  });
  await destroyAdminSession();
  redirect('/admin/login');
}

/* --------------------------- review decisions --------------------------- */

/**
 * Gate 1 decisions. The rules, locking and single audit entry live in
 * services/admin/applications.js (CP05); these actions keep the existing
 * routes and redirects. Every decision names the `expectedVersion` it
 * reviewed — a stale screen gets 409 and changes nothing.
 *
 * APPROVE closes Gate 1. `kyc_status='verified'` means "reviewed by Rentra
 * staff": no KYC provider is connected, and client-facing copy says so.
 * REQUEST MORE INFO is not a strike. REJECT is; the third blocks the account.
 */
async function decide(decision, formData) {
  const admin = await requireAdmin();
  const result = await decideApplication(sql, {
    adminId: admin.id,
    applicationId: String(formData.get('applicationId') ?? ''),
    decision,
    input: {
      reason: formData.get('reason') ?? '',
      flagged: formData.getAll('flagged'),
      expectedVersion: formData.get('expectedVersion'),
    },
    ip: await adminIp(),
  });
  const outcome = decision === 'reject' && result.accountBlocked ? 'blocked' : { approve: 'approved', more_info: 'more_info', reject: 'rejected' }[decision];
  redirect(`/admin?decided=${outcome}`);
}

export async function approveApplication(_prev, formData) {
  return decide('approve', formData);
}

export async function requestMoreInfo(_prev, formData) {
  return decide('more_info', formData);
}

export async function rejectApplication(_prev, formData) {
  return decide('reject', formData);
}

/* Client suspension and reinstatement moved to services/admin/clients.js (CP03). */

/* --------------------------- document access --------------------------- */

/**
 * NOTE: there is no 'openDocument' action any more.
 *
 * It used to mint a signed Cloudinary URL and hand it to the browser, but
 * Cloudinary's expiring tokens are a paid add-on — without them the URL never
 * expired, so "expires in 5 minutes" was a false promise (verified: an
 * expired URL still returned 200).
 *
 * Documents are now streamed through GET /admin/documents/[id], which
 * re-checks the live admin session on every request and audits each fetch.
 */

/** Mark one document accepted or rejected, with a note the Client will see. */
export async function reviewDocument(_prev, formData) {
  const admin = await requireAdmin();
  const parsed = z.object({
    documentId: z.string().uuid(),
    outcome: z.enum(['accepted', 'rejected']),
    note: z.string().trim().max(500).optional().or(z.literal('')),
  }).safeParse({
    documentId: formData.get('documentId'),
    outcome: formData.get('outcome'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const { documentId, outcome, note } = parsed.data;

  if (outcome === 'rejected' && !note) {
    return { errors: { note: 'Say what is wrong with it — the Client sees this.' } };
  }

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) return { errors: { _: 'That document is no longer available.' } };

  await db.update(documents).set({
    status: outcome,
    reviewedBy: admin.id,
    reviewNote: note || null,
  }).where(eq(documents.id, doc.id));

  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'document', entityId: doc.id,
    action: `document_${outcome}`,
    before: { status: doc.status }, after: { status: outcome },
    reason: note || null, ip: await adminIp(),
  });

  return { ok: true, outcome };
}
