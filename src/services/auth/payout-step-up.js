import 'server-only';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { badRequest, forbidden } from '@/utils/apiError.js';
import { deliverPortalCode } from './portal-delivery.js';
import { RECENT_AUTH_MINUTES } from './recent-auth.js';
const uuid=z.string().uuid();
const hash=(env,id,actor,identifier,code)=>createHmac('sha256',env.SESSION_SECRET).update(JSON.stringify(['payout_confirm',id,actor.id,actor.sessionId,identifier,code])).digest('hex');
async function lockedOwner(tx,actor) {
  if (actor?.kind!=='owner' || !uuid.safeParse(actor.id).success || !uuid.safeParse(actor.sessionId).success) throw forbidden();
  const [owner]=await tx`SELECT id,email,email_verified_at,phone,phone_verified_at FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR UPDATE`;
  const [session]=await tx`SELECT id FROM auth_session WHERE id=${actor.sessionId} AND user_id=${actor.id} AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`;
  if (!owner || !session) throw forbidden();
  return owner;
}
function recipient(owner) {
  if (owner.email && owner.email_verified_at) return {identifier:owner.email.toLowerCase(),channel:'email',masked:owner.email.replace(/^(.{1,2})[^@]*(@.*)$/,'$1•••$2')};
  if (owner.phone && owner.phone_verified_at) return {identifier:owner.phone,channel:'sms',masked:`••••••${owner.phone.slice(-4)}`};
  throw badRequest('CONTACT_UNVERIFIED','Verify your email or phone before confirming a payout change.');
}
export async function requestPayoutStepUp(database,actor,env=process.env,send=deliverPortalCode) {
  const code=env.NODE_ENV!=='production' && ['true',true].includes(env.DEV_OTP_BYPASS) ? '123456' : String(randomInt(1000000)).padStart(6,'0');
  const result=await database.begin(async tx=> {
    const owner=await lockedOwner(tx,actor),contact=recipient(owner);
    const [quota]=await tx`SELECT count(*)::int count,max(created_at) latest FROM otp_challenge WHERE user_id=${actor.id} AND purpose='payout_confirm' AND created_at>clock_timestamp()-interval '1 hour'`;
    if (quota.count>=3) return {error:'You have requested several codes. Try again in an hour.',code:'OTP_LIMIT'};
    if (quota.latest && Date.now()-new Date(quota.latest).getTime()<60000) return {error:'Wait a minute before requesting another code.',code:'OTP_COOLDOWN'};
    const id=randomUUID();
    await tx`INSERT INTO otp_challenge(id,principal_kind,channel,purpose,identifier,code_hash,delivery_mode,user_id,session_id,expires_at)
      VALUES (${id},'client',${contact.channel},'payout_confirm',${contact.identifier},${hash(env,id,actor,contact.identifier,code)},${env.NODE_ENV==='production'?'provider':'development'},${actor.id},${actor.sessionId},clock_timestamp()+interval '10 minutes')`;
    return {id,...contact};
  });
  if (result.error) return result;
  try {
    await send({identifier:result.identifier,channel:result.channel,code,purpose:'payout_confirm'},env);
    const rows=await database`UPDATE otp_challenge SET delivered=true WHERE id=${result.id} AND session_id=${actor.sessionId} RETURNING id`;
    if (!rows.length) return {error:'The code could not be prepared. Please try again.'};
  } catch {
    await database`DELETE FROM otp_challenge WHERE id=${result.id} AND delivered=false`;
    return {error:'We could not send the code just now. Please try again.',code:'OTP_DELIVERY_FAILED'};
  }
  return {challengeId:result.id,masked:result.masked,channel:result.channel,minutes:RECENT_AUTH_MINUTES,message:`Code sent to ${result.masked}. It expires in 10 minutes.`};
}
export async function confirmPayoutStepUp(database,actor,input,env=process.env) {
  const value=z.object({challengeId:uuid,code:z.string().regex(/^\d{6}$/)}).safeParse(input);
  if (!value.success) return {error:'Enter the six-digit code we sent.',code:'INVALID_CODE'};
  return database.begin(async tx=> {
    const owner=await lockedOwner(tx,actor),contact=recipient(owner);
    const [challenge]=await tx`SELECT *,expires_at>clock_timestamp() valid FROM otp_challenge WHERE id=${value.data.challengeId} AND user_id=${actor.id} AND session_id=${actor.sessionId} AND purpose='payout_confirm' AND delivered=true FOR UPDATE`;
    if (!challenge || challenge.consumed_at || !challenge.valid || challenge.attempts>=5 || challenge.identifier!==contact.identifier) return {error:'This code is no longer valid. Request a new code.',code:'CODE_EXPIRED'};
    const expected=Buffer.from(challenge.code_hash,'hex'), supplied=Buffer.from(hash(env,challenge.id,actor,challenge.identifier,value.data.code),'hex');
    if (!timingSafeEqual(expected,supplied)) {
      await tx`UPDATE otp_challenge SET attempts=attempts+1 WHERE id=${challenge.id}`;
      return {error:'That code did not match. Please try again.',code:'WRONG_CODE'};
    }
    await tx`UPDATE otp_challenge SET consumed_at=clock_timestamp() WHERE id=${challenge.id}`;
    await tx`UPDATE auth_session SET reauthenticated_at=clock_timestamp() WHERE id=${actor.sessionId} AND user_id=${actor.id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES ('client',${actor.id},'portal_session',${actor.sessionId},'payout_identity_confirmed')`;
    return {confirmed:true,minutes:RECENT_AUTH_MINUTES,message:'Identity confirmed. You can now submit your payout method.'};
  });
}
