import { getContext, requireResponse } from './context.js';

/**
 * `next/headers` shim over the Express request/response in scope.
 *
 * Both functions are async in Next 15+ and the ported code awaits them, so
 * they stay async here even though nothing is deferred.
 */

/**
 * Read-only view of the incoming headers, as a real `Headers` instance so
 * `.get()` behaves identically — case-insensitive, null for absent.
 */
export async function headers() {
  const { req } = getContext();
  const out = new Headers();
  for (const [name, value] of Object.entries(req?.headers ?? {})) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
  }
  return out;
}

/**
 * Next's cookie jar API — `get(name)?.value`, `set(name, value, opts)`,
 * `delete(name)` — backed by cookie-parser on the way in and `res.cookie` on
 * the way out.
 *
 * Writes are also mirrored into a per-request override map so a cookie set or
 * deleted earlier in the request is visible to a later `get`, which is how the
 * Next jar behaves and what the customer login flow assumes.
 */
export async function cookies() {
  const ctx = getContext();
  const overrides = (ctx.cookieOverrides ??= new Map());
  const incoming = ctx.req?.cookies ?? {};

  return {
    get(name) {
      if (overrides.has(name)) {
        const value = overrides.get(name);
        return value === null ? undefined : { name, value };
      }
      const value = incoming[name];
      return value === undefined ? undefined : { name, value };
    },

    has(name) {
      return this.get(name) !== undefined;
    },

    getAll() {
      const merged = { ...incoming };
      for (const [name, value] of overrides) {
        if (value === null) delete merged[name];
        else merged[name] = value;
      }
      return Object.entries(merged).map(([name, value]) => ({ name, value }));
    },

    set(name, value, options = {}) {
      overrides.set(name, value);
      requireResponse().cookie(name, value, toExpressOptions(options));
    },

    delete(name) {
      overrides.set(name, null);
      const { path = '/', domain } = typeof name === 'object' ? name : {};
      requireResponse().clearCookie(typeof name === 'object' ? name.name : name, { path, domain });
    },
  };
}

/**
 * Next takes `maxAge` in SECONDS; Express takes it in MILLISECONDS. Getting
 * this wrong silently turns a 30-day session into a 30-second one, so the
 * conversion lives here rather than at each call site.
 */
function toExpressOptions({ maxAge, expires, httpOnly, secure, sameSite, path = '/', domain }) {
  return {
    ...(maxAge === undefined ? {} : { maxAge: maxAge * 1000 }),
    ...(expires === undefined ? {} : { expires }),
    ...(domain === undefined ? {} : { domain }),
    httpOnly: httpOnly ?? false,
    secure: secure ?? false,
    sameSite: sameSite ?? 'lax',
    path,
  };
}

/** Present for API parity; the service layer does not use it. */
export async function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}
