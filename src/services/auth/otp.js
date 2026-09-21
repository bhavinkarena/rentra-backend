import 'server-only';

import crypto from 'node:crypto';
import { and, desc, eq, gt, isNull, sql as raw } from 'drizzle-orm';
import { db } from '@/services/db';
import { otpToken } from '@/services/db/schema/index.js';
import { getEnv, isOtpBypassEnabled } from '@/services/schemas/joi/env';

/**
 * One-time codes: generate, deliver, verify.
 *
 * Rules (docs/rentra-role-flow.html §Stage 1):
 *   · 6 digits, valid 10 minutes
 *   · max 5 verification attempts per code
 *   · resend after 60 seconds, max 3 per hour per identifier+purpose
 *
 * Only the HMAC of the code is stored, so a database leak cannot be replayed
 * into logins. Comparison is constant-time.
 */

export const DEV_CODE = '123456';

const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_PER_HOUR = 3;

/** Cryptographically uniform 6 digits — not Math.random(). */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code) {
  return crypto
    .createHmac('sha256', getEnv().SESSION_SECRET)
    .update(code)
    .digest('hex');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function normaliseEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function normalisePhone(value) {
  // Strip spaces, dashes, and a +91 / 0 prefix down to the bare 10 digits.
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * @param {object} input
 * @param {boolean} [input.__returnCodeForTests]
 *   TEST-ONLY. Returns the plaintext code so verification scripts can exercise
 *   the real verify path. **No Server Action ever passes this** — the code must
 *   never cross the network, not even in development, or it stops being a code.
 *   Developers read it from the terminal.
 * @returns {Promise<{ok: true, cooldownMs: number, code?: string}
 *                 | {ok: false, reason: 'cooldown'|'hourly_limit', retryInMs: number}>}
 */
export async function issueOtp({ identifier, channel, purpose, ip, __returnCodeForTests }) {
  const now = Date.now();

  const [latest] = await db
    .select({ createdAt: otpToken.createdAt })
    .from(otpToken)
    .where(and(eq(otpToken.identifier, identifier), eq(otpToken.purpose, purpose)))
    .orderBy(desc(otpToken.createdAt))
    .limit(1);

  if (latest) {
    const since = now - new Date(latest.createdAt).getTime();
    if (since < RESEND_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown', retryInMs: RESEND_COOLDOWN_MS - since };
    }
  }

  const [{ n } = { n: 0 }] = await db
    .select({ n: raw`count(*)::int`.as('n') })
    .from(otpToken)
    .where(and(
      eq(otpToken.identifier, identifier),
      eq(otpToken.purpose, purpose),
      gt(otpToken.createdAt, new Date(now - 60 * 60 * 1000)),
    ));

  if (n >= MAX_PER_HOUR) {
    return { ok: false, reason: 'hourly_limit', retryInMs: 60 * 60 * 1000 };
  }

  const code = generateCode();

  await db.insert(otpToken).values({
    identifier,
    channel,
    purpose,
    codeHash: hashCode(code),
    expiresAt: new Date(now + TTL_MS),
    requestIp: ip ?? null,
  });

  await deliverOtp({ identifier, channel, code });

  return {
    ok: true,
    cooldownMs: RESEND_COOLDOWN_MS,
    // Only ever populated for verification scripts. Never for a browser.
    code: __returnCodeForTests ? code : undefined,
  };
}

/**
 * Delivery. In development nothing is sent and nothing is billed — the code
 * is printed to the terminal instead.
 *
 * That matters: the real generate → hash → store → expire → verify path still
 * runs on every dev login, so it is exercised continuously rather than being
 * skipped and found broken on the day the gateway is switched on.
 *
 * TODO(step 2): wire an email provider, and MSG91/Gupshup for SMS once TRAI
 * DLT registration clears. Start that registration early — it is a lead-time
 * dependency measured in weeks, not a billing decision.
 */
async function deliverOtp({ identifier, channel, code }) {
  if (getEnv().NODE_ENV !== 'production') {
    console.info(
      `\n  ┌─ OTP ─────────────────────────────────────────\n`
      + `  │  ${channel.toUpperCase()} → ${identifier}\n`
      + `  │  code: ${code}   (or use ${DEV_CODE} in dev)\n`
      + `  └───────────────────────────────────────────────\n`,
    );
    return;
  }
  throw new Error(`No ${channel} provider configured — cannot deliver OTP in production`);
}

/**
 * @returns {Promise<{ok: true, viaBypass: boolean}
 *                 | {ok: false, reason: 'no_code'|'expired'|'too_many_attempts'|'wrong_code'}>}
 */
export async function verifyOtp({ identifier, purpose, code }) {
  const submitted = String(code ?? '').trim();

  // Layer 2 of the bypass guard: both conditions, checked at call time.
  // Layer 1 is the opt-in env var; layer 3 is Joi refusing to boot in prod.
  if (isOtpBypassEnabled() && submitted === DEV_CODE) {
    console.warn('[otp] DEV BYPASS used for %s (%s)', identifier, purpose);
    return { ok: true, viaBypass: true };
  }

  const [token] = await db
    .select()
    .from(otpToken)
    .where(and(
      eq(otpToken.identifier, identifier),
      eq(otpToken.purpose, purpose),
      isNull(otpToken.consumedAt),
    ))
    .orderBy(desc(otpToken.createdAt))
    .limit(1);

  if (!token) return { ok: false, reason: 'no_code' };
  if (new Date(token.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (token.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (!timingSafeEqualHex(hashCode(submitted), token.codeHash)) {
    await db
      .update(otpToken)
      .set({ attempts: token.attempts + 1 })
      .where(eq(otpToken.id, token.id));
    return { ok: false, reason: 'wrong_code' };
  }

  // Single-use: consume before returning, so a replayed submit fails.
  await db
    .update(otpToken)
    .set({ consumedAt: new Date() })
    .where(eq(otpToken.id, token.id));

  return { ok: true, viaBypass: false };
}

export const OTP_RULES = {
  ttlMs: TTL_MS,
  maxAttempts: MAX_ATTEMPTS,
  resendCooldownMs: RESEND_COOLDOWN_MS,
  maxPerHour: MAX_PER_HOUR,
};
