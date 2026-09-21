import Joi from 'joi';

/**
 * SERVER-ONLY env validation, run once at boot.
 *
 * This is the boundary between Joi and Zod in this codebase:
 *
 *   Joi  →  server-only config that never reaches a browser (this file).
 *   Zod  →  anything crossing the network or touching the client:
 *           forms, Server Actions, route handler bodies, webhook payloads.
 *
 * Never validate the same shape in both. Two schemas for one thing drift,
 * and the one that drifts is always the one guarding the money.
 *
 * Joi is ~145KB and Node-only, so it must never be imported from a Client
 * Component. If you find yourself wanting Joi on the client, use Zod.
 */
const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),

  NEXT_PUBLIC_SITE_URL: Joi.string().uri().required(),

  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).optional(),

  /**
   * Signs the session JWT and peppers the OTP hash. 32 bytes minimum.
   * Rotating it invalidates every session and every outstanding OTP, which
   * is exactly what you want after a suspected leak.
   */
  SESSION_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'SESSION_SECRET must be at least 32 chars — generate with: openssl rand -base64 32',
    'any.required': 'SESSION_SECRET is missing — generate with: openssl rand -base64 32',
  }),

  /**
   * Dev convenience: accept 123456 as any OTP so building the login flow
   * does not require a paid SMS gateway or DLT registration.
   *
   * This is a TOTAL AUTHENTICATION BYPASS. With it on, anyone can sign in as
   * any email or phone on the platform. Declining to *use* it in production
   * is not enough — a deploy with NODE_ENV unset would enable it silently and
   * nothing would look broken. So Joi refuses the whole config, and the
   * process dies at boot: loud, immediate, impossible to miss.
   */
  DEV_OTP_BYPASS: Joi.boolean().default(false).when('NODE_ENV', {
    is: 'production',
    then: Joi.valid(false).messages({
      'any.only': 'DEV_OTP_BYPASS must be false in production — refusing to start.',
    }),
  }),

  /**
   * Cloudinary — KYC document storage. All three are needed together, so if
   * one is present they all are: a half-configured uploader fails at the worst
   * possible moment, mid-onboarding, with a stack trace.
   */
  CLOUDINARY_CLOUD_NAME: Joi.string().allow('').optional(),
  CLOUDINARY_API_KEY: Joi.string().allow('').optional()
    .when('CLOUDINARY_CLOUD_NAME', {
      is: Joi.string().min(1),
      then: Joi.string().min(1).required().messages({
        'any.required': 'CLOUDINARY_API_KEY is required when CLOUDINARY_CLOUD_NAME is set',
      }),
    }),
  CLOUDINARY_API_SECRET: Joi.string().allow('').optional()
    .when('CLOUDINARY_CLOUD_NAME', {
      is: Joi.string().min(1),
      then: Joi.string().min(1).required().messages({
        'any.required': 'CLOUDINARY_API_SECRET is required when CLOUDINARY_CLOUD_NAME is set',
      }),
    }),

  RAZORPAY_TEST_KEY_ID: Joi.string().pattern(/^rzp_test_[A-Za-z0-9]+$/).allow('').optional(),
  RAZORPAY_TEST_KEY_SECRET: Joi.string().allow('').optional(),
  RAZORPAY_TEST_WEBHOOK_SECRET: Joi.string().allow('').optional(),

  WHATSAPP_API_TOKEN: Joi.string().allow('').optional(),
  WHATSAPP_PHONE_ID: Joi.string().allow('').optional(),
  NEXT_PUBLIC_WHATSAPP_NUMBER: Joi.string().pattern(/^\d{10,15}$/).allow('').optional(),
})
  .unknown(true)
  .required();

let cached;

export function getEnv() {
  if (cached) return cached;

  const { value, error } = envSchema.validate(process.env, {
    abortEarly: false,
    stripUnknown: false,
  });

  if (error) {
    const details = error.details.map((d) => `  · ${d.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cached = value;
  return cached;
}

/**
 * Whether the dev OTP bypass is live. Deliberately a function, not a module
 * constant: a constant would be evaluated at import time, which can happen
 * before env validation has run.
 */
export function isOtpBypassEnabled() {
  const env = getEnv();
  return env.NODE_ENV !== 'production' && env.DEV_OTP_BYPASS === true;
}
