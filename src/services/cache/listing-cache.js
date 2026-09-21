import 'server-only';

import { revalidatePath } from 'next/cache';
import { listingPath } from '@/services/domain/listing-url';

/**
 * Everything a listing edit invalidates, in one place.
 *
 * Listing details resolve publication and slug on each request. Home cards and
 * sitemap data are cached, so edits still need explicit invalidation. Keep
 * the detail paths here for router-cache invalidation and future data caching.
 *
 * One module rather than a `revalidatePath` sprinkled through each action, for
 * the same reason the refund calculator is one function: the set of paths a
 * listing appears on will grow (city pages, area pages, category pages are all
 * in the plan), and the day it grows there must be exactly one place to add
 * them.
 */

/**
 * @param {object} listing                 the row as it was BEFORE the update
 * @param {object} [opts]
 * @param {string} [opts.previousSlug]     pass when the title changed
 */
export function revalidateListing(listing, { previousSlug = null } = {}) {
  if (!listing) return;
  const { slug, publicCode, id } = listing;

  if (slug && publicCode) revalidatePath(listingPath(slug, publicCode));

  /**
   * A retitle writes a new slug, and the page resolves by publicCode — so the
   * old path and the new path are two different cache entries. Only purging
   * the new one leaves the old URL serving the old title for up to an hour,
   * which is precisely the link someone already forwarded on WhatsApp.
   */
  if (previousSlug && previousSlug !== slug && publicCode) {
    revalidatePath(listingPath(previousSlug, publicCode));
  }

  // The owner's own surfaces. Neither is cached today — both are noindex
  // Server Components reading live — but naming them here means adding a cache
  // to either one later cannot silently go stale behind our backs.
  revalidatePath('/partner/listings');
  if (id) revalidatePath(`/partner/listings/${id}`);

  // Cards also cache titles, prices and photos; sitemap lastModified changes
  // on edits, not only publication. Keep both consistent with the detail page.
  revalidatePath('/');
  revalidatePath('/sitemap.xml');
}
