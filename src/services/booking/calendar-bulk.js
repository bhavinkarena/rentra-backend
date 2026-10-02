import {createHmac,timingSafeEqual} from 'node:crypto';
import {calendarSnapshot} from './owner-calendar.js';
import {z} from 'zod';
import {calendarCommand} from './owner-calendar.js';
import {withListingInventory,expireInventoryHolds,getInventoryState,InventoryError} from './inventory.js';
import {visitInterval,addLocalDays,isWeekendLocalDate,isLocalDate} from '../domain/booking-dates.js';

const date=z.string().refine(isLocalDate,'Choose a valid date');
const cell=z.object({date,slot:z.enum(['day','night','full_day'])}).strict();
const schema=z.object({cells:z.array(cell).min(1).max(1098),command:z.enum(['slots','prices']),open:z.boolean().optional(),rentMinor:z.number().int().min(50000).max(50000000).optional(),deltaBps:z.number().int().min(-9900).max(100000).optional(),reset:z.boolean().optional()}).strict();
export async function changeCalendarCells(database,ownerId,input) {
 const value=schema.parse(input.change);
 if(new Set(value.cells.map(c=>`${c.date}:${c.slot}`)).size!==value.cells.length)throw new RangeError('Choose each slot once');
 const days=value.cells.map(c=>c.date).sort();if(new Date(days.at(-1))-new Date(days[0])>365*86400000)throw new RangeError('Choose at most 366 days');
 if(value.command==='slots'&&typeof value.open!=='boolean')throw new RangeError('Choose Open or Close');
 if(value.command==='prices'&&[value.rentMinor!=null,value.deltaBps!=null,value.reset===true].filter(Boolean).length!==1)throw new RangeError('Choose one price change');
 const values={cells:JSON.stringify(value.cells),change:JSON.stringify(value)};
 const changed=await calendarCommand(database,ownerId,{...input,command:value.command,values},adapter=>withListingInventory(adapter,input.rentableId,async(tx,listing)=>{
  const [owner]=await tx`SELECT 1 FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`;
  if(!owner || listing.client_id!==ownerId)throw new InventoryError('NOT_FOUND','Property unavailable');
  if(listing.rental_unit==='hour')throw new RangeError('Use court hours and blocks for a venue');
  await expireInventoryHolds(tx,listing.id);
  const state=await getInventoryState(tx,listing,{from:`${days[0]}T00:00:00+05:30`,to:`${addLocalDays(days.at(-1),2)}T00:00:00+05:30`});
  const rates=await tx`SELECT slot,weekday_minor,weekend_minor FROM rentable_price WHERE rentable_id=${listing.id}`;
  const overrides=await tx`SELECT day::text,slot,rent_minor FROM booking_price_override WHERE rentable_id=${listing.id} AND day BETWEEN ${days[0]} AND ${days.at(-1)}`;
  const affected=[],conflicts=[],warnings=[];
  for(const c of value.cells){
   const schedule=listing.booking_config?.slots?.[c.slot], rate=rates.find(r=>r.slot===c.slot);
   if(!schedule?.enabled||!rate)throw new RangeError(`${c.slot.replace('_',' ')} is not offered. Turn it on in Booking rules and Pricing first.`);
   const visit=visitInterval({date:c.date,slot:c.slot,schedule});
   if(value.command==='slots'&&!value.open){
    const clashes=state.reservations.filter(r=>new Date(r.blocked_start_at)<new Date(visit.blockedEndAt)&&new Date(r.blocked_end_at)>new Date(visit.blockedStartAt));
    if(clashes.length){conflicts.push({...c,reservations:clashes.map(r=>({id:r.id,orderId:state.bookings.find(b=>b.id===r.booking_id)?.order_id,source:r.source}))});continue;}
   }
   const before=overrides.find(r=>r.day===c.date&&r.slot===c.slot),base=Number(isWeekendLocalDate(c.date,listing.booking_config?.weekendDays)?rate.weekend_minor:rate.weekday_minor);
   const after=value.command==='prices'?(value.reset?null:value.rentMinor??Math.round(base*(10000+value.deltaBps)/10000)):value.open?1:0;
   if(value.command==='prices'&&after!=null&&after<50000)throw new RangeError('Enter at least ₹500, or close the slot instead');
   affected.push({...c,oldOverride:before?Number(before.rent_minor):null,beforeRows:state.availability.filter(r=>r.day===c.date&&(c.slot==='full_day'?['day','night'].includes(r.slot):r.slot===c.slot)),before:value.command==='prices'?(before?Number(before.rent_minor):base):state.availability.find(r=>r.day===c.date&&r.slot===c.slot)?.units_available??0,after});
  }
  if(conflicts.length){if(!input.preview){const e=new InventoryError('INVENTORY_CONFLICT','Nothing changed. Some selected slots have active reservations.');e.conflicts=conflicts;throw e;}return {affected,conflicts,warnings};}
  for(const c of affected){
   if(value.command==='prices'){
    if(c.after===null)await tx`DELETE FROM booking_price_override WHERE rentable_id=${listing.id} AND day=${c.date} AND slot=${c.slot}`;
    else await tx`INSERT INTO booking_price_override(rentable_id,day,slot,rent_minor) VALUES(${listing.id},${c.date},${c.slot},${c.after}) ON CONFLICT(rentable_id,day,slot) DO UPDATE SET rent_minor=excluded.rent_minor,updated_at=now()`;
   }else for(const s of c.slot==='full_day'?['day','night']:[c.slot])await tx`INSERT INTO availability(rentable_id,day,slot,units_available) VALUES(${listing.id},${c.date},${s},${c.after}) ON CONFLICT(rentable_id,day,slot) DO UPDATE SET units_available=excluded.units_available`;
  }
  if(value.command==='prices')for(const day of new Set(days)){
   const [prices]=await tx`SELECT sum(rent_minor) FILTER(WHERE slot IN ('day','night')) combined,max(rent_minor) FILTER(WHERE slot='full_day') full_price FROM booking_price_override WHERE rentable_id=${listing.id} AND day=${day}`;
   const full=rates.find(r=>r.slot==='full_day');if(full&&Number(prices.combined)>Number(prices.full_price??(isWeekendLocalDate(day,listing.booking_config?.weekendDays)?full.weekend_minor:full.weekday_minor)))warnings.push(`${day}: Full day is cheaper than Day + Night. Select Full day too to update it.`);
  }
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES('client',${ownerId},'rentable',${listing.id},${'calendar_bulk_'+value.command},${JSON.stringify(affected)}::text::jsonb)`;
  return {affected,conflicts,warnings,undoVersion:(await calendarSnapshot(tx,listing,{from:`${days[0]}T00:00:00+05:30`,to:`${addLocalDays(days.at(-1),2)}T00:00:00+05:30`})).version};
 }));
 if(changed.ok){
 const window={from:`${days[0]}T00:00:00+05:30`,to:`${addLocalDays(days.at(-1),2)}T00:00:00+05:30`};
 // Capture the post-command version while locked in the same command below, to make Undo conditional.
 if(changed.result.undoVersion){const payload=Buffer.from(JSON.stringify({ownerId,id:input.rentableId,expires:Date.now()+10000,rows:changed.result.affected,command:value.command,version:changed.result.undoVersion,window})).toString('base64url');changed.undoToken=payload+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(payload).digest('hex');changed.undoUntil=Date.now()+10000;}
 }
 return changed;

}

export async function undoCalendarCells(database,ownerId,token){
 if(typeof token!=='string'||token.length>400000)throw new RangeError('Undo unavailable');
 const [payload,signature]=token.split('.'),expected=createHmac('sha256',process.env.SESSION_SECRET).update(payload||'').digest('hex');
 if(!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new RangeError('Undo unavailable');
 const value=JSON.parse(Buffer.from(payload,'base64url').toString());
 if(value.ownerId!==ownerId||value.expires<Date.now())throw new RangeError('Undo expired');
 return withListingInventory(database,value.id,async(tx,listing)=>{
 if(listing.client_id!==ownerId||!(await tx`SELECT 1 FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`).length)throw new InventoryError('NOT_FOUND','Property unavailable');
 if((await calendarSnapshot(tx,listing,value.window)).version!==value.version)throw new InventoryError('CALENDAR_CHANGED','These dates changed. Undo would overwrite newer work.');
 for(const c of value.rows){
 if(value.command==='prices'){
  if(c.oldOverride===null)await tx`DELETE FROM booking_price_override WHERE rentable_id=${value.id} AND day=${c.date} AND slot=${c.slot}`;
  else await tx`INSERT INTO booking_price_override(rentable_id,day,slot,rent_minor) VALUES(${value.id},${c.date},${c.slot},${c.oldOverride}) ON CONFLICT(rentable_id,day,slot) DO UPDATE SET rent_minor=excluded.rent_minor,updated_at=now()`;
 }else{
  const slots=c.slot==='full_day'?['day','night']:[c.slot];
  await tx`DELETE FROM availability WHERE rentable_id=${value.id} AND day=${c.date} AND slot IN ${tx(slots)}`;
  for(const row of c.beforeRows)await tx`INSERT INTO availability(rentable_id,day,slot,units_available) VALUES(${value.id},${c.date},${row.slot},${row.units_available})`;
 }
 }
 await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('client',${ownerId},'rentable',${value.id},'calendar_bulk_undone')`;
 return {ok:true};
 });
}
