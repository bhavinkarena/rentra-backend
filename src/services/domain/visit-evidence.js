/**
 * CP13 visit evidence rules. Pure: no database, storage or session access.
 *
 * Original evidence is never edited. An admin correction supersedes earlier
 * values in one linear chain per evidence row, and readers apply that chain to
 * show the effective values next to the untouched original.
 */

/** Photos only. Three per submission keeps a request under the 8MB action body limit. */
export const EVIDENCE_PHOTO_LIMITS = Object.freeze({
  files: 3,
  bytes: 2 * 1024 * 1024,
  perVisit: 30,
  mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
});

export const INCIDENT_CATEGORIES = Object.freeze([
  'damage',
  'safety',
  'access',
  'conduct',
  'amenity',
  'other',
]);

export const EVIDENCE_PHASES = Object.freeze(['handover', 'return', 'complete']);

/** Incidents may begin up to a day before the scheduled start (arrival and access problems). */
export const INCIDENT_LEAD_MS = 24 * 3600 * 1000;

/** Follow `supersedes` links from the first correction; ignores anything off the chain. */
export function correctionChain(corrections = []) {
  const next = new Map(corrections.map((c) => [c.supersedesId ?? null, c]));
  const chain = [];
  const seen = new Set();
  for (let current = next.get(null); current && !seen.has(current.id); current = next.get(current.id)) {
    seen.add(current.id);
    chain.push(current);
  }
  return chain;
}

/** Effective time/note after the chain, plus the id a new correction must supersede. */
export function effectiveEvidence(evidence, corrections = []) {
  const chain = correctionChain(corrections);
  let { occurredAt, note } = evidence;
  for (const correction of chain) {
    if (correction.correctedOccurredAt) occurredAt = correction.correctedOccurredAt;
    if (correction.correctedNote) note = correction.correctedNote;
  }
  return { occurredAt, note, corrected: chain.length > 0, headId: chain.at(-1)?.id ?? null, chain };
}

/**
 * A corrected time must stay within the visit and keep handover ≤ return ≤
 * complete against the other phases' effective times.
 */
export function correctedTimeAllowed(kind, at, { startsAt, now, effectiveTimes = {} }) {
  const index = EVIDENCE_PHASES.indexOf(kind);
  if (index < 0) return false;
  const value = +new Date(at);
  if (!Number.isFinite(value) || value < +new Date(startsAt) || value > +new Date(now)) return false;
  const previous = effectiveTimes[EVIDENCE_PHASES[index - 1]];
  const following = effectiveTimes[EVIDENCE_PHASES[index + 1]];
  if (previous && value < +new Date(previous)) return false;
  if (following && value > +new Date(following)) return false;
  return true;
}

export function incidentReference(id) {
  return `INC-${String(id).replaceAll('-', '').slice(0, 10).toUpperCase()}`;
}

export function incidentTimeAllowed(at, { startsAt, now }) {
  const value = +new Date(at);
  return (
    Number.isFinite(value) &&
    value >= +new Date(startsAt) - INCIDENT_LEAD_MS &&
    value <= +new Date(now)
  );
}
