/**
 * Every seed writes demo data, and some truncate catalogue tables first. They
 * must never reach a hosted database by accident, so this is the one place a
 * seed gets its connection string.
 *
 * - DATABASE_URL is required; there is no fallback URL.
 * - NODE_ENV=production always refuses.
 * - A non-local host is allowed only when SEED_ALLOW_HOST names that exact
 *   host, so the operator has to type the target they mean.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function seedDatabaseUrl(script, env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) throw new Error(`[${script}] DATABASE_URL is not set.`);
  if (env.NODE_ENV === 'production')
    throw new Error(`[${script}] refusing to seed with NODE_ENV=production.`);
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`[${script}] DATABASE_URL is not a valid URL.`);
  }
  if (!LOCAL_HOSTS.has(host) && env.SEED_ALLOW_HOST !== host) {
    throw new Error(
      `[${script}] refusing to seed remote host ${host}. Set SEED_ALLOW_HOST=${host} if you really mean it.`,
    );
  }
  return url;
}
