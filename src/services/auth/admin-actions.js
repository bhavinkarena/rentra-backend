'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/services/db';
import { adminUsers, users, clientApplication, documents } from '@/services/db/schema/index.js';
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

  await createAdminSession(admin.id);

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

const decisionSchema = z.object({
  applicationId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional().or(z.literal('')),
  flagged: z.union([z.string(), z.array(z.string())]).optional(),
});

async function loadApplication(id) {
  const [row] = await db
    .select()
    .from(clientApplication)
    .where(eq(clientApplication.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * APPROVE — closes Gate 1.
 *
 * Also flips kycStatus to 'verified': until a KYC vendor is wired, the admin's
 * name-match at review IS the verification, and the badge honestly says
 * "verified by our team". Recording it anywhere else would be a second source
 * of truth about the same fact.
 */
export async function approveApplication(_prev, formData) {
  const admin = await requireAdmin();
  const parsed = decisionSchema.safeParse({
    applicationId: formData.get('applicationId'),
    reason: formData.get('reason') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const app = await loadApplication(parsed.data.applicationId);
  if (!app) return { errors: { _: 'That application no longer exists.' } };
  if (app.status !== 'submitted') {
    // Withdrawn or already decided while this tab was open.
    return { errors: { _: `Cannot approve an application that is "${app.status}".` } };
  }

  const ip = await adminIp();

  await db.update(clientApplication).set({
    status: 'approved',
    reviewedAt: new Date(),
    reviewedBy: admin.id,
    decisionReason: parsed.data.reason || null,
    flaggedFields: null,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  await db.update(users).set({
    accountStatus: 'active',
    kycStatus: 'verified',
    updatedAt: new Date(),
  }).where(eq(users.id, app.userId));

  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'client_application',
    entityId: app.id, action: 'application_approved',
    before: { status: app.status }, after: { status: 'approved' },
    reason: parsed.data.reason || null, ip,
  });

  // TODO(notify): email + WhatsApp — "you're approved, add your first property".
  redirect('/admin?decided=approved');
}

/**
 * REQUEST MORE INFO — the third outcome, and the reason there are three.
 * Without it a fixable typo becomes a permanent rejection and a support call.
 */
export async function requestMoreInfo(_prev, formData) {
  const admin = await requireAdmin();
  const parsed = decisionSchema.safeParse({
    applicationId: formData.get('applicationId'),
    reason: formData.get('reason') ?? '',
    flagged: formData.getAll('flagged'),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  if (!parsed.data.reason) {
    return { errors: { reason: 'Say what is needed — the Client sees this verbatim.' } };
  }

  const app = await loadApplication(parsed.data.applicationId);
  if (!app) return { errors: { _: 'That application no longer exists.' } };
  if (app.status !== 'submitted') {
    return { errors: { _: `Cannot act on an application that is "${app.status}".` } };
  }

  const flagged = [].concat(parsed.data.flagged ?? []).filter(Boolean);
  const ip = await adminIp();

  await db.update(clientApplication).set({
    status: 'more_info_needed',
    reviewedAt: new Date(),
    reviewedBy: admin.id,
    decisionReason: parsed.data.reason,
    flaggedFields: flagged.length ? flagged : null,
    submittedAt: null, // back in the Client's hands; out of the queue
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'client_application',
    entityId: app.id, action: 'application_more_info',
    after: { flagged }, reason: parsed.data.reason, ip,
  });

  // Explicitly NOT a strike — asking a question is not a rejection.
  redirect('/admin?decided=more_info');
}

/**
 * REJECT — a strike. Third strike blocks the account, and only a manual
 * appeal reopens it. The reason is always recorded and always shown verbatim:
 * a silent no generates a support call and a bad review.
 */
export async function rejectApplication(_prev, formData) {
  const admin = await requireAdmin();
  const parsed = decisionSchema.safeParse({
    applicationId: formData.get('applicationId'),
    reason: formData.get('reason') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  if (!parsed.data.reason) {
    return { errors: { reason: 'A rejection must carry a reason. The Client sees it verbatim.' } };
  }

  const app = await loadApplication(parsed.data.applicationId);
  if (!app) return { errors: { _: 'That application no longer exists.' } };
  if (app.status !== 'submitted') {
    return { errors: { _: `Cannot reject an application that is "${app.status}".` } };
  }

  const strikes = app.strikeCount + 1;
  const blocked = strikes >= 3;
  const ip = await adminIp();

  await db.update(clientApplication).set({
    status: 'rejected',
    reviewedAt: new Date(),
    reviewedBy: admin.id,
    decisionReason: parsed.data.reason,
    strikeCount: strikes,
    submittedAt: null,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  if (blocked) {
    await db.update(users).set({
      accountStatus: 'blocked', updatedAt: new Date(),
    }).where(eq(users.id, app.userId));
  }

  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'client_application',
    entityId: app.id, action: 'application_rejected',
    after: { strikeCount: strikes, accountBlocked: blocked },
    reason: parsed.data.reason, ip,
  });

  redirect(`/admin?decided=${blocked ? 'blocked' : 'rejected'}`);
}

/**
 * Reverse an approval (gap 08). Every decision is reversible and audited.
 * Listings hide; confirmed bookings are still honoured — punishing a Customer
 * for their Client's misconduct is the worst possible trade.
 */
export async function suspendClient(_prev, formData) {
  const admin = await requireAdmin();
  const parsed = z.object({
    userId: z.string().uuid(),
    reason: z.string().trim().min(4, 'Say why — this is the audit record.').max(1000),
  }).safeParse({
    userId: formData.get('userId'),
    reason: formData.get('reason') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const [target] = await db
    .select({ id: users.id, accountStatus: users.accountStatus })
    .from(users)
    .where(and(eq(users.id, parsed.data.userId), eq(users.role, 'client')))
    .limit(1);

  if (!target) return { errors: { _: 'No such client.' } };

  await db.update(users).set({
    accountStatus: 'suspended', updatedAt: new Date(),
  }).where(eq(users.id, target.id));

  // TODO(step 9): cascade listings to `hidden`, storing prior_status so
  // reinstatement restores paused-vs-live correctly rather than blanket-live.

  await audit({
    actorType: 'admin', actorId: admin.id, entity: 'user', entityId: target.id,
    action: 'client_suspended',
    before: { accountStatus: target.accountStatus },
    after: { accountStatus: 'suspended' },
    reason: parsed.data.reason, ip: await adminIp(),
  });

  redirect('/admin?decided=suspended');
}

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
