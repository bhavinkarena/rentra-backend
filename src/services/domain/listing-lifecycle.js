/**
 * Owner-side lifecycle rules (CP08). Pure, so the rules are testable without a
 * session; callers apply them to the row they hold locked.
 *
 * Owner pause is the owner's switch (live <-> paused). An admin restriction
 * ('hidden') is Rentra's: nothing here can leave it, and restore returns the
 * property to prior_status.
 */

/**
 * The status effect of an owner edit. A trust edit on a public or owner-paused
 * property needs re-review; on a hidden one it changes what restore returns to,
 * so lifting the restriction can never publish unreviewed trust content.
 */
export function ownerEditEffect({ status, priorStatus }, touchesTrust) {
  if (!touchesTrust) return { patch: {}, sentBack: false };
  if (status === 'live' || status === 'paused')
    return { patch: { status: 'pending_review', priorStatus: status }, sentBack: true };
  if (status === 'hidden' && ['live', 'paused'].includes(priorStatus))
    return { patch: { priorStatus: 'pending_review' }, sentBack: true };
  return { patch: {}, sentBack: false };
}

export const RESTRICTED_MESSAGE =
  'Rentra has restricted this property. Only Rentra can restore it; contact support.';

/** Owner pause/resume. Never reaches or leaves an admin restriction. */
export function ownerPauseTarget(status) {
  if (status === 'live') return { next: 'paused' };
  if (status === 'paused') return { next: 'live' };
  if (status === 'hidden') return { error: RESTRICTED_MESSAGE };
  return { error: 'Only a live listing can be paused.' };
}

const sameValue = (a, b) => {
  if (a && b && typeof a === 'object' && 'x' in a && 'y' in a)
    return Math.abs(a.x - b?.x) < 1e-6 && Math.abs(a.y - b?.y) < 1e-6;
  if (a && b && typeof a === 'object')
    return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  return (typeof a === 'string' ? a.trim() : a ?? null) === (typeof b === 'string' ? b.trim() : b ?? null);
};

/**
 * The trust fields an owner save actually changes. Fields the save writes are
 * compared with the stored row; child collections (amenities, photos) are
 * compared by their caller, so naming one here means it changed.
 */
export function trustChanges(current, fields, names) {
  return names.filter((name) => !(name in fields) || !sameValue(current[name], fields[name]));
}
