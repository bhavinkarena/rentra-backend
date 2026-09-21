import { getContext } from './context.js';

/**
 * `next/cache` shim.
 *
 * There is no render cache to invalidate here, but the call still carries
 * information the client needs: "the data behind /partner/listings just
 * changed". We collect the paths and hand them back in the response envelope
 * as `revalidate`, so the Next frontend can call `router.refresh()` or its own
 * `revalidatePath` rather than guessing what went stale.
 */
export function revalidatePath(path) {
  getContext().revalidate.add(path);
}

export function revalidateTag(tag) {
  getContext().revalidate.add(`tag:${tag}`);
}

/** No request-level memo store to bust; the per-request memo dies with the request. */
export function unstable_cache(fn) {
  return fn;
}
