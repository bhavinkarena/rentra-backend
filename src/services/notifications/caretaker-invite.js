import 'server-only';
import {bodyHash} from './delivery.js';
import {ownerChannelAdapter,ownerChannelConfiguration} from './owner-delivery.js';
/** The one-time token is never persisted or logged. A failed send retains the owner's copy-link fallback. */
export async function deliverCaretakerInvite(database,ownerId,link,options={}){
 const env=options.env || process.env;
 const [row]=await database`SELECT i.id,s.phone FROM staff_invitation i JOIN client_staff s ON s.id=i.staff_id WHERE i.id=${link.invitationId} AND s.client_id=${ownerId} AND s.id=${link.staffId} AND s.is_active AND s.revoked_at IS NULL AND i.revoked_at IS NULL AND i.used_at IS NULL AND i.expires_at>now()`;
 if(!row)return {...link,deliveryState:'not_sent',message:'Link created. Copy it and send it to the caretaker.'};
 let config,url;
 try{config=ownerChannelConfiguration('mobile','caretaker_invitation',env);url=new URL(`/staff/join/${link.token}`,env.NEXT_PUBLIC_SITE_URL).href;}catch{return {...link,deliveryState:'not_sent',message:'Link created. Copy it and send it to the caretaker.'};}
 const claimed=await database`UPDATE staff_invitation SET delivery_state='sending' WHERE id=${row.id} AND delivery_state='not_sent' RETURNING id`;
 if(!claimed.length)return {...link,deliveryState:'unknown',message:'Link created. Check whether the caretaker received it before sending a copy.'};
 const body=`Rentra caretaker invitation. Open ${url} to join. This link expires in 72 hours and needs a code sent to your phone. Never share your code.`;
 const request={id:row.id,recipient:(config.channel==='whatsapp'?'whatsapp:':'')+'+91'+row.phone,sender:config.sender,body_hash:bodyHash(body),variables:{'1':'Caretaker invitation','2':'Join your assigned properties','3':url}};
 let state='unknown',providerId=null;
 try{
  let adapter=options.adapter?.(config)||ownerChannelAdapter(config,options.fetcher);
  let outcome;
  try{outcome=await adapter.send(request,body);}catch(error){
   // Fall back only after a definite rejection; an ambiguous send may have arrived.
   if(config.channel!=='whatsapp' || !error.safeRetry || error.code!=='CHANNEL_REJECTED')throw error;
   outcome={state:'undelivered'};
  }
  if(outcome.state==='undelivered' && config.channel==='whatsapp'){
   config=ownerChannelConfiguration('sms','caretaker_invitation',env);request.recipient='+91'+row.phone;request.sender=config.sender;
   adapter=options.adapter?.(config)||ownerChannelAdapter(config,options.fetcher);outcome=await adapter.send(request,body);
  }
  state=outcome.state==='undelivered'?'failed':outcome.state;providerId=outcome.id;
 }catch(error){state=error.safeRetry?'failed':'unknown';}
 await database`UPDATE staff_invitation SET delivery_state=${state},provider_id=${providerId} WHERE id=${row.id}`;
 return {...link,deliveryState:state,message:['accepted','delivered'].includes(state)?'Invite sent. Copy the link if the caretaker needs it again.':'Link created. The send was not confirmed; check with the caretaker or copy the link.'};
}
