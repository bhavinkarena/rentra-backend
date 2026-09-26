import 'server-only';

import { and, desc, eq, isNull, sql as raw } from 'drizzle-orm';
import { db } from './index.js';
import {
  users, clientApplication, auditLog, adminUsers, rentable, documents,
} from './schema/index.js';

/** Published SLA from the flow doc: 2 working days for an application. */
export const SLA_HOURS = 48;

/* The paginated review queue lives in services/admin/applications.js (CP05). */

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
