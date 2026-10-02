import { NotificationError, smsAdapter } from './delivery.js';
export function ownerChannelConfiguration(channel,event,env) {
  if(env.OWNER_NOTIFICATION_DELIVERY!=='enabled') throw new NotificationError('OWNER_CHANNELS_DISABLED',true);
  if(channel==='email') {
    if(!env.RESEND_API_KEY || !env.OTP_EMAIL_FROM) throw new NotificationError('EMAIL_NOT_CONFIGURED',true);
    return {channel,account:'resend',token:env.RESEND_API_KEY,sender:env.OTP_EMAIL_FROM};
  }
  if(!/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') || !env.TWILIO_AUTH_TOKEN) throw new NotificationError('MOBILE_NOT_CONFIGURED',true);
  let templates={};try{templates=JSON.parse(env.OWNER_WHATSAPP_TEMPLATES_JSON || '{}');}catch{throw new NotificationError('INVALID_TEMPLATES',true);}
  const whatsapp=channel==='whatsapp' || (channel==='mobile' && /^HX[a-f0-9]{32}$/i.test(templates[event] || '') && /^whatsapp:\+[1-9]\d{7,14}$/.test(env.TWILIO_WHATSAPP_FROM || ''));
  const sender=whatsapp?env.TWILIO_WHATSAPP_FROM:env.TWILIO_FROM_NUMBER;
  if(!sender || !(whatsapp?/^whatsapp:\+[1-9]\d{7,14}$/:/^\+[1-9]\d{7,14}$/).test(sender)) throw new NotificationError('MOBILE_NOT_CONFIGURED',true);
  if(whatsapp && !/^HX[a-f0-9]{32}$/i.test(templates[event] || '')) throw new NotificationError('TEMPLATE_NOT_CONFIGURED',true);
  return {channel:whatsapp?'whatsapp':'sms',account:env.TWILIO_ACCOUNT_SID,token:env.TWILIO_AUTH_TOKEN,sender,contentSid:templates[event]};
}
export function ownerChannelAdapter(config,fetcher=fetch) {
  if(config.channel==='sms') return smsAdapter(config,fetcher);
  const request=async (url,init)=>{
    let response;try{response=await fetcher(url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),...init});}catch{throw new NotificationError('DELIVERY_OUTCOME_UNKNOWN');}
    if(!response.ok) throw new NotificationError(response.status===429?'PROVIDER_RATE_LIMIT':'CHANNEL_REJECTED',[400,401,403,404,422,429].includes(response.status));
    try{return await response.json();}catch{throw new NotificationError('DELIVERY_OUTCOME_UNKNOWN');}
  };
  if(config.channel==='email') return {
    async send(row,body){
      const result=await request('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','Idempotency-Key':`owner/${row.id}`},body:JSON.stringify({from:config.sender,to:[row.recipient],subject:row.title,text:body})});
      if(typeof result.id!=='string' || !result.id) throw new NotificationError('DELIVERY_OUTCOME_UNKNOWN');
      return {id:result.id,state:'accepted'};
    },
    async fetch(row){
      const result=await request(`https://api.resend.com/emails/${encodeURIComponent(row.provider_id)}`,{method:'GET',headers:{Authorization:`Bearer ${config.token}`}});
      if(result.id!==row.provider_id || !result.to?.includes(row.recipient) || result.from!==row.sender) throw new NotificationError('DELIVERY_SCOPE_MISMATCH');
      return {id:result.id,state:result.last_event==='delivered'?'delivered':['bounced','failed','suppressed'].includes(result.last_event)?'undelivered':'accepted'};
    },
  };
  const verify=(result,row)=>{
    if(!/^SM[a-f0-9]{32}$/i.test(result.sid || '') || result.account_sid!==config.account || result.to!==row.recipient || result.from!==row.sender || (row.provider_id && result.sid!==row.provider_id)) throw new NotificationError('DELIVERY_SCOPE_MISMATCH');
    if(!['accepted','queued','sending','sent','delivered','read','failed','undelivered','canceled'].includes(result.status)) throw new NotificationError('DELIVERY_STATUS_UNKNOWN');
    return {id:result.sid,state:['delivered','read'].includes(result.status)?'delivered':['failed','undelivered','canceled'].includes(result.status)?'undelivered':'accepted'};
  };
  const headers={Authorization:`Basic ${Buffer.from(config.account+':'+config.token).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'};
  return {
    async send(row){return verify(await request(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages.json`,{method:'POST',headers,body:new URLSearchParams({To:row.recipient,From:config.sender,ContentSid:config.contentSid,ContentVariables:JSON.stringify(row.variables)})}),row);},
    async fetch(row){if(!/^SM[a-f0-9]{32}$/i.test(row.provider_id || '')) throw new NotificationError('INVALID_MESSAGE_ID');return verify(await request(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages/${row.provider_id}.json`,{method:'GET',headers}),row);},
  };
}
