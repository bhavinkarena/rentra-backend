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
import { recordOnboardingDestination } from '../payouts/destinations.js';
import { sql as database } from '@/services/db';

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

/**
 * Payout details live only in payout_destination. The application object keeps
 * its historical payout* keys, derived from the client's current destination.
 */
export async function withPayoutDetails(app) {
  const [p] = await database`SELECT payout_upi_id,payout_account_ref,payout_ifsc,payout_holder_name,payout_name_match
    FROM client_payout_current WHERE client_id=${app.userId}`;
  return {
    ...app,
    payoutUpiId: p?.payout_upi_id ?? null,
    payoutAccountRef: p?.payout_account_ref ?? null,
    payoutIfsc: p?.payout_ifsc ?? null,
    payoutHolderName: p?.payout_holder_name ?? null,
    payoutNameMatch: p?.payout_name_match ?? null,
  };
}

/** Find-or-create the draft. Called by every step and by the dashboard. */
export async function getOrCreateApplication(userId) {
  const [existing] = await db
    .select()
    .from(clientApplication)
    .where(eq(clientApplication.userId, userId))
    .limit(1);

  if (existing) return withPayoutDetails(existing);

  const [created] = await db
    .insert(clientApplication)
    .values({ userId, status: 'draft' })
    .returning();

  return withPayoutDetails(created);
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

  // The only store is payout_destination: a submitted, unverified version. It keeps
  // the last four digits only and records the holder-name check against the KYC name.
  const row = await recordOnboardingDestination(database, user.id, {
    method: d.method, upiId: d.upiId, accountNumber: d.accountNumber, ifsc: d.ifsc, holderName: d.holderName,
  });
  // The application's own timestamp still moves, so review fingerprints see the change.
  await db.update(clientApplication).set({ updatedAt: new Date() }).where(eq(clientApplication.id, app.id));
  const nameMatch = row.name_check === 'same' ? true : row.name_check === 'different' ? false : null;

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
