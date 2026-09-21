import { z } from 'zod';

/**
 * Auth boundary schemas. Zod, not Joi — these validate input that arrives
 * from a browser, which is the whole reason the boundary rule exists.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(5, 'Enter your email address')
  .max(254)
  .email('That does not look like an email address');

export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => {
    const d = v.replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) return d.slice(2);
    if (d.length === 11 && d.startsWith('0')) return d.slice(1);
    return d;
  })
  .refine((d) => /^[6-9]\d{9}$/.test(d), 'Enter a 10-digit Indian mobile number');

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const requestEmailOtpSchema = z.object({
  email: emailSchema,
});

export const verifyEmailOtpSchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
});

export const requestPhoneOtpSchema = z.object({
  phone: phoneSchema,
});

export const verifyPhoneOtpSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
});
