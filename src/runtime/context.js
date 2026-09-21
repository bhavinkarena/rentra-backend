import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request store for the ported service layer.
 *
 * In Next.js, `cookies()`, `headers()` and React's `cache()` read from an
 * ambient request scope the framework installs. Express has no such thing, so
 * we install one ourselves with AsyncLocalStorage and point the framework
 * shims at it. Every request handler runs inside `runWithContext`.
 *
 * Background jobs (cron, scripts) run OUTSIDE any request. They get a frozen
 * empty context rather than a thrown error: a notification job that happens to
 * call a service which happens to peek at a header should degrade to "no
 * header", not crash the worker at 3am.
 */
const storage = new AsyncLocalStorage();

const DETACHED = {
  req: null,
  res: null,
  /** Paths the service layer asked Next to revalidate; returned to the client. */
  revalidate: new Set(),
  /** Backing store for the React `cache()` shim. */
  memo: new Map(),
  detached: true,
};

export function runWithContext(ctx, fn) {
  return storage.run({ revalidate: new Set(), memo: new Map(), detached: false, ...ctx }, fn);
}

/** Never null. Callers outside a request get the detached context. */
export function getContext() {
  return storage.getStore() ?? DETACHED;
}

export function requireResponse() {
  const { res } = getContext();
  if (!res) {
    throw new Error(
      'No HTTP response in scope. Cookies can only be written while handling a request.',
    );
  }
  return res;
}
