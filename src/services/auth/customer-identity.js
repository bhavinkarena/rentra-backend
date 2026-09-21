import 'server-only';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { customerDeliveryConfig, deliverCustomerCode } from './customer-delivery.js';
import { lockCustomerAccount } from './customer-access.js';

export const customerPhone = z.string().trim().regex(/^(?:\+91[ -]?|0)?[6-9][0-9 -]{9,13}$/)
  .transform((value) => value.replace(/[ -]/g, '').replace(/^(?:\+91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/));
const uuid = z.string().uuid();
export function authHash(value, env = process.env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('Session secret is not configured.');
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('hex');
}
export function customerRequestIp(headers, env = process.env) {
  // Only trust a single-IP header that the deployment proxy overwrites.
  const header = env.CUSTOMER_AUTH_IP_HEADER;
  const value = header ? headers.get(header)?.trim() : null;
  return value && isIP(value) ? value : 'unknown';
}
const failure = (error = 'The code is invalid or expired. Request a new code if needed.') => ({ error });
async function rate(tx, phone, ip, kind, env) {
  const phoneHash = authHash(`phone:${phone}`, env), ipHash = authHash(`ip:${ip}`, env);
  for (const key of [`customer-phone:${phoneHash}`, `customer-ip:${ipHash}`].sort()) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
  const [counts] = await tx`SELECT
    count(*) FILTER (WHERE phone_hash=${phoneHash})::int AS phone,
    count(*) FILTER (WHERE ip_hash=${ipHash})::int AS ip,
    count(*) FILTER (WHERE phone_hash=${phoneHash} AND created_at > now()-interval '60 seconds')::int AS recent
    FROM customer_auth_rate WHERE kind=${kind} AND created_at > now()-interval '1 hour'
    AND (phone_hash=${phoneHash} OR ip_hash=${ipHash})`;
  if (counts.phone >= (kind === 'request' ? 3 : 15) || counts.ip >= (kind === 'request' ? 20 : 60) || (kind === 'request' && counts.recent)) return false;
  await tx`INSERT INTO customer_auth_rate(phone_hash,ip_hash,kind) VALUES (${phoneHash},${ipHash},${kind})`;
  return true;
}

export async function requestCustomerCode(database, { phone: input, browserToken, ip = 'unknown' }, { env = process.env, deliver = deliverCustomerCode, changeSession = null } = {}) {
  const phone = customerPhone.parse(input);
  uuid.parse(browserToken);
  const { mode } = customerDeliveryConfig(env);
  if (mode === 'disabled') return failure('Phone login is temporarily unavailable.');
  const id = randomUUID();
  const code = mode === 'development' ? '123456' : String(randomInt(100000, 1000000));
  const inserted = await database.begin(async (tx) => {
    if (!await rate(tx, phone, ip, 'request', env)) return false;
    const customer = changeSession ? await lockCustomerAccount(tx, changeSession, env) : null;
    if (customer) {
      const [conflict] = await tx`SELECT id FROM "user" WHERE phone=${phone} AND role='customer'`;
      if (conflict || customer.phone === phone) return 'conflict';
    }
    await tx`UPDATE customer_otp_challenge SET consumed_at=now() WHERE phone=${phone} AND consumed_at IS NULL`;
    await tx`INSERT INTO customer_otp_challenge(id,phone,browser_hash,code_hash,delivery_mode,expires_at,purpose,customer_id,session_id,original_phone)
      VALUES (${id},${phone},${authHash(`browser:${browserToken}`, env)},${authHash(`code:${id}:${code}`, env)},${mode},now()+interval '5 minutes',
        ${customer ? 'phone_change' : 'login'},${customer?.id ?? null},${changeSession?.sessionId ?? null},${customer?.phone ?? null})`;
    return true;
  });
  if (!inserted) return failure('Too many requests. Wait a minute before resending; at most 3 codes per hour.');
  if (inserted === 'conflict') return failure('That number cannot be used. Choose a different mobile number.');
  try {
    await deliver(phone, code, env);
    await database`UPDATE customer_otp_challenge SET delivered=true WHERE id=${id} AND consumed_at IS NULL`;
    return { challengeId: id, phone, development: mode === 'development', resendAfter: 60 };
  } catch {
    await database`UPDATE customer_otp_challenge SET consumed_at=now() WHERE id=${id}`;
    return failure('We could not send your code. Please try again later.');
  }
}

export async function verifyCustomerCode(database, { phone: input, challengeId, browserToken, code, ip = 'unknown' }, { env = process.env, changeSession = null } = {}) {
  const phone = customerPhone.parse(input);
  if (!uuid.safeParse(challengeId).success || !uuid.safeParse(browserToken).success || !/^\d{6}$/.test(code ?? '')) return failure();
  const { mode } = customerDeliveryConfig(env);
  if (mode === 'disabled') return failure('Phone login is temporarily unavailable.');
  return database.begin(async (tx) => {
    if (!await rate(tx, phone, ip, 'verify', env)) return failure('Too many attempts. Try again in an hour.');
    const [challenge] = await tx`SELECT *, expires_at > clock_timestamp() AS live FROM customer_otp_challenge WHERE id=${challengeId} AND phone=${phone} FOR UPDATE`;
    if (!challenge || !challenge.live || !challenge.delivered || challenge.consumed_at || challenge.attempts >= 5 || challenge.delivery_mode !== mode || challenge.browser_hash !== authHash(`browser:${browserToken}`, env)) return failure();
    if (challenge.purpose !== (changeSession ? 'phone_change' : 'login')) return failure();
    if (changeSession && (challenge.customer_id !== changeSession.userId || challenge.session_id !== changeSession.sessionId)) return failure();
    const customer = changeSession ? await lockCustomerAccount(tx, changeSession, env) : null;
    if (customer && customer.phone !== challenge.original_phone) return failure('Your phone changed. Request a new code.');
    await tx`UPDATE customer_otp_challenge SET attempts=attempts+1 WHERE id=${challengeId}`;
    const expected = Buffer.from(challenge.code_hash, 'hex');
    if (!timingSafeEqual(expected, Buffer.from(authHash(`code:${challengeId}:${code}`, env), 'hex'))) return failure();
    await tx`UPDATE customer_otp_challenge SET consumed_at=now() WHERE id=${challengeId}`;
    if (customer) {
      const [conflict] = await tx`SELECT id FROM "user" WHERE phone=${phone} AND role='customer'`;
      if (conflict) return failure('That number cannot be used. Choose a different mobile number.');
      await tx`UPDATE "user" SET phone=${phone},phone_verified_at=now(),updated_at=now() WHERE id=${customer.id}`;
      await tx`UPDATE customer_session SET revoked_at=now() WHERE user_id=${customer.id} AND revoked_at IS NULL`;
      const [session] = await tx`INSERT INTO customer_session(user_id,expires_at) VALUES (${customer.id},now()+interval '30 days') RETURNING id`;
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES ('customer',${customer.id},'user',${customer.id},'customer_phone_changed')`;
      return { userId:customer.id,sessionId:session.id,role:'customer',accountStatus:'active',development:mode==='development' };
    }
    await tx`INSERT INTO "user"(phone,role,account_status) VALUES (${phone},'customer','active') ON CONFLICT (phone,role) DO NOTHING`;
    const [user] = await tx`SELECT id,account_status FROM "user" WHERE phone=${phone} AND role='customer' FOR UPDATE`;
    if (user.account_status !== 'active') return failure('Your customer account is unavailable. Contact support.');
    await tx`UPDATE "user" SET phone_verified_at=now(),last_login_at=now(),updated_at=now() WHERE id=${user.id}`;
    const [session] = await tx`INSERT INTO customer_session(user_id,expires_at) VALUES (${user.id},now()+interval '30 days') RETURNING id`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action) VALUES ('customer',${user.id},'user',${user.id},'customer_login')`;
    return { userId: user.id, sessionId: session.id, role: 'customer', accountStatus: 'active', development: mode === 'development' };
  });
}

export async function validCustomerSession(database, session, env = process.env) {
  if (session?.development && !['development', 'test'].includes(env.NODE_ENV)) return false;
  if (session?.role !== 'customer' || !uuid.safeParse(session.sessionId).success || !uuid.safeParse(session.userId).success) return false;
  const [row] = await database`SELECT s.id FROM customer_session s JOIN "user" u ON u.id=s.user_id
    WHERE s.id=${session.sessionId} AND s.user_id=${session.userId} AND s.revoked_at IS NULL
    AND s.expires_at > now() AND u.role='customer' AND u.account_status='active'`;
  return Boolean(row);
}
export async function revokeCustomerSession(database, session) {
  if (session?.role === 'customer' && uuid.safeParse(session.sessionId).success && uuid.safeParse(session.userId).success) {
    await database`UPDATE customer_session SET revoked_at=now() WHERE id=${session.sessionId} AND user_id=${session.userId} AND revoked_at IS NULL`;
  }
}
