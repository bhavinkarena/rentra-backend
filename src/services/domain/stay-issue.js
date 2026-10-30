/**
 * Story 4.1: a guest's contextual stay issue. Pure rules shared by the API and the intake form.
 * Mirror of Rentra/lib/domain/stay-issue.js — keep both in step.
 */
export const ISSUE_TYPES = ['access', 'safety', 'cleanliness', 'not_as_described', 'amenity_broken', 'other'];
export const REMEDIES = ['fix_during_stay', 'partial_refund', 'full_refund_or_move', 'other'];
export const ISSUE_LABELS = {
  access: "Can't get in",
  safety: 'Safety',
  cleanliness: 'Cleanliness',
  not_as_described: 'Not as described',
  amenity_broken: 'Something is broken',
  other: 'Other',
};
export const REMEDY_LABELS = {
  fix_during_stay: 'Fix it during my stay',
  partial_refund: 'Partial refund',
  full_refund_or_move: 'Full refund or move me',
  other: 'Something else',
};
export const URGENT_TYPES = ['access', 'safety'];
export const LATE_HOURS = 72;
export const WINDOW_DAYS = 30;
export const SKEW_MS = 5 * 60_000;
const HOUR = 3_600_000, DAY = 24 * HOUR;

export const issuePriority = (type) => (URGENT_TYPES.includes(type) ? 'urgent' : 'normal');
/** Reported more than 72 h after discovery: accepted, but needs a reason and review. */
export const isLateReport = (discoveredAt, now = new Date()) =>
  new Date(now).getTime() - new Date(discoveredAt).getTime() > LATE_HOURS * HOUR;
/** 'future' | 'before_stay' | null for a discovery time against the stay's first check-in. */
export function discoveryProblem(discoveredAt, firstCheckIn, now = new Date()) {
  const at = new Date(discoveredAt).getTime();
  if (!Number.isFinite(at) || at > new Date(now).getTime() + SKEW_MS) return 'future';
  if (firstCheckIn && at < new Date(firstCheckIn).getTime() - DAY) return 'before_stay';
  return null;
}
export const ISSUE_ORDER_STATES = ['confirmed', 'partially_cancelled', 'completed', 'cancelled'];
/** A visit that happened: not cancelled, or cancelled only after its arrival. Shape {state,startsAt,cancelledAt}. */
export const visitReportable = (v) =>
  v.state !== 'cancelled' || Boolean(v.cancelledAt && v.startsAt && new Date(v.cancelledAt) >= new Date(v.startsAt));
/** Whether an order can take a stay issue now, and its reportable visits and first arrival. */
export function issueEligibility(orderState, visits, now = new Date()) {
  const stayed = visits.filter(visitReportable);
  const time = (key) => stayed.map((v) => v[key]).filter(Boolean).map((d) => new Date(d).getTime());
  const ends = time('endsAt'), starts = time('startsAt');
  const open = ISSUE_ORDER_STATES.includes(orderState) && ends.length > 0 && issueWindowOpen(new Date(Math.max(...ends)), now);
  return { open, visits: stayed, firstStart: starts.length ? new Date(Math.min(...starts)) : null };
}
/** Open from confirmation until 30 days after the last checkout. */
export const issueWindowOpen = (lastCheckOut, now = new Date()) =>
  Boolean(lastCheckOut) && new Date(now).getTime() <= new Date(lastCheckOut).getTime() + WINDOW_DAYS * DAY;
