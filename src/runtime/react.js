import { getContext } from './context.js';

/**
 * React's `cache()` for a non-React runtime.
 *
 * The data access layer wraps `getSession` and `getCurrentUser` in `cache()`
 * so that a page checking the session in four components performs one database
 * read. The same need exists here — several middlewares and a controller can
 * all ask for the current user within one request — so we memoise per request
 * instead of per render pass.
 *
 * Keyed by function identity plus serialised arguments. Deliberately NOT a
 * process-wide cache: that would leak one user's session into another's
 * request, which is the single worst bug this file could have.
 */
export function cache(fn) {
  const id = Symbol('cached');

  return function cached(...args) {
    const { memo } = getContext();
    const key = args.length === 0 ? id : `${String(id.description)}:${JSON.stringify(args)}`;
    const store = memo.has(id) ? memo.get(id) : memo.set(id, new Map()).get(id);

    if (!store.has(key)) store.set(key, fn.apply(this, args));
    return store.get(key);
  };
}

export default { cache };
