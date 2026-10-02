import 'server-only';
import {z} from 'zod';
import {lockOwnerSecurity} from '../auth/owner-security.js';
import {ledger} from '../finance/statements.js';
import {conflict} from '@/utils/apiError.js';
export async function ownerPrivacyInventory(tx,id){
 const [counts]=await tx`SELECT
 (SELECT count(*)::int FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE r.client_id=${id}) orders,
 (SELECT count(*)::int FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE r.client_id=${id}) visits,
 (SELECT count(*)::int FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE r.client_id=${id} AND b.state IN ('confirmed','handed_over','returned')) active_visits,
 (SELECT count(*)::int FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE r.client_id=${id} AND o.state='held' AND o.hold_expires_at>now()) holds,
 (SELECT count(*)::int FROM dispute_case WHERE owner_id=${id} AND state<>'resolved') disputes,
 (SELECT count(*)::int FROM payout WHERE client_id=${id} AND actual_net_minor>0 AND status<>'paid') pending_payments,
 (SELECT count(*)::int FROM refund rf JOIN payment_transaction t ON t.id=rf.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order p ON p.id=a.payment_order_id JOIN booking_order o ON o.id=p.booking_order_id WHERE o.listing_snapshot->>'ownerId'=${id}::text AND rf.state IN ('requested','processing','unknown')) pending_refunds,
 (SELECT count(*)::int FROM support_request WHERE client_id=${id}) support,
 (SELECT count(*)::int FROM review r JOIN rentable l ON l.id=r.rentable_id WHERE l.client_id=${id}) reviews`;
 const [unfunded]=await tx`WITH receipts AS (${ledger(tx)}) SELECT count(*)::int n FROM receipts WHERE owner_id=${id}::text AND component='rent' AND environment='live' AND actual_minor::bigint-refunded_minor::bigint>0 AND NOT EXISTS(SELECT 1 FROM payout p WHERE p.funding_allocation_id=receipts.id AND p.status='paid')`;
 return {...counts,pending_payments:counts.pending_payments+unfunded.n,favourites:0,payment_methods:0,profileVersion:0,hasPhoto:false};
}
export const ownerPrivacyBlocked=i=>Boolean(i.active_visits||i.holds||i.disputes||i.pending_payments||i.pending_refunds);
export async function readOwnerPrivacy(database,actor){return database.begin(async tx=>{
 await lockOwnerSecurity(tx,actor);const inventory=await ownerPrivacyInventory(tx,actor.id);
 const requests=await tx`SELECT r.id,r.kind,r.state,r.created_at,r.receipt,j.state job_state,j.stage,j.error_code,j.expires_at,j.artifact_ciphertext IS NOT NULL AND j.expires_at>now() AND j.state='completed' export_available FROM customer_privacy_request r LEFT JOIN privacy_job j ON j.request_id=r.id WHERE r.customer_id=${actor.id} ORDER BY r.created_at DESC LIMIT 20`;
 return {inventory,deletionBlocked:ownerPrivacyBlocked(inventory),requests};
});}
export async function requestOwnerPrivacy(database,actor,input){
 const {kind}=z.object({kind:z.enum(['access','deletion'])}).strict().parse(input);
 return database.begin(async tx=>{
 await lockOwnerSecurity(tx,actor);
 const [existing]=await tx`SELECT id FROM customer_privacy_request WHERE customer_id=${actor.id} AND kind=${kind} AND state<>'closed'`;
 if(existing)return {...existing,message:'Your existing request is still being reviewed.'};
 if(kind==='deletion'&&ownerPrivacyBlocked(await ownerPrivacyInventory(tx,actor.id)))throw conflict('ACTIVE_OBLIGATIONS','Resolve upcoming or unfinished bookings, open disputes and pending money before requesting account deletion.');
 const [quota]=await tx`SELECT count(*)::int n FROM customer_privacy_request WHERE customer_id=${actor.id} AND created_at>now()-interval '1 day'`;
 if(quota.n>=5)throw conflict('REQUEST_LIMIT','Try again tomorrow.');
 const [request]=await tx`INSERT INTO customer_privacy_request(customer_id,kind) VALUES(${actor.id},${kind}) RETURNING id`;
 await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('client',${actor.id},'customer_privacy_request',${request.id},'owner_privacy_requested')`;
 return {...request,message:'Request saved. Rentra will review your identity and the records that must be retained.'};
 });
}
export async function ownerExportSnapshot(tx,owner){
 const limit=5001,id=owner.id,sections={};
 sections.application=await tx`SELECT status,legal_name,kyc_name_on_doc,submitted_at,created_at FROM client_application WHERE user_id=${id}`;
 sections.properties=await tx`SELECT id,title,status,description,exact_address,booking_config,created_at FROM rentable WHERE client_id=${id} ORDER BY created_at,id LIMIT ${limit}`;
 sections.bookings=await tx`SELECT b.id,b.reference,b.local_day,b.slot,b.state,b.starts_at,b.ends_at,b.guests FROM booking b JOIN rentable r ON r.id=b.rentable_id WHERE r.client_id=${id} ORDER BY b.created_at,b.id LIMIT ${limit}`;
 sections.earnings=await tx`SELECT booking_id,component,environment,actual_minor,simulated_minor,created_at FROM (${ledger(tx)}) l WHERE owner_id=${id} ORDER BY created_at,id LIMIT ${limit}`;
 sections.payouts=await tx`SELECT id,booking_id,status,actual_net_minor,settled_at FROM payout WHERE client_id=${id} LIMIT ${limit}`;
 sections.caretakers=await tx`SELECT id,name,phone,is_active,accepted_at,revoked_at FROM client_staff WHERE client_id=${id} LIMIT ${limit}`;
 sections.updates=await tx`SELECT category,action,kind,created_at,read_at FROM client_update WHERE client_id=${id} ORDER BY created_at,id LIMIT ${limit}`;
 sections.support=await tx`SELECT id,category,subject,state,created_at FROM support_request WHERE client_id=${id} LIMIT ${limit}`;
 sections.messages=await tx`SELECT m.request_id,m.actor_kind,m.body,m.created_at FROM support_message m JOIN support_request r ON r.id=m.request_id WHERE r.client_id=${id} AND NOT m.internal ORDER BY m.created_at,m.id LIMIT ${limit}`;
 sections.disputes=await tx`SELECT id,kind,state,claim_summary,resolution,created_at FROM dispute_case WHERE owner_id=${id} LIMIT ${limit}`;
 sections.disputeMessages=await tx`SELECT m.case_id,m.body,m.created_at FROM dispute_message m JOIN dispute_case c ON c.id=m.case_id WHERE c.owner_id=${id} AND m.audience IN ('owner','everyone') LIMIT ${limit}`;
 sections.replies=await tx`SELECT r.id,r.owner_reply,r.replied_at FROM review r WHERE r.replied_by=${id} LIMIT ${limit}`;
 if(Object.values(sections).some(rows=>rows.length>=limit))throw conflict('EXPORT_REVIEW_REQUIRED','Arrange a separately reviewed copy for this large account.');
 return {format:'rentra-owner-data-v1',generatedAt:new Date().toISOString(),account:{id,name:owner.name,email:owner.email,phone:owner.phone,locale:owner.preferred_locale,notificationPreferences:owner.notification_prefs,createdAt:owner.created_at},...sections,exclusions:['Authentication secrets, invitation tokens, guest contact details, private customer submissions, internal notes and provider credentials are excluded.','Binary files, shared identity documents and backups require separately reviewed copies. Historical financial and verification records may be retained after account closure.']};
}
