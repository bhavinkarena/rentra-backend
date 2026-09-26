/** Operational cues use actual visit state and precise instants, never payment state. */
export function visitOperation(visit, now = new Date()) {
  const state = visit.state;
  if (state === 'cancelled') return { label: 'Cancelled — no arrival access', action: null };
  if (state === 'completed') return { label: 'Completed', action: null };
  if (state === 'disputed') return { label: 'Disputed — contact Rentra support', action: null };
  if (!visit.hours_known || !visit.starts_at)
    return { label: 'Visit hours need reconciliation', action: null };
  if (state === 'confirmed')
    return +new Date(visit.starts_at) <= +new Date(now)
      ? { label: 'Arrival due — record actual handover', action: 'handover' }
      : { label: 'Upcoming arrival', action: null };
  if (state === 'handed_over')
    return {
      label:
        +new Date(visit.ends_at) <= +new Date(now)
          ? 'Departure overdue — record actual return'
          : 'Guest on site — record return when observed',
      action: 'return',
    };
  if (state === 'returned')
    return { label: 'Return recorded — complete inspection', action: 'complete' };
  return { label: 'Awaiting verified payment confirmation', action: null };
}
