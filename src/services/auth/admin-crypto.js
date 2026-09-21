import crypto from 'node:crypto';
import {
  generateSecret as otpGenerateSecret,
  generateSync as otpGenerate,
  verifySync as otpVerify,
  generateURI as otpUri,
  NobleCryptoPlugin,
  ScureBase32Plugin,
} from 'otplib';

/**
 * Admin credential primitives. No Next.js dependency, so this is testable in
 * plain node — same split as session-crypto.js.
 *
 * Passwords use node's built-in scrypt: memory-hard, in core, and no native
 * build step (argon2 needs a compiler, which on Windows is a fight nobody
 * needs). Parameters are stored alongside the hash so they can be raised
 * later without invalidating existing passwords.
 */

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };

/**
 * scrypt's working set is roughly 128 * N * r bytes — 33.5MB at these
 * parameters, which exceeds node's default `maxmem` of 32MB and throws
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Raise the ceiling rather than weakening
 * N: memory hardness is the entire point of choosing scrypt.
 *
 * Derived from the stored params, not hardcoded, so verifying a hash written
 * under different parameters still works.
 */
function maxmemFor(N, r) {
  return Math.max(32 * 1024 * 1024, 128 * N * r * 2);
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: maxmemFor(SCRYPT.N, SCRYPT.r),
  });
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64'),
  ].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: maxmemFor(Number(N), Number(r)),
    });

    // Constant-time. Lengths are equal by construction.
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* --------------------------------- TOTP --------------------------------- */

/**
 * otplib 13 is plugin-based: the crypto and base32 implementations are passed
 * in rather than bundled. Instantiate them once here.
 */
const plugins = {
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
};

export function generateTotpSecret() {
  return otpGenerateSecret();
}

/** The URI to paste into an authenticator app, or render as a QR. */
export function totpUri({ email, secret }) {
  return otpUri({ secret, label: email, issuer: 'Rentra' });
}

/** Current token — used by tests, never in the request path. */
export function currentTotp(secret) {
  return otpGenerate({ secret, ...plugins });
}

export function verifyTotp({ secret, token }) {
  const code = String(token ?? '').trim();
  if (!secret || !/^\d{6}$/.test(code)) return false;
  try {
    // Returns { valid, delta, ... } — NOT a boolean. Reading it as truthy
    // would accept every wrong code, so unwrap `.valid` explicitly.
    const result = otpVerify({ secret, token: code, ...plugins });
    return result?.valid === true;
  } catch {
    return false;
  }
}

/** Generated once by the seed script, shown once, never stored in plaintext. */
export function generateStrongPassword() {
  // Ambiguous characters removed — this gets read off a terminal and retyped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(
    { length: 20 },
    () => alphabet[crypto.randomInt(0, alphabet.length)],
  ).join('');
}

export const LOCKOUT = {
  maxAttempts: 5,
  lockMinutes: 15,
};
