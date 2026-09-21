import { RedirectSignal, NotFoundSignal } from './signals.js';

/**
 * `next/navigation` shim. Both functions throw, exactly as the originals do,
 * so the ported control flow is preserved: nothing after a `redirect()` runs.
 *
 * The error middleware turns a RedirectSignal into a successful response
 * carrying `redirect`, and a NotFoundSignal into a 404. The frontend decides
 * whether to actually navigate.
 */
export function redirect(location) {
  throw new RedirectSignal(location);
}

/** Next distinguishes these two; for an API both are "go here next". */
export function permanentRedirect(location) {
  throw new RedirectSignal(location);
}

export function notFound() {
  throw new NotFoundSignal();
}

export { RedirectSignal, NotFoundSignal };
