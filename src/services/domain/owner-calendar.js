import {addLocalDays,propertyToday,visitInterval,isWeekendLocalDate} from './booking-dates.js';

/** State and price share the guest schedule and IST date maths. Occupancy wins over sales flags. */
export function calendarCells(listing, snapshot, rates, from, days, now=new Date()) {
 const config=listing.booking_config, today=propertyToday(now), cells=[];
 for(let n=0;n<days;n++) {
  const date=addLocalDays(from,n);
  for(const slot of ['day','night','full_day']) {
   const schedule=config?.slots?.[slot], rate=rates.find(r=>r.slot===slot);
   const weekend=isWeekendLocalDate(date,config?.weekendDays), override=snapshot.overrides.find(r=>r.day===date&&r.slot===slot);
   const price=override ? Number(override.rent_minor) : rate ? Number(weekend?rate.weekend_minor:rate.weekday_minor) : null;
   const cell={date,slot,state:'closed',effectivePriceMinor:price,priceSource:override?'override':weekend?'weekend':'weekday',schedule:schedule?.enabled?schedule:null,intervals:[]};
   if(date<today){cell.state='past';cells.push(cell);continue;}
   if(snapshot.bookings.some(b=>!b.hours_known || !snapshot.reservations.some(r=>r.booking_id===b.id))){cell.state='problem';cells.push(cell);continue;}
   if(!schedule?.enabled || !rate || !config.inventoryReady){cells.push(cell);continue;}
   let visit;try{visit=visitInterval({date,slot,schedule});}catch{cell.state='problem';cells.push(cell);continue;}
   const overlapping=snapshot.reservations.filter(r=>(r.state==='committed'||(r.state==='held'&&new Date(r.hold_expires_at)>now))&&new Date(r.blocked_start_at)<new Date(visit.blockedEndAt)&&new Date(r.blocked_end_at)>new Date(visit.blockedStartAt));
   cell.intervals=overlapping.map(r=>r.id);
   if(overlapping.some(r=>r.source==='booking'&&r.state==='committed'))cell.state='booked';
   else if(overlapping.some(r=>r.state==='held'))cell.state='hold';
   else if(overlapping.length)cell.state='blocked';
   else if(date>addLocalDays(today,config.bookingHorizonDays))cell.state='beyond';
   else if(new Date(visit.startsAt).getTime()<+now+config.leadTimeMinutes*60000)cell.state='too_soon';
   else {
    const needed=slot==='full_day'?['day','night']:[slot];
    cell.state=needed.every(s=>snapshot.availability.some(r=>r.day===date&&r.slot===s&&r.units_available>0))?'open':'closed';
   }
   cells.push(cell);
  }
 }
 return cells;
}
