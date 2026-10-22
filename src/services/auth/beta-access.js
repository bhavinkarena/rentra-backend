import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
// No database imports here: guest reads (quotes, discovery) import this module, and it must never
// open a connection of its own at import time.
import { getContext } from '@/runtime/context.js';

/**
 * Closed beta (hotel plan, Phase 9). A vertical in 'partners' stays invisible to
 * guests, except to customers an admin invited by phone. An invited customer
 * opens their invite link once and receives a signed beta pass; the frontend
 * sends it as `X-Rentra-Beta` on discovery and checkout calls, and every guest
 * read accepts the vertical for that request only. Sitemaps, landing counts and
 * indexing never include beta verticals. Revoking an invite ends access when
 * the pass expires (7 days at most).
 */
export const BETA_HEADER = 'x-rentra-beta';
const PASS_DAYS = 7;
const code = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

function secret(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('Session secret is not configured.');
  return env.SESSION_SECRET;
}
const sign = (body, env) => createHmac('sha256', secret(env)).update(`beta:${body}`).digest('base64url');

/** `verticals.expiresMs.signature`; verticals joined with '+'. */
export function issueBetaPass(verticals, env = process.env, now = Date.now()) {
  const expires = now + PASS_DAYS * 86_400_000;
  const body = `${verticals.join('+')}.${expires}`;
  return { token: `${body}.${sign(body, env)}`, expiresAt: new Date(expires).toISOString(), verticals };
}

/** The verticals a pass opens, or [] when it is missing, expired or forged. */
export function readBetaPass(token, env = process.env, now = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[1]) || Number(parts[1]) <= now) return [];
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, env));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return [];
  return parts[0].split('+').filter((value) => code.safeParse(value).success);
}

/** Beta verticals for the request being served (none outside a request). */
export function betaVerticals() {
  const ctx = getContext();
  if (!ctx.req) return [];
  if (!ctx.memo.has('betaVerticals')) ctx.memo.set('betaVerticals', readBetaPass(ctx.req.get?.(BETA_HEADER)));
  return ctx.memo.get('betaVerticals');
}

/**
 * SQL condition: vertical row `alias` is visible to this request's guest —
 * public, or in partners and opened by the request's beta pass.
 */
export function visibleVertical(sql, alias = 'v') {
  const beta = betaVerticals();
  return sql`(${sql(`${alias}.status`)} = 'public' OR (${sql(`${alias}.status`)} = 'partners' AND ${sql(`${alias}.code`)} = ANY(${beta}::text[])))`;
}

