import { randomUUID } from 'node:crypto';
import { bodyHash } from './delivery.js';
import { ownerChannelConfiguration,ownerChannelAdapter } from './owner-delivery.js';
import { ownerPreferences,quietUntil,ownerUpdateHref,ownerEventTitles,ownerNotificationMessage } from './owner-domain.js';

export async function scheduleOwnerNotifications(database) {
  return database.begin(async tx=>{
    const visits=await tx`SELECT b.id,b.order_id,b.rentable_id,b.reference,b.local_day::text visit_date,b.slot,b.guests,b.amount_rent_minor::text rent_minor,b.starts_at,b.ends_at,b.state,r.client_id,
      (b.local_day::timestamp-interval '1 day'+interval '18 hours') AT TIME ZONE 'Asia/Kolkata' tomorrow_at,
      (b.local_day::timestamp+interval '8 hours') AT TIME ZONE 'Asia/Kolkata' today_at,
      (bo.visit_provenance<>'real' OR EXISTS(SELECT 1 FROM payment_order p WHERE p.booking_order_id=bo.id AND p.environment='test')) simulation
      FROM booking b JOIN rentable r ON r.id=b.rentable_id JOIN booking_order bo ON bo.id=b.order_id
      WHERE b.state IN ('confirmed','handed_over') AND b.starts_at<clock_timestamp()+interval '2 days' AND b.ends_at>clock_timestamp()-interval '2 days'`;
    for(const b of visits) {
      const detail=JSON.stringify({visitId:b.id,reference:b.reference,visitDate:b.visit_date,slot:b.slot,guests:b.guests,rentMinor:b.rent_minor,simulation:b.simulation});
      for(const [event,at] of [['arrival_tomorrow',b.tomorrow_at],['arrival_today',b.today_at],['checkout_overdue',new Date(+new Date(b.ends_at)+7200000)]]) {
        if(+new Date(at)>Date.now() || (event.startsWith('arrival') && (b.state!=='confirmed' || +new Date(b.starts_at)<=Date.now())) || (event==='checkout_overdue' && b.state!=='handed_over')) continue;
        await tx`SELECT client_update_insert(${b.client_id},${event+':'+b.id},'booking',${event==='checkout_overdue'?'action':'info'},${event},${b.rentable_id},${b.order_id},${detail}::text::jsonb,now())`;
      }
    }
    const properties=await tx`SELECT r.id,r.client_id FROM rentable r WHERE r.status='live' AND r.rental_unit<>'hour' AND coalesce((r.booking_config->>'autoOpen')::boolean,false)=false
      AND NOT EXISTS(SELECT 1 FROM availability a WHERE a.rentable_id=r.id AND a.day>(now() AT TIME ZONE 'Asia/Kolkata')::date+7 AND a.units_available>0)`;
    for(const p of properties) await tx`SELECT client_update_insert(${p.client_id},${'dates:'+p.id+':'+new Date(Date.now()+330*60000).toISOString().slice(0,7)},'property','action','dates_running_out',${p.id},NULL,'{}'::jsonb,now())`;
    return visits.length;
  });
}
export async function processOwnerNotification(database,id,options={}) {
  const env=options.env || process.env;
  const prepared=await database.begin(async tx=>{
    const [row]=await tx`SELECT n.*,u.email,u.phone,u.email_verified_at,u.phone_verified_at,u.notification_prefs,u.account_status,u.role,c.detail,c.kind,c.rentable_id,c.order_id,r.title property_title,
      owner_update_needs_action(c) needs_action FROM owner_notification n JOIN "user" u ON u.id=n.user_id JOIN client_update c ON c.id=n.update_id LEFT JOIN rentable r ON r.id=c.rentable_id WHERE n.id=${id} FOR UPDATE OF n`;
    if(!row || !['pending','retry','blocked','accepted','sending'].includes(row.state) || +new Date(row.next_attempt_at)>Date.now() || (row.lease_until && +new Date(row.lease_until)>Date.now())) return null;
    if(row.state==='sending') {await tx`UPDATE owner_notification SET state='unknown',failure_code='DELIVERY_OUTCOME_UNKNOWN',lease_token=NULL,lease_until=NULL WHERE id=${id}`;return null;}
    const polling=row.state==='accepted',preferences=ownerPreferences(row.notification_prefs)[row.category];
    let config,body;
    try {
      if(row.role!=='client' || !['active','pending_application'].includes(row.account_status)) throw {code:'ACCOUNT_UNAVAILABLE',suppress:true};
      if(!polling) {
        if(!(row.kind==='action' && row.category==='team' && row.channel==='email' && !preferences?.mobile && !preferences?.email) && !preferences?.[['mobile','sms','whatsapp'].includes(row.channel)?'mobile':'email']) throw {code:'OPTED_OUT',suppress:true};
        if(row.detail?.simulation && env.OWNER_NOTIFICATION_ALLOW_TEST!=='true') throw {code:'TEST_DELIVERY_DISABLED'};
        if(['checkout_overdue','dispute_response_requested','review_published','dates_running_out'].includes(row.event) && !row.needs_action) throw {code:'TASK_RESOLVED',suppress:true};
        if(row.event.startsWith('arrival_')) {const [b]=await tx`SELECT id FROM booking WHERE id::text=${row.detail?.visitId || ''} AND state='confirmed' AND starts_at>clock_timestamp()`;if(!b) throw {code:'REMINDER_OBSOLETE',suppress:true};}
        const deferred=quietUntil(options.now?.() || new Date(),row.event==='arrival_today');
        if(deferred) {await tx`UPDATE owner_notification SET next_attempt_at=${deferred.toISOString()} WHERE id=${id}`;return null;}
      }
      config=ownerChannelConfiguration(row.channel,row.event,env);
      if(polling && (config.account!==row.provider_account || config.sender!==row.sender)) throw {code:'PINNED_CHANNEL_MISSING'};
      if(!polling) {
        if(config.channel==='email' && (!row.email || !row.email_verified_at)) throw {code:'VERIFIED_EMAIL_REQUIRED'};
        if(config.channel!=='email' && (!row.phone_verified_at || !/^[6-9]\d{9}$/.test(row.phone || ''))) throw {code:'VERIFIED_PHONE_REQUIRED'};
        row.recipient=config.channel==='email'?row.email:(config.channel==='whatsapp'?'whatsapp:':'')+'+91'+row.phone;
        row.sender=config.sender;row.channel=config.channel;
      }
      if(!polling && ['booking_confirmed','visits_cancelled'].includes(row.event) && row.order_id){
        const [visit]=await tx`SELECT local_day::text AS visit_date,slot,guests,amount_rent_minor::text rent_minor,(SELECT count(*)::int FROM booking WHERE order_id=${row.order_id}) visit_count FROM booking WHERE order_id=${row.order_id} ORDER BY item_position,id LIMIT 1`;
        if(visit)row.detail={...row.detail,visitDate:visit.visit_date,slot:visit.slot,guests:visit.guests,rentMinor:visit.rent_minor,visitCount:visit.visit_count};
      }
      let origin;try{origin=new URL(env.NEXT_PUBLIC_SITE_URL).origin;}catch{throw {code:'SITE_URL_REQUIRED'};}
      body=ownerNotificationMessage(row,origin);row.title=ownerEventTitles[row.event] || 'Rentra update';if(!polling)row.body_hash=bodyHash(body);
      row.variables={'1':row.title,'2':body.split(' Open: ')[0],'3':origin+ownerUpdateHref(row)};
    } catch(error) {
      await tx`UPDATE owner_notification SET state=${polling?'accepted':error.suppress?'suppressed':'blocked'},failure_code=${/^[A-Z_]{1,64}$/.test(error.code || '')?error.code:'CHANNEL_NOT_CONFIGURED'},next_attempt_at=now()+interval '5 minutes' WHERE id=${id}`;
      return null;
    }
    const token=randomUUID();
    await tx`UPDATE owner_notification SET state=${polling?'accepted':'sending'},channel=${row.channel},attempts=attempts+${polling?0:1},recipient=${row.recipient},sender=${row.sender},body_hash=${row.body_hash},provider_account=${config.account},lease_token=${token},lease_until=now()+interval '2 minutes',next_attempt_at=now()+interval '2 minutes',failure_code=NULL WHERE id=${id}`;
    return {row,config,body,token,polling};
  });
  if(!prepared) return false;
  const {row,config,body,token,polling}=prepared;
  try {
    const adapter=options.adapter?.(config) || ownerChannelAdapter(config,options.fetcher);
    const outcome=polling?await adapter.fetch(row):await adapter.send(row,body);
    const fallback=outcome.state==='undelivered' && row.channel==='whatsapp';
    await database`UPDATE owner_notification SET state=${fallback?'pending':outcome.state==='undelivered'?'failed':outcome.state},channel=${fallback?'sms':row.channel},provider_id=${fallback?null:outcome.id},
      sent_at=coalesce(sent_at,now()),delivered_at=CASE WHEN ${outcome.state==='delivered'} THEN now() ELSE delivered_at END,
      failure_code=${outcome.failureCode || (outcome.state==='undelivered'?'PROVIDER_UNDELIVERED':null)},lease_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '30 seconds' WHERE id=${id} AND lease_token=${token}`;
  } catch(error) {
    const fallback=error.safeRetry && row.channel==='whatsapp' && error.code==='CHANNEL_REJECTED';
    const retry=error.safeRetry && row.attempts+1<5;
    await database`UPDATE owner_notification SET state=${polling?'accepted':fallback?'pending':retry?'retry':error.safeRetry?'failed':'unknown'},channel=${fallback?'sms':row.channel},
      failure_code=${/^[A-Z_]{1,64}$/.test(error.code || '')?error.code:'DELIVERY_OUTCOME_UNKNOWN'},lease_token=NULL,lease_until=NULL,next_attempt_at=now()+${Math.min(3600,30*2**row.attempts)}*interval '1 second' WHERE id=${id} AND lease_token=${token}`;
  }
  return true;
}
export async function runOwnerNotificationJobs(database,options={}) {
  await scheduleOwnerNotifications(database);
  const rows=await database`SELECT id FROM owner_notification WHERE state IN ('pending','retry','blocked','accepted','sending') AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY next_attempt_at,id LIMIT 50`;
  for(let i=0;i<rows.length;i+=5) await Promise.all(rows.slice(i,i+5).map(row=>processOwnerNotification(database,row.id,options)));
  return rows.length;
}
