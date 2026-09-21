/**
 * Photo order — pure, no React, no DB.
 *
 * In `lib/domain/` rather than inline in the Server Action for the reason rule
 * 4 gives: it is a business rule. The specific rule is that the FIRST photo is
 * the listing card, the OG card and the WhatsApp preview — which makes "which
 * photo is first" a decision worth being able to test without a database, and
 * worth being impossible to get subtly wrong in one caller and not another.
 *
 * The invariant every function here preserves: a reorder never adds, drops or
 * duplicates a photo. Same set in, same set out.
 */

/** The three moves the UI offers. Anything else is a no-op, never an error. */
export const PHOTO_MOVES = ['cover', 'back', 'forward'];

/**
 * A photo's stable identity, whichever shape it is stored in.
 *
 * `rentable.photos` holds two shapes today and both are legitimate:
 *   · seeded / imported — { url, alt }          (a public path)
 *   · owner-uploaded    — { key, alt, w, h }    (a Cloudinary public_id)
 *
 * Matching on `p.key` alone therefore silently missed every seeded photo, so
 * reordering and deletion did nothing at all on exactly the listings used to
 * demo the product. Resolving identity in one place means neither caller has
 * to know which shape it is looking at, and no migration is owed.
 */
export function photoId(photo) {
  return photo?.key ?? photo?.url ?? null;
}

/**
 * Where `move` sends the photo currently at `from`.
 * Returns `from` itself when the move is impossible — already the cover, or
 * already last — so the caller writes nothing rather than reporting a failure
 * for pressing an arrow at the end of the row.
 */
export function targetIndex(from, move, total) {
  if (from < 0 || from >= total) return from;
  const to = move === 'cover' ? 0
    : move === 'back' ? from - 1
      : move === 'forward' ? from + 1
        : from;
  return to < 0 || to >= total ? from : to;
}

/**
 * @param {Array<{key:string}>} photos
 * @param {string} key
 * @param {'cover'|'back'|'forward'} move
 * @returns {{photos:Array, from:number, to:number, changed:boolean}|null}
 *          null when the key is not in the list — the photo was deleted in
 *          another tab, which is a stale-page problem, not a reorder problem.
 */
export function movePhoto(photos, key, move) {
  const list = Array.isArray(photos) ? photos : [];
  const from = list.findIndex((p) => photoId(p) === key);
  if (from < 0) return null;

  const to = targetIndex(from, move, list.length);
  if (to === from) return { photos: list, from, to, changed: false };

  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);

  return { photos: next, from, to, changed: true };
}

/**
 * Alt text carries the position ("… — photo 3"), so it has to follow the
 * position. Left stale, the third photo keeps describing itself as the first
 * one to every screen reader and every image crawler.
 */
export function renumberPhotos(photos, title) {
  return (Array.isArray(photos) ? photos : []).map((p, i) => ({
    ...p,
    alt: `${title} — photo ${i + 1}`,
  }));
}
