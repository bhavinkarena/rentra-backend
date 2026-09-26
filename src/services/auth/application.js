'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/services/db';
import { users, clientApplication } from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
import {
  detailsSchema, payoutSchema, consentSchema,
} from '@/services/schemas/zod/application';
import { getCurrentUser } from './dal';
import { profileCompletion } from './profile';
import { listDocuments } from './documents';

/**
 * Gate 1 — the onboarding application, one Server Action per step.
 *
 * Every step saves independently so a half-finished application survives a
 * closed tab, and the steps can be completed in any order: someone who has
 * their PAN to hand but not their bank details should not be blocked by our
 * sequencing.
 */

async function clientIp() {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
}

/** Find-or-create the draft. Called by every step and by the dashboard. */
export async function getOrCreateApplication(userId) {
  const [existing] = await db
    .select()
    .from(clientApplication)
    .where(eq(clientApplication.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(clientApplication)
    .values({ userId, status: 'draft' })
    .returning();

  return created;
}

/**
 * A submitted application is READ-ONLY. Editing requires withdrawing it first,
 * otherwise an admin can approve a version that no longer exists (gap 11).
 */
async function assertEditable(app) {
  if (app.status === 'submitted') redirect('/partner?locked=in_review');
  if (app.status === 'approved') redirect('/partner');
}

async function loadContext() {
  const user = await getCurrentUser();
  if (!user || user.role !== 'client') redirect('/partner/login');
  const app = await getOrCreateApplication(user.id);
  return { user, app };
}

/* ------------------------------- details ------------------------------- */

export async function saveDetails(_prev, formData) {
  const { user, app } = await loadContext();
  await assertEditable(app);

  const parsed = detailsSchema.safeParse({
    legalName: formData.get('legalName'),
    residentialAddress: formData.get('residentialAddress'),
    pincode: formData.get('pincode'),
    preferredLocale: formData.get('preferredLocale'),
    clientType: formData.get('clientType'),
    ownerName: formData.get('ownerName') ?? '',
    ownerRelationship: formData.get('ownerRelationship') ?? '',
    intendedListingCount: formData.get('intendedListingCount') || undefined,
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const d = parsed.data;

  await db.update(clientApplication).set({
    legalName: d.legalName,
    residentialAddress: d.residentialAddress,
    pincode: d.pincode,
    ownerName: d.ownerName || null,
    ownerRelationship: d.ownerRelationship || null,
    intendedListingCount: d.intendedListingCount ?? null,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  // Name and locale live on `user` — they are identity, not application data.
  await db.update(users).set({
    name: d.legalName,
    clientType: d.clientType,
    preferredLocale: d.preferredLocale,
    updatedAt: new Date(),
  }).where(eq(users.id, user.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'details_saved', ip: await clientIp(),
  });

  redirect('/partner');
}

/* --------------------------------- KYC ---------------------------------
 * Superseded by uploadKycDocuments in lib/auth/documents.js — the identity
 * step now requires actual document images, not a typed number, so the
 * upload and the name are saved together in one action.
 */

/* -------------------------------- payout -------------------------------- */

export async function savePayout(_prev, formData) {
  const { user, app } = await loadContext();
  await assertEditable(app);

  const parsed = payoutSchema.safeParse({
    method: formData.get('method'),
    upiId: formData.get('upiId') ?? '',
    accountNumber: formData.get('accountNumber') ?? '',
    ifsc: formData.get('ifsc') ?? '',
    holderName: formData.get('holderName'),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const d = parsed.data;

  /**
   * TODO(vendor): a real penny-drop returns the name the bank holds, which is
   * then compared to the KYC name. Until then we compare the holder name the
   * Client typed against their KYC name — weaker, but it catches the obvious
   * case of paying a third party, and the Super Admin sees both at review.
   */
  const kycName = (app.kycNameOnDoc ?? user.name ?? '').trim().toLowerCase();
  const holder = d.holderName.trim().toLowerCase();
  const nameMatch = kycName.length > 0 ? kycName === holder : null;

  // Never store a full account number in the clear. Keep a masked reference —
  // enough for the Client to recognise it and for support to reconcile.
  const maskedAccount = d.method === 'bank'
    ? `••••${d.accountNumber.slice(-4)}`
    : null;

  await db.update(clientApplication).set({
    payoutUpiId: d.method === 'upi' ? d.upiId : null,
    payoutAccountRef: maskedAccount,
    payoutIfsc: d.method === 'bank' ? d.ifsc : null,
    payoutHolderName: d.holderName,
    payoutNameMatch: nameMatch,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  await db.update(users).set({
    payoutUpiId: d.method === 'upi' ? d.upiId : null,
    payoutBankRef: maskedAccount,
    updatedAt: new Date(),
  }).where(eq(users.id, user.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'payout_saved',
    after: { method: d.method, nameMatch }, ip: await clientIp(),
  });

  redirect('/partner');
}

/* ---------------------------- consent + submit ---------------------------- */

export async function saveConsent(_prev, formData) {
  const { user, app } = await loadContext();
  await assertEditable(app);

  const parsed = consentSchema.safeParse({
    acceptTerms: formData.get('acceptTerms'),
    declareEntitled: formData.get('declareEntitled'),
  });

  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const ip = await clientIp();

  await db.update(clientApplication).set({
    consentAt: new Date(),
    consentIp: ip,
    updatedAt: new Date(),
  }).where(eq(clientApplication.id, app.id));

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'consent_given', ip,
  });

  redirect('/partner');
}

/**
 * Submit for review. Re-checks completeness server-side rather than trusting
 * the button was only rendered when complete.
 */
export async function submitApplication() {
  const { user, app } = await loadContext();
  await assertEditable(app);

  /**
   * Completeness is checked against profileCompletion — the SAME function the
   * stepper renders from — rather than a second hand-written list.
   *
   * This previously had its own list, and the two drifted: the stepper demanded
   * kycStatus === 'verified' while this only wanted a kycRef, so the bar showed
   * 5 of 6 while submit thought it was ready. One definition, no drift.
   */
  const documents = await listDocuments({
    ownerType: 'client_application', ownerId: app.id,
  });
  const completion = profileCompletion(user, app, documents);

  if (completion.remaining.length) {
    const labels = completion.remaining.map((s) => s.label.toLowerCase()).join(', ');
    return { errors: { _: `Still to do: ${labels}` } };
  }

  // Conditional + version bump: a decision made from a screen that predates
  // this submission can no longer commit (CP05).
  const submitted = await db.update(clientApplication).set({
    status: 'submitted',
    submittedAt: new Date(),
    flaggedFields: null,
    reviewVersion: sql`${clientApplication.reviewVersion} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(clientApplication.id, app.id),
    inArray(clientApplication.status, ['draft', 'more_info_needed', 'rejected']),
  )).returning({ id: clientApplication.id });
  if (!submitted.length) redirect('/partner');

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'application_submitted', ip: await clientIp(),
  });

  redirect('/partner?submitted=1');
}

/**
 * Withdraw so it becomes editable again (gap 11). Explicitly NOT a strike —
 * a Client correcting their own typo has done nothing wrong.
 */
export async function withdrawApplication() {
  const { user, app } = await loadContext();
  if (app.status !== 'submitted') redirect('/partner');

  // Only a still-submitted application can be withdrawn; never overwrite a decision.
  const withdrawn = await db.update(clientApplication).set({
    status: 'draft',
    submittedAt: null,
    reviewVersion: sql`${clientApplication.reviewVersion} + 1`,
    updatedAt: new Date(),
  }).where(and(eq(clientApplication.id, app.id), eq(clientApplication.status, 'submitted')))
    .returning({ id: clientApplication.id });
  if (!withdrawn.length) redirect('/partner');

  await audit({
    actorType: 'client', actorId: user.id, entity: 'client_application',
    entityId: app.id, action: 'application_withdrawn', ip: await clientIp(),
  });

  redirect('/partner');
}
