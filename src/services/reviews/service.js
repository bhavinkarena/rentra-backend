import 'server-only';
import { visitLabel } from '../domain/booking-record.js';
import { AppError } from '../../utils/apiError.js';
import { reviewPreviewToken, moderationAllowed, REVIEW_REASONS } from './policy.js';
import { z } from 'zod';
import { withListingInventory } from '../booking/inventory.js';
import { lockCustomerAccount } from '../auth/customer-access.js';
const uuid = z.string().uuid();
const score = z.number().int().min(1).max(5);
const submission = z
  .object({
    visitId: uuid,
    rating: score,
    body: z.string().trim().min(20).max(3000),
    cleanliness: score.nullable().default(null),
    accuracy: score.nullable().default(null),
    valueForMoney: score.nullable().default(null),
  })
  .strict();
export class ReviewError extends AppError {
  constructor(code) {
    super(
      {
        CHANGED: 'This review changed. Reload and try again.',
        PREVIEW_REQUIRED: 'Preview these exact values before confirming.',
        INVALID_REASON: 'Choose a policy basis. Negative sentiment is not a removal reason.',
      }[code] || code,
      ['NOT_FOUND', 'FORBIDDEN'].includes(code) ? 404 : 409,
      { code },
    );
  }
}
async function activeAdmin(tx, id, write = true) {
  uuid.parse(id);
  if (
    !(
      await tx`SELECT id FROM admin_user WHERE id=${id} AND is_active AND (permissions IS NULL OR permissions @> ${JSON.stringify([`admin.reviews.${write ? 'write' : 'read'}`])}::text::jsonb) FOR SHARE`
    ).length
  )
    throw new ReviewError('FORBIDDEN');
}
async function scopedReview(database, id, run) {
  if (!uuid.safeParse(id).success) throw new ReviewError('NOT_FOUND');
  const [scope] =
    await database`SELECT rentable_id FROM review WHERE id=${id} AND author_role='customer'`;
  if (!scope?.rentable_id) throw new ReviewError('NOT_FOUND');
  return withListingInventory(database, scope.rentable_id, async (tx, listing) => {
    const [row] = await tx`SELECT * FROM review WHERE id=${id} FOR UPDATE`;
    return run(tx, row, listing);
  });
}
export async function submitReview(database, session, input, env = process.env) {
  const v = submission.parse(input);
  const [scope] = await database`SELECT rentable_id FROM booking WHERE id=${v.visitId}`;
  if (!scope) throw new ReviewError('NOT_ELIGIBLE');
  return withListingInventory(database, scope.rentable_id, async (tx) => {
    const customer = await lockCustomerAccount(tx, session, env);
    const [eligible] =
      await tx`SELECT id FROM booking WHERE id=${v.visitId} AND rentra_review_eligible(id,${customer.id},rentable_id)`;
    if (!eligible) throw new ReviewError('NOT_ELIGIBLE');
    const [old] =
      await tx`SELECT * FROM review WHERE booking_id=${v.visitId} AND author_id=${customer.id}`;
    if (old) {
      if (
        old.rating !== v.rating ||
        old.body !== v.body ||
        old.cleanliness !== v.cleanliness ||
        old.accuracy !== v.accuracy ||
        old.value_for_money !== v.valueForMoney
      )
        throw new ReviewError('ALREADY_REVIEWED');
      return { id: old.id, state: old.moderation_state };
    }
    const [row] =
      await tx`INSERT INTO review(booking_id,rentable_id,author_id,author_role,rating,body,cleanliness,accuracy,value_for_money)
      VALUES(${v.visitId},${scope.rentable_id},${customer.id},'customer',${v.rating},${v.body},${v.cleanliness},${v.accuracy},${v.valueForMoney}) RETURNING id,moderation_state`;
    return { id: row.id, state: row.moderation_state };
  });
}
export async function reviewOrder(database, session, orderId, env = process.env) {
  uuid.parse(orderId);
  return database.begin(async (tx) => {
    const customer = await lockCustomerAccount(tx, session, env);
    const [order] =
      await tx`SELECT id,reference FROM booking_order WHERE id=${orderId} AND customer_id=${customer.id}`;
    if (!order) throw new ReviewError('NOT_FOUND');
    const visits = await tx`SELECT b.id,b.reference,b.local_day::text date,b.slot,b.state,b.starts_at,b.ends_at,b.hours_known,b.time_zone,b.slot_snapshot,
      rentra_review_eligible(b.id,${customer.id},b.rentable_id) eligible,r.id review_id,r.rating,r.body,r.moderation_state,r.moderation_reason
      FROM booking b LEFT JOIN review r ON r.booking_id=b.id AND r.author_id=${customer.id}
      WHERE b.order_id=${orderId} ORDER BY b.item_position,b.id`;
    return { ...order, visits: visits.map(({ starts_at, ends_at, hours_known, time_zone, slot_snapshot, ...v }) => ({ ...v, label: visitLabel({ ...v, starts_at, ends_at, hours_known, time_zone, slot_snapshot }) })) };
  });
}
export async function moderateReview(database, adminId, input) {
  const v = z
    .object({
      id: uuid,
      version: z.number().int().nonnegative(),
      state: z.enum(['published', 'rejected', 'hidden']),
      reason: z.string().trim().min(10).max(1000),
      category: z.enum(REVIEW_REASONS),
      preview: z.boolean().default(false),
      previewToken: z.string().optional(),
    })
    .strict()
    .parse(input);
  return scopedReview(database, v.id, async (tx, row) => {
    await activeAdmin(tx, adminId);
    if (row.version !== v.version) throw new ReviewError('CHANGED');
    if (!moderationAllowed(v.state, v.category)) throw new ReviewError('INVALID_REASON');
    if (
      v.state === 'published' &&
      !(
        await tx`SELECT 1 WHERE rentra_review_eligible(${row.booking_id},${row.author_id},${row.rentable_id})`
      ).length
    )
      throw new ReviewError('NOT_ELIGIBLE');
    const values = { state: v.state, reason: v.reason, category: v.category };
    const token = reviewPreviewToken(adminId, row.id, row.version, 'moderate', values);
    const effect =
      v.state === 'published'
        ? 'The original review, score and current owner reply become public and count toward the property rating.'
        : 'The review and owner reply leave public view and the property rating. Original content and decisions remain preserved.';
    if (v.preview)
      return {
        preview: {
          token,
          values,
          effect,
          body: row.body,
          rating: row.rating,
          ownerReply: row.owner_reply,
        },
      };
    if (v.previewToken !== token) throw new ReviewError('PREVIEW_REQUIRED');
    await tx`UPDATE review SET moderation_state=${v.state},moderation_reason=${v.reason},moderated_by=${adminId},moderated_at=now(),
      published_at=CASE WHEN ${v.state === 'published'} THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE id=${v.id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after") VALUES('admin',${adminId},'review',${v.id},'review_moderated',${JSON.stringify({ state: row.moderation_state, reason: row.moderation_reason, version: row.version })}::text::jsonb,${JSON.stringify({ ...values, version: row.version + 1 })}::text::jsonb)`;
  });
}
export async function replyToReview(database, ownerId, input) {
  uuid.parse(ownerId);
  const v = z
    .object({
      id: uuid,
      version: z.number().int().nonnegative(),
      body: z.string().trim().min(10).max(2000).nullable(),
      preview: z.boolean().default(false),
      previewToken: z.string().optional(),
    })
    .strict()
    .parse(input);
  return scopedReview(database, v.id, async (tx, row, listing) => {
    if (
      listing.client_id !== ownerId ||
      !(
        await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`
      ).length
    )
      throw new ReviewError('FORBIDDEN');
    if (
      row.version !== v.version ||
      !(await tx`SELECT id FROM public_customer_review WHERE id=${v.id}`).length
    )
      throw new ReviewError('CHANGED');
    const values = { body: v.body },
      token = reviewPreviewToken(ownerId, row.id, row.version, 'reply', values);
    if (v.preview)
      return {
        preview: {
          token,
          values,
          effect:
            'This reply replaces the current public owner reply. Earlier replies remain in the response history.',
          body: row.body,
          rating: row.rating,
          ownerReply: v.body,
        },
      };
    await tx`UPDATE review SET owner_reply=${v.body},replied_by=${v.body === null ? null : ownerId},replied_at=CASE WHEN ${v.body===null} THEN NULL ELSE now() END,version=version+1 WHERE id=${v.id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after") VALUES('client',${ownerId},'review',${v.id},'review_reply',${JSON.stringify({ body: row.owner_reply, version: row.version })}::text::jsonb,${JSON.stringify({ body: v.body, version: row.version + 1 })}::text::jsonb)`;
  });
}
export async function reportReview(database, actor, input, env = process.env) {
  const v = z
    .object({ id: uuid, reason: z.string().trim().min(10).max(1000) })
    .strict()
    .parse(input);
  return scopedReview(database, v.id, async (tx, row, listing) => {
    let reporter;
    if (actor.kind === 'customer')
      reporter = (await lockCustomerAccount(tx, actor.session, env)).id;
    else if (actor.kind === 'owner') {
      uuid.parse(actor.id);
      if (
        listing.client_id !== actor.id ||
        !(
          await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR SHARE`
        ).length
      )
        throw new ReviewError('FORBIDDEN');
      reporter = actor.id;
    } else throw new ReviewError('FORBIDDEN');
    if (!(await tx`SELECT id FROM public_customer_review WHERE id=${row.id}`).length)
      throw new ReviewError('NOT_FOUND');
    const [existing] = await tx`SELECT id,created_at FROM review_report WHERE review_id=${row.id} AND reporter_id=${reporter}`;
    if (existing) return { id: existing.id, alreadyReported: true, reportedAt: new Date(existing.created_at).toISOString() };
    const [report] =
      await tx`INSERT INTO review_report(review_id,reporter_id,reason) VALUES(${row.id},${reporter},${v.reason})
      ON CONFLICT(review_id,reporter_id) DO UPDATE SET reason=review_report.reason RETURNING id,created_at`;
    return {id: report.id, reportedAt: new Date(report.created_at).toISOString()};
  });
}
export async function closeReviewReport(database, adminId, input) {
  const v = z
    .object({ id: uuid, resolution: z.string().trim().min(10).max(1000) })
    .strict()
    .parse(input);
  return database.begin(async (tx) => {
    await activeAdmin(tx, adminId);
    const rows =
      await tx`UPDATE review_report SET state='closed',resolution=${v.resolution},resolved_by=${adminId},resolved_at=now() WHERE id=${v.id} AND state='open' RETURNING id`;
    if (!rows.length) throw new ReviewError('CHANGED');
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES('admin',${adminId},'review_report',${v.id},'review_report_closed',${JSON.stringify({ resolution: v.resolution })}::text::jsonb)`;
  });
}
export async function reviewQueue(database, actor, page = 1, rentableId = null, tab = 'all') {
  const offset =
    (Math.max(1, Math.min(10000, Number.isSafeInteger(Number(page)) ? Number(page) : 1)) - 1) * 30;
  return database.begin(async (tx) => {
    if (actor.kind === 'admin') await activeAdmin(tx, actor.id, false);
    else if (actor.kind === 'owner') {
      uuid.parse(actor.id);
      if (
        !(
          await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR SHARE`
        ).length
      )
        throw new ReviewError('FORBIDDEN');
    } else throw new ReviewError('FORBIDDEN');
    const condition =
      actor.kind === 'admin'
        ? tx`true`
        : tx`l.client_id=${actor.id} AND (r.id IN (SELECT id FROM public_customer_review) OR EXISTS(SELECT 1 FROM review_report rp WHERE rp.review_id=r.id AND rp.reporter_id=${actor.id}))`;
    // PROP: one property's reviews (property hub Reviews tab).
    const property = rentableId ? tx`AND r.rentable_id=${uuid.parse(rentableId)}` : tx``;
    const rows =
      await tx`SELECT r.id,r.rating,r.body,r.owner_reply,r.version,r.moderation_state,r.rentable_id,l.title,r.created_at,
        split_part(coalesce(u.name,'Guest'),' ',1) guest_first_name,b.local_day::text visit_date,b.reference visit_reference,
        (SELECT p.created_at FROM review_report p WHERE p.review_id=r.id AND p.reporter_id=${actor.id}) reported_at
      FROM review r JOIN rentable l ON l.id=r.rentable_id JOIN "user" u ON u.id=r.author_id JOIN booking b ON b.id=r.booking_id
      WHERE r.author_role='customer' AND ${condition} ${property} ${actor.kind === 'owner' && tab === 'needs_reply' ? tx`AND r.owner_reply IS NULL AND r.id IN (SELECT id FROM public_customer_review)` : tx``}
      ORDER BY r.created_at DESC,r.id DESC LIMIT 31 OFFSET ${offset}`;
    const reports =
      actor.kind === 'admin'
        ? await tx`SELECT p.id,p.review_id,p.reason,r.body,r.rating,r.version FROM review_report p JOIN review r ON r.id=p.review_id WHERE p.state='open' ORDER BY p.created_at,p.id LIMIT 30`
        : [];
    const [stats] = actor.kind === 'owner' ? await tx`SELECT count(*)::int count,round(avg(r.rating)::numeric,1) average FROM public_customer_review r JOIN rentable l ON l.id=r.rentable_id WHERE l.client_id=${actor.id} ${property}` : [{}];
    return { stats, tab: tab === 'needs_reply' ? 'needs_reply' : 'all', rows: rows.slice(0, 30), reports, hasNext: rows.length > 30, page: offset / 30 + 1 };
  });
}

/**
 * One published review, as the reporting form shows it back to the reporter.
 *
 * Reads the `public_customer_review` view rather than the `review` table: the
 * view is already filtered to what a signed-in customer is allowed to see, so
 * a moderated or withdrawn review cannot be surfaced by guessing its id.
 */
export async function publicReview(database, id) {
  uuid.parse(id);
  const [row] = await database`
    SELECT id, body, owner_reply FROM public_customer_review WHERE id=${id}`;
  if (!row) throw new ReviewError('NOT_FOUND');
  return { id: row.id, body: row.body, ownerReply: row.owner_reply ?? null };
}

/** Owners see published feedback plus their own reports; private third-party reports stay admin-only. */
export async function reviewDetail(database, actor, id) {
  if (!uuid.safeParse(id).success) throw new ReviewError('NOT_FOUND');
  return database.begin(async (tx) => {
    if (actor.kind === 'admin') await activeAdmin(tx, actor.id, false);
    else if (actor.kind !== 'owner') throw new ReviewError('FORBIDDEN');
    const [row] =
      await tx`SELECT r.*,l.title,b.order_id,b.reference visit_reference,b.local_day::text visit_date,
   EXISTS(SELECT 1 FROM public_customer_review p WHERE p.id=r.id) public,
   l.review_count,l.rating_avg
   FROM review r JOIN rentable l ON l.id=r.rentable_id JOIN booking b ON b.id=r.booking_id
   WHERE r.id=${id} AND r.author_role='customer' AND ${actor.kind === 'admin' ? tx`true` : tx`l.client_id=${actor.id} AND EXISTS(SELECT 1 FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active') AND (r.id IN (SELECT id FROM public_customer_review) OR EXISTS(SELECT 1 FROM review_report WHERE review_id=r.id AND reporter_id=${actor.id}))`}`;
    if (!row) throw new ReviewError('NOT_FOUND');
    const reports =
      await tx`SELECT id,reason,state,resolution,created_at,resolved_at FROM review_report WHERE review_id=${id} AND ${actor.kind === 'admin' ? tx`true` : tx`reporter_id=${actor.id}`} ORDER BY created_at,id`;
    const history =
      await tx`SELECT action,at,"before","after" FROM audit_log WHERE entity='review' AND entity_id=${id} AND ${actor.kind === 'admin' ? tx`true` : tx`action='review_reply' AND actor_id=${actor.id}`} ORDER BY at,id`;
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      rating: row.rating,
      ownerReply: row.owner_reply,
      version: row.version,
      state: row.moderation_state,
      public: row.public,
      propertyId: row.rentable_id,
      orderId: row.order_id,
      visitReference: row.visit_reference,
      visitDate: row.visit_date,
      reviewCount: row.review_count,
      ratingAverage: row.rating_avg,
      reports,
      history,
      ...(actor.kind === 'admin'
        ? { moderationReason: row.moderation_reason, authorId: row.author_id }
        : {}),
    };
  });
}
