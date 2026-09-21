import rateLimit from 'express-rate-limit';
import { config } from '@/config/env.js';
import { fail } from '@/utils/respond.js';

/**
 * Rate limits, in front of the expensive and the abusable.
 *
 * The OTP limiter matters most: without it this API is a free SMS pump and an
 * account-enumeration oracle. The service layer already counts OTP issues per
 * identifier, which is the correct grain for "stop spamming this phone"; this
 * adds the complementary per-IP grain, which is what stops one caller walking
 * a list of numbers.
 *
 * The key is the trusted client IP, so TRUST_PROXY_HOPS must reflect reality —
 * see the note on it in src/config/env.js.
 */
const handler = (_req, res) =>
  fail(res, {
    status: 429,
    code: 'RATE_LIMITED',
    message: 'Too many requests. Wait a moment and try again.',
  });

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
};

/** Broad backstop for the whole API. Generous; it is not the real defence. */
export const generalLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 300,
  skip: () => !config().isProduction,
});

/** OTP request and verify. Deliberately tight. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60_000,
  limit: 20,
});

/** Admin login — brute force against the account that releases payouts. */
export const adminLoginLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 10,
});

/** Cloudinary costs money per upload and each one is a 2MB body. */
export const uploadLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60_000,
  limit: 40,
});

/** Checkout holds take inventory out of circulation while they live. */
export const checkoutLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 30,
});
