import 'server-only';
import { z } from 'zod';
import { withListingInventory } from '../booking/inventory.js';
import { lockCustomerAccount } from '../auth/customer-access.js';
const uuid = z.string().uuid();
const score = z.number().int().min(1).max(5);
const submission = z.object({ visitId: uuid, rating: score, body: z.string().trim().min(20).max(3000),
  cleanliness: score.nullable().default(null), accuracy: score.nullable().default(null), valueForMoney: score.nullable().default(null) }).strict();
export class ReviewError extends Error { constructor(code) { super(code); this.code = code; } }
async function activeAdmin(tx, id) {
  uuid.parse(id);
  if (!(await tx`SELECT id FROM admin_user WHERE id=${id} AND is_active FOR SHARE`).length) throw new ReviewError('FORBIDDEN');
}
async function scopedReview(database, id, run) {
  uuid.parse(id);
  const [scope] = await database`SELECT rentable_id FROM review WHERE id=${id} AND author_role='customer'`;
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
  return withListingInventory(database, scope.rentable_id, async tx => {
    const customer = await lockCustomerAccount(tx, session, env);
    const [eligible] = await tx`SELECT id FROM booking WHERE id=${v.visitId} AND rentra_review_eligible(id,${customer.id},rentable_id)`;
    if (!eligible) throw new ReviewError('NOT_ELIGIBLE');
    const [old] = await tx`SELECT * FROM review WHERE booking_id=${v.visitId} AND author_id=${customer.id}`;
    if (old) {
      if (old.rating!==v.rating || old.body!==v.body || old.cleanliness!==v.cleanliness || old.accuracy!==v.accuracy || old.value_for_money!==v.valueForMoney) throw new ReviewError('ALREADY_REVIEWED');
      return { id: old.id, state: old.moderation_state };
    }
    const [row] = await tx`INSERT INTO review(booking_id,rentable_id,author_id,author_role,rating,body,cleanliness,accuracy,value_for_money)
      VALUES(${v.visitId},${scope.rentable_id},${customer.id},'customer',${v.rating},${v.body},${v.cleanliness},${v.accuracy},${v.valueForMoney}) RETURNING id,moderation_state`;
    return { id: row.id, state: row.moderation_state };
  });
}
export async function reviewOrder(database, session, orderId, env = process.env) {
  uuid.parse(orderId);
  return database.begin(async tx => {
    const customer = await lockCustomerAccount(tx, session, env);
    const [order] = await tx`SELECT id,reference FROM booking_order WHERE id=${orderId} AND customer_id=${customer.id}`;
    if (!order) throw new ReviewError('NOT_FOUND');
    const visits = await tx`SELECT b.id,b.reference,b.local_day::text date,b.slot,b.state,
      rentra_review_eligible(b.id,${customer.id},b.rentable_id) eligible,r.id review_id,r.rating,r.body,r.moderation_state,r.moderation_reason
      FROM booking b LEFT JOIN review r ON r.booking_id=b.id AND r.author_id=${customer.id}
      WHERE b.order_id=${orderId} ORDER BY b.item_position,b.id`;
    return { ...order, visits };
  });
}
export async function moderateReview(database, adminId, input) {
  const v=z.object({ id:uuid, version:z.number().int().nonnegative(), state:z.enum(['published','rejected','hidden']), reason:z.string().trim().min(10).max(1000) }).strict().parse(input);
  return scopedReview(database,v.id,async(tx,row)=>{
    await activeAdmin(tx,adminId);
    if(row.version!==v.version) throw new ReviewError('CHANGED');
    if(v.state==='published' && !(await tx`SELECT 1 WHERE rentra_review_eligible(${row.booking_id},${row.author_id},${row.rentable_id})`).length) throw new ReviewError('NOT_ELIGIBLE');
    await tx`UPDATE review SET moderation_state=${v.state},moderation_reason=${v.reason},moderated_by=${adminId},moderated_at=now(),
      published_at=CASE WHEN ${v.state==='published'} THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE id=${v.id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES('admin',${adminId},'review',${v.id},'review_moderated',${JSON.stringify({state:v.state,reason:v.reason})}::jsonb)`;
  });
}
export async function replyToReview(database, ownerId, input) {
  uuid.parse(ownerId);
  const v=z.object({id:uuid,version:z.number().int().nonnegative(),body:z.string().trim().min(10).max(2000)}).strict().parse(input);
  return scopedReview(database,v.id,async(tx,row,listing)=>{
    if(listing.client_id!==ownerId || !(await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`).length) throw new ReviewError('FORBIDDEN');
    if(row.version!==v.version || !(await tx`SELECT id FROM public_customer_review WHERE id=${v.id}`).length) throw new ReviewError('CHANGED');
    await tx`UPDATE review SET owner_reply=${v.body},replied_by=${ownerId},replied_at=now(),version=version+1 WHERE id=${v.id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('client',${ownerId},'review',${v.id},'review_reply')`;
  });
}
export async function reportReview(database, actor, input, env = process.env) {
  const v=z.object({id:uuid,reason:z.string().trim().min(10).max(1000)}).strict().parse(input);
  return scopedReview(database,v.id,async(tx,row,listing)=>{
    let reporter;
    if(actor.kind==='customer') reporter=(await lockCustomerAccount(tx,actor.session,env)).id;
    else if(actor.kind==='owner') {
      uuid.parse(actor.id);
      if(listing.client_id!==actor.id || !(await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR SHARE`).length) throw new ReviewError('FORBIDDEN');
      reporter=actor.id;
    } else throw new ReviewError('FORBIDDEN');
    if(!(await tx`SELECT id FROM public_customer_review WHERE id=${row.id}`).length) throw new ReviewError('NOT_FOUND');
    const [report]=await tx`INSERT INTO review_report(review_id,reporter_id,reason) VALUES(${row.id},${reporter},${v.reason})
      ON CONFLICT(review_id,reporter_id) DO UPDATE SET reason=review_report.reason RETURNING id`;
    return report;
  });
}
export async function closeReviewReport(database,adminId,input) {
  const v=z.object({id:uuid,resolution:z.string().trim().min(10).max(1000)}).strict().parse(input);
  return database.begin(async tx=>{
    await activeAdmin(tx,adminId);
    const rows=await tx`UPDATE review_report SET state='closed',resolution=${v.resolution},resolved_by=${adminId},resolved_at=now() WHERE id=${v.id} AND state='open' RETURNING id`;
    if(!rows.length) throw new ReviewError('CHANGED');
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES('admin',${adminId},'review_report',${v.id},'review_report_closed',${JSON.stringify({resolution:v.resolution})}::jsonb)`;
  });
}
export async function reviewQueue(database,actor,page=1) {
  const offset=(Math.max(1,Math.min(10000,Number.isSafeInteger(Number(page))?Number(page):1))-1)*30;
  return database.begin(async tx=>{
    if(actor.kind==='admin') await activeAdmin(tx,actor.id);
    else if(actor.kind==='owner') {
      uuid.parse(actor.id);
      if(!(await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR SHARE`).length) throw new ReviewError('FORBIDDEN');
    } else throw new ReviewError('FORBIDDEN');
    const condition=actor.kind==='admin'?tx`true`:tx`l.client_id=${actor.id} AND r.id IN (SELECT id FROM public_customer_review)`;
    const rows=await tx`SELECT r.id,r.rating,r.body,r.owner_reply,r.version,r.moderation_state,r.moderation_reason,l.title
      FROM review r JOIN rentable l ON l.id=r.rentable_id WHERE r.author_role='customer' AND ${condition}
      ORDER BY r.created_at,r.id LIMIT 31 OFFSET ${offset}`;
    const reports=actor.kind==='admin'?await tx`SELECT p.id,p.review_id,p.reason,r.body,r.rating,r.version FROM review_report p JOIN review r ON r.id=p.review_id WHERE p.state='open' ORDER BY p.created_at,p.id LIMIT 30`:[];
    return {rows:rows.slice(0,30),reports,hasNext:rows.length>30,page:offset/30+1};
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
