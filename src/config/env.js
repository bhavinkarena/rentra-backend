import Joi from 'joi';
import { getEnv, isOtpBypassEnabled } from '@/services/schemas/joi/env';

/**
 * Environment validation, in two layers.
 *
 * The shared layer is `src/services/schemas/joi/env.js` — ported verbatim from
 * the Next app and NOT edited here, so the two codebases keep agreeing about
 * what DATABASE_URL, SESSION_SECRET and the Razorpay keys must look like. Edit
 * it in one place and copy, never fork it.
 *
 * This file adds only what a standalone HTTP server needs and the Next app has
 * no concept of: a port to bind, cookie policy, and the trusted-proxy depth.
 */
const serverSchema = Joi.object({
  PORT: Joi.number().port().default(4000),

  /**
   * How many reverse proxies sit in front of this process. Express uses it to
   * decide which X-Forwarded-For entry is the real client. Set it to the
   * actual hop count — `true` would let any caller spoof their own IP and walk
   * straight through the OTP rate limiter.
   */
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),

  API_PREFIX: Joi.string()
    .pattern(/^\/[a-z0-9/-]*$/)
    .default('/api/v1'),

  /** Cross-site cookies need SameSite=None, which browsers only accept with Secure. */
  COOKIE_SAME_SITE: Joi.string().valid('lax', 'strict', 'none').default('lax'),
  COOKIE_DOMAIN: Joi.string().allow('').default(''),

  REQUEST_BODY_LIMIT: Joi.string().default('1mb'),
  LOG_FORMAT: Joi.string().valid('dev', 'combined', 'tiny', 'off').default('dev'),
}).unknown(true);

let cached;

export function config() {
  if (cached) return cached;

  const shared = getEnv();
  const { value, error } = serverSchema.validate(process.env, { abortEarly: false });

  if (error) {
    const details = error.details.map((d) => `  · ${d.message}`).join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }

  cached = {
    ...shared,
    ...value,
    isProduction: shared.NODE_ENV === 'production',
  };
  return cached;
}

export { getEnv, isOtpBypassEnabled };
