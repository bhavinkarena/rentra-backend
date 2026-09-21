import 'server-only';

import { and, asc, desc, eq, isNull, sql as raw } from 'drizzle-orm';
import { db } from './index.js';
import {
  users, clientApplication, auditLog, adminUsers, rentable, documents,
} from './schema/index.js';

/** Published SLA from the flow doc: 2 working days for an application. */
export const SLA_HOURS = 48;

/**
 * The review queue.
 *
 * Ordered oldest-first (FIFO) so nothing rots at the bottom, but the
 * locked-CTA click count rides along as a priority signal: someone hammering
 * a locked "Add place" button has a property ready and is stuck on paperwork,
 * which is the strongest intent signal ops will get (gap 12).
 */
export async function getApplicationQueue() {
  const rows = await db
    .select({
      id: clientApplication.id,
      status: clientApplication.status,
      submittedAt: clientApplication.submittedAt,
      strikeCount: clientApplication.strikeCount,
      legalName: clientApplication.legalName,
      payoutNameMatch: clientApplication.payoutNameMatch,
      kycNameOnDoc: clientApplication.kycNameOnDoc,
      userId: users.id,
      email: users.email,
      phone: users.phone,
      clientType: users.clientType,
      preferredLocale: users.preferredLocale,
      ageHours: raw`
        round(extract(epoch from (now() - ${clientApplication.submittedAt})) / 3600)::int
      `.as('age_hours'),
      ctaClicks: raw`(
        select count(*)::int from ${auditLog}
        where ${auditLog.actorId} = ${users.id}
          and ${auditLog.action} = 'locked_cta_click'
      )`.as('cta_clicks'),
    })
    .from(clientApplication)
    .innerJoin(users, eq(users.id, clientApplication.userId))
    .where(eq(clientApplication.status, 'submitted'))
    .orderBy(asc(clientApplication.submittedAt));

  return rows.map((r) => ({
    ...r,
    overdue: (r.ageHours ?? 0) > SLA_HOURS,
    /** A confirmed payout name mismatch blocks approval — surface it early. */
    blocker: r.payoutNameMatch === false ? 'payout name mismatch' : null,
  }));
}

/** Counts for the dashboard header, in one round trip. */
export async function getQueueStats() {
  const [row] = await db
    .select({
      submitted: raw`count(*) filter (where ${clientApplication.status} = 'submitted')::int`.as('submitted'),
      overdue: raw`count(*) filter (
        where ${clientApplication.status} = 'submitted'
          and ${clientApplication.submittedAt} < now() - interval '${raw.raw(String(SLA_HOURS))} hours'
      )::int`.as('overdue'),
      drafts: raw`count(*) filter (where ${clientApplication.status} = 'draft')::int`.as('drafts'),
      moreInfo: raw`count(*) filter (where ${clientApplication.status} = 'more_info_needed')::int`.as('more_info'),
      approved: raw`count(*) filter (where ${clientApplication.status} = 'approved')::int`.as('approved'),
      rejected: raw`count(*) filter (where ${clientApplication.status} = 'rejected')::int`.as('rejected'),
    })
    .from(clientApplication);

  return row ?? {};
}

/** Full application, everything the reviewer needs on one screen. */
export async function getApplicationForReview(id) {
  const [row] = await db
    .select({
      app: clientApplication,
      user: {
        id: users.id,
        email: users.email,
        phone: users.phone,
        name: users.name,
        role: users.role,
        clientType: users.clientType,
        accountStatus: users.accountStatus,
        kycStatus: users.kycStatus,
        emailVerifiedAt: users.emailVerifiedAt,
        phoneVerifiedAt: users.phoneVerifiedAt,
        preferredLocale: users.preferredLocale,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      },
    })
    .from(clientApplication)
    .innerJoin(users, eq(users.id, clientApplication.userId))
    .where(eq(clientApplication.id, id))
    .limit(1);

  if (!row) return null;

  // Everything this person has ever done, newest first. This is what makes a
  // decision defensible three months later.
  const trail = await db
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      after: auditLog.after,
      reason: auditLog.reason,
      ip: auditLog.ip,
      at: auditLog.at,
      adminEmail: adminUsers.email,
    })
    .from(auditLog)
    .leftJoin(adminUsers, eq(adminUsers.id, auditLog.actorId))
    .where(raw`(${auditLog.actorId} = ${row.user.id} or ${auditLog.entityId} = ${id})`)
    .orderBy(desc(auditLog.at))
    .limit(40);

  const listings = await db
    .select({ id: rentable.id, title: rentable.title, status: rentable.status })
    .from(rentable)
    .where(eq(rentable.clientId, row.user.id));

  /**
   * Document METADATA only. No signed URL is minted here — a URL created for a
   * page render would be handed out whether or not the reviewer ever looks at
   * the file, and every mint is supposed to be an audited, deliberate act.
   * See `openDocument` in lib/auth/admin-actions.js.
   */
  const docs = await db
    .select({
      id: documents.id,
      docType: documents.docType,
      side: documents.side,
      mimeType: documents.mimeType,
      bytes: documents.bytes,
      status: documents.status,
      reviewNote: documents.reviewNote,
      uploadedAt: documents.uploadedAt,
    })
    .from(documents)
    .where(and(
      eq(documents.ownerType, 'client_application'),
      eq(documents.ownerId, id),
      isNull(documents.deletedAt),
    ));

  return { ...row, trail, listings, documents: docs };
}

/** Recently decided, so a mistaken approval can be found and reversed. */
export async function getRecentDecisions(limit = 10) {
  return db
    .select({
      id: clientApplication.id,
      status: clientApplication.status,
      reviewedAt: clientApplication.reviewedAt,
      decisionReason: clientApplication.decisionReason,
      email: users.email,
      userId: users.id,
      accountStatus: users.accountStatus,
      adminEmail: adminUsers.email,
    })
    .from(clientApplication)
    .innerJoin(users, eq(users.id, clientApplication.userId))
    .leftJoin(adminUsers, eq(adminUsers.id, clientApplication.reviewedBy))
    .where(and(
      raw`${clientApplication.reviewedAt} is not null`,
      raw`${clientApplication.status} <> 'submitted'`,
    ))
    .orderBy(desc(clientApplication.reviewedAt))
    .limit(limit);
}
