import 'server-only';
import {createHmac,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {forbidden,badRequest,conflict} from '@/utils/apiError.js';
import {deliverPortalCode} from './portal-delivery.js';
const uuid=z.string().uuid();
export function deviceLabel(agent='') {
 const browser=/Edg\//.test(agent)?'Edge':/Firefox\//.test(agent)?'Firefox':/Chrome\//.test(agent)?'Chrome':/Safari\//.test(agent)?'Safari':'Browser';
 const device=/iPhone|iPad/.test(agent)?'iOS':/Android/.test(agent)?'Android':/Macintosh/.test(agent)?'Mac':/Windows/.test(agent)?'Windows':/Linux/.test(agent)?'Linux':null;
 return device?`${browser} on ${device}`:`${browser} session`;
}
export async function lockOwnerSecurity(tx,actor) {
 if(!uuid.safeParse(actor?.id).success || !uuid.safeParse(actor?.sessionId).success)throw forbidden();
 const [owner]=await tx`SELECT * FROM "user" WHERE id=${actor.id} AND role='client' AND account_status IN ('active','pending_application') FOR UPDATE`;
 const [session]=await tx`SELECT id,device_label FROM auth_session WHERE id=${actor.sessionId} AND user_id=${actor.id} AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`;
 if(!owner||!session)throw forbidden();return {owner,session};
}
const hash=(env,id,actor,purpose,identifier,code)=>createHmac('sha256',env.SESSION_SECRET).update(JSON.stringify([purpose,id,actor.id,actor.sessionId,identifier,code])).digest('hex');
export async function ownerSecurityPage(database,actor){return database.begin(async tx=>{
 const {owner}=await lockOwnerSecurity(tx,actor);
 const sessions=await tx`SELECT id,device_label,last_seen_at,created_at FROM auth_session WHERE user_id=${actor.id} AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC,id`;
 return {email:owner.email,phone:owner.phone,sessions:sessions.map(s=>({id:s.id,device:s.device_label,current:s.id===actor.sessionId,lastSeen:new Date(s.last_seen_at).toISOString(),createdAt:new Date(s.created_at).toISOString()}))};
});}
export async function signOutOtherOwnerSessions(database,actor){return database.begin(async tx=>{
 await lockOwnerSecurity(tx,actor);
 const rows=await tx`UPDATE auth_session SET revoked_at=now() WHERE user_id=${actor.id} AND id<>${actor.sessionId} AND revoked_at IS NULL RETURNING id`;
 await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES('client',${actor.id},'user',${actor.id},'other_sessions_revoked',${JSON.stringify({count:rows.length})}::text::jsonb)`;
 return {message:`Signed out ${rows.length} other session${rows.length===1?'':'s'}.`};
});}
export async function requestOwnerContactChange(database,actor,input,env=process.env,send=deliverPortalCode){
 const parsed=z.object({channel:z.enum(['email','sms']),identifier:z.string().trim().max(160)}).strict().safeParse(input);
 if(!parsed.success)throw badRequest('INVALID_CONTACT','Enter a valid email address or Indian mobile number.');
 const {channel}=parsed.data;const identifier=channel==='email'?parsed.data.identifier.toLowerCase():parsed.data.identifier.replace(/\s+/g,'');
 if(!(channel==='email'?z.email().safeParse(identifier).success:/^\+91[6-9]\d{9}$/.test(identifier)))throw badRequest('INVALID_CONTACT',channel==='email'?'Enter a valid email address.':'Use +91 followed by your 10-digit mobile number.');
 const purpose=channel==='email'?'owner_email_change':'owner_phone_change';const code=env.NODE_ENV!=='production'&&['true',true].includes(env.DEV_OTP_BYPASS)?'123456':String(randomInt(1000000)).padStart(6,'0');
 const result=await database.begin(async tx=>{
  const {owner}=await lockOwnerSecurity(tx,actor);
  if(identifier===(channel==='email'?owner.email:'+91'+(owner.phone || '')))throw badRequest('CONTACT_UNCHANGED','Enter your new contact detail.');
  const [used]=channel==='email'?await tx`SELECT id FROM "user" WHERE lower(email)=${identifier} AND role='client' AND id<>${actor.id}`:await tx`SELECT id FROM "user" WHERE phone=${identifier.slice(3)} AND role='client' AND id<>${actor.id}`;
  if(used)throw conflict('CONTACT_IN_USE','This contact detail is already in use. Contact support if it belongs to you.');
  const [quota]=await tx`SELECT count(*)::int n,max(created_at) latest FROM otp_challenge WHERE user_id=${actor.id} AND purpose=${purpose} AND created_at>now()-interval '1 hour'`;
  if(quota.n>=3)throw badRequest('OTP_LIMIT','Try again in an hour.');
  if(quota.latest&&Date.now()-new Date(quota.latest).getTime()<60000)throw badRequest('OTP_COOLDOWN','Wait a minute before requesting another code.');
  const id=randomUUID();
  await tx`INSERT INTO otp_challenge(id,principal_kind,channel,purpose,identifier,code_hash,delivery_mode,user_id,session_id,expires_at) VALUES(${id},'client',${channel},${purpose},${identifier},${hash(env,id,actor,purpose,identifier,code)},${env.NODE_ENV==='production'?'provider':'development'},${actor.id},${actor.sessionId},now()+interval '10 minutes')`;
  return {id};
 });
 try{await send({identifier,channel,code,purpose},env);await database`UPDATE otp_challenge SET delivered=true WHERE id=${result.id}`;}catch{await database`DELETE FROM otp_challenge WHERE id=${result.id} AND NOT delivered`;throw badRequest('OTP_DELIVERY_FAILED','Could not send the code. Nothing was changed. Try again.');}
 return {challengeId:result.id,message:'A code was sent to your new contact detail. It expires in 10 minutes.'};
}
export async function confirmOwnerContactChange(database,actor,input,env=process.env){
 const parsed=z.object({challengeId:uuid,code:z.string().regex(/^\d{6}$/)}).strict().safeParse(input);
 if(!parsed.success)return {error:'Enter the six-digit code.',code:'INVALID_CODE'};
 try{return await database.begin(async tx=>{
  const {owner,session}=await lockOwnerSecurity(tx,actor);
  const [challenge]=await tx`SELECT *,expires_at>now() valid FROM otp_challenge WHERE id=${parsed.data.challengeId} AND user_id=${actor.id} AND session_id=${actor.sessionId} AND principal_kind='client' AND purpose IN ('owner_email_change','owner_phone_change') AND delivered FOR UPDATE`;
  if(!challenge||challenge.consumed_at||!challenge.valid||challenge.attempts>=5)return {error:'This code expired. Request another.',code:'CODE_EXPIRED'};
  if(!timingSafeEqual(Buffer.from(challenge.code_hash,'hex'),Buffer.from(hash(env,challenge.id,actor,challenge.purpose,challenge.identifier,parsed.data.code),'hex'))){await tx`UPDATE otp_challenge SET attempts=attempts+1 WHERE id=${challenge.id}`;return {error:'That code did not match.',code:'WRONG_CODE'};}
  await tx`UPDATE otp_challenge SET consumed_at=now() WHERE id=${challenge.id}`;
  if(challenge.purpose==='owner_email_change')await tx`UPDATE "user" SET email=${challenge.identifier},email_verified_at=now(),profile_version=profile_version+1,updated_at=now() WHERE id=${actor.id}`;
  else await tx`UPDATE "user" SET phone=${challenge.identifier.slice(3)},phone_verified_at=now(),profile_version=profile_version+1,updated_at=now() WHERE id=${actor.id}`;
  await tx`UPDATE auth_session SET revoked_at=now() WHERE user_id=${actor.id} AND revoked_at IS NULL`;
  // Create the replacement in this transaction: contact change and fresh session commit together.
  const [fresh]=await tx`INSERT INTO auth_session(user_id,device_label,reauthenticated_at,expires_at) VALUES(${actor.id},${session.device_label},now(),now()+interval '30 days') RETURNING id`;
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES('client',${actor.id},'user',${actor.id},${challenge.purpose})`;
  return {sessionId:fresh.id,accountStatus:owner.account_status,message:'Contact detail verified and saved. Your other sessions were signed out.'};
 });}catch(error){if(error.code==='23505')throw conflict('CONTACT_IN_USE','This contact detail is already in use. Nothing was changed.');throw error;}
}
