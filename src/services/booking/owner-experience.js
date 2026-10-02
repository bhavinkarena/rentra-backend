import {propertyToday,addLocalDays} from '../domain/booking-dates.js';
import {z} from 'zod';
import {createHash,randomBytes} from 'node:crypto';
import {withListingInventory,InventoryError,createOwnerBlock} from './inventory.js';
import {visitInterval} from '../domain/booking-dates.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function saveOwnerBookingNote(database,ownerId,{orderId,body}){
 z.string().uuid().parse(orderId);z.string().max(500).parse(body);
 return database.begin(async tx=>{
 const [row]=await tx`SELECT o.id FROM booking_order o JOIN rentable r ON r.id=o.rentable_id JOIN "user" u ON u.id=r.client_id WHERE o.id=${orderId} AND r.client_id=${ownerId} AND u.account_status='active' FOR UPDATE OF o`;
 if(!row)throw new InventoryError('NOT_FOUND','Booking unavailable');
 await tx`UPDATE booking_order SET owner_note=${body},updated_at=now() WHERE id=${orderId}`;
 await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('client',${ownerId},'booking_order',${orderId},'owner_note_changed')`;
 return {ok:true};
 });
}
export async function regenerateCalendarFeed(database,ownerId,id){
 const token=randomBytes(32).toString('base64url');
 await withListingInventory(database,id,async(tx,listing)=>{
 const [owner]=await tx`SELECT 1 FROM "user" WHERE id=${ownerId} AND account_status='active' AND role='client' FOR SHARE`;
 if(listing.client_id!==ownerId||!owner)throw new InventoryError('NOT_FOUND','Property unavailable');
 await tx`INSERT INTO calendar_feed(rentable_id,token_hash) VALUES(${id},${hash(token)}) ON CONFLICT(rentable_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=now(),revoked_at=NULL`;
 });
 return {token};
}
const escape=value=>String(value||'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/[,;]/g,'\\$&');
const instant=value=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z/,'Z');
export async function readCalendarFeed(database,token){
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const [feed]=await database`SELECT rentable_id FROM calendar_feed WHERE token_hash=${hash(token)} AND revoked_at IS NULL`;
 if(!feed)return null;
 const rows=await database`SELECT r.id,r.source,r.kind,r.blocked_start_at,r.blocked_end_at,b.reference FROM inventory_reservation r LEFT JOIN booking b ON b.id=r.booking_id WHERE r.rentable_id=${feed.rentable_id} AND r.state='committed' AND r.blocked_end_at>now()-interval '30 days' AND r.blocked_start_at<now()+interval '1 year' ORDER BY r.blocked_start_at LIMIT 5000`;
 // Feeds deliberately omit guest contact, notes, addresses and offline-booking details.
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Rentra//Owner calendar//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
 for(const r of rows)lines.push('BEGIN:VEVENT',`UID:${r.id}@rentra`,`DTSTAMP:${instant(new Date())}`,`DTSTART:${instant(r.blocked_start_at)}`,`DTEND:${instant(r.blocked_end_at)}`,`SUMMARY:${escape(r.source==='booking'?`Booked · ${r.reference}`:r.kind==='offline_booking'?'Offline booking':'Owner block')}`,'END:VEVENT');
 lines.push('END:VCALENDAR');return lines.join('\r\n')+'\r\n';
}
export async function addOfflineBooking(database,ownerId,input){
 const value=z.object({rentableId:z.string().uuid(),date:z.string(),slot:z.enum(['day','night','full_day']),name:z.string().trim().min(2).max(100),phone:z.string().max(20).optional(),guests:z.number().int().min(1).max(500),collectedMinor:z.number().int().min(0).max(50000000).optional(),note:z.string().max(500).optional()}).strict().parse(input);
 return withListingInventory(database,value.rentableId,async(tx,listing)=>{
 if(value.guests>listing.capacity)throw new RangeError('Guest count exceeds capacity');
 const visit=visitInterval({date:value.date,slot:value.slot,schedule:listing.booking_config?.slots?.[value.slot]});
 const block=await createOwnerBlock({inventoryTransaction:{transaction:tx,listing}},ownerId,{rentableId:listing.id,blockedStartAt:visit.blockedStartAt,blockedEndAt:visit.blockedEndAt,reason:`Offline booking · ${value.name}`});
 await tx`UPDATE inventory_reservation SET kind='offline_booking',details=${JSON.stringify({name:value.name,phone:value.phone,guests:value.guests,collectedMinor:value.collectedMinor,note:value.note,slot:value.slot})}::text::jsonb WHERE id=${block.id}`;
 return {ok:true,id:block.id};
 });
}

export async function offlineBookings(database,ownerId,{staffId=null,from=propertyToday(),to=addLocalDays(from,1),contact=true}={}){
 const rows=await database`SELECT r.id,r.rentable_id,p.title,r.details,r.blocked_start_at,r.blocked_end_at FROM inventory_reservation r JOIN rentable p ON p.id=r.rentable_id JOIN "user" u ON u.id=p.client_id WHERE p.client_id=${ownerId} AND u.account_status='active' AND r.source='owner_block' AND r.kind='offline_booking' AND r.state='committed' AND r.blocked_start_at<${to}::date::timestamp AT TIME ZONE 'Asia/Kolkata' AND r.blocked_end_at>${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata' AND (${staffId}::uuid IS NULL OR EXISTS(SELECT 1 FROM staff_property sp JOIN client_staff s ON s.id=sp.staff_id WHERE sp.staff_id=${staffId} AND sp.rentable_id=p.id AND s.is_active AND s.revoked_at IS NULL AND s.accepted_at IS NOT NULL)) ORDER BY r.blocked_start_at LIMIT 100`;
 return rows.map(r=>({id:r.id,propertyId:r.rentable_id,title:r.title,name:contact?(r.details?.name?.split(/\s+/)[0]||'Guest'):'Offline booking',phone:contact?r.details?.phone:null,guests:r.details?.guests,note:r.details?.note,startsAt:new Date(r.blocked_start_at).toISOString(),endsAt:new Date(r.blocked_end_at).toISOString()}));
}
