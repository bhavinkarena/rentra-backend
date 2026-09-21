/**
 * The public URL of a listing. Pure — no React, no DB, no next/* imports, so
 * the worker and the verification scripts can use it too.
 *
 * `/listing/[slug]-[publicCode]`, and the page RESOLVES BY THE CODE. The slug
 * is decoration that keeps the link readable, which is why retitling can never
 * 404: the code at the end still matches, and the page redirects to the new
 * spelling.
 *
 * One function because six places were building this string by hand — the
 * canonical tag, the permanent redirect, the OG card, the sitemap, the listing
 * card and the cache purge. They have to agree exactly: a canonical that
 * disagrees with the sitemap is an SEO defect that nothing in the app will
 * ever surface as an error, and a cache purge that disagrees with either one
 * silently purges nothing.
 */
export function listingPath(slug, publicCode) {
  return `/listing/${slug}-${publicCode}`;
}

/** Absolute form, for canonical tags, OG cards and the sitemap. */
export function listingUrl(siteUrl, slug, publicCode) {
  return `${siteUrl}${listingPath(slug, publicCode)}`;
}
