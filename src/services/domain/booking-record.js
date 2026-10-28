export const bookingMoney = value => value == null ? 'Not recorded' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value / 100);
export function bookingTime(value, timeZone = 'Asia/Kolkata') {
  return value ? new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Exact hours not recorded';
}
// Story 2.16: mirror the frontend money labels (Rentra/lib/domain/owner-earnings.js).
const ENVIRONMENT = { test: 'Test', simulated: 'Simulation', legacy_unknown: 'Legacy' };
const GUEST_PAYMENT = { paid: 'Paid in full', partial: 'Part paid', unpaid: 'Not paid' };
const REFUND = { none: 'No refunds', in_progress: 'Refund in progress', needs_review: 'Refund needs review', refunded: 'Refunded' };
const PAYOUT = { not_started: 'Not started', scheduled: 'Scheduled', processing: 'Processing', needs_check: 'Being checked', paid: 'Paid', failed: 'Failed', on_hold: 'On hold' };
const SLOT_LABELS = { day: 'Day visit', night: 'Overnight', full_day: 'Full day' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Digits only from Intl: names and spacing differ between ICU builds (server vs browser).
function zoned(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(value));
  const read = type => Number(parts.find(part => part.type === type)?.value);
  return { ymd: read('year') * 10000 + read('month') * 100 + read('day'), hour: read('hour'), minute: read('minute') };
}
const clock = (value, timeZone) => { const { hour, minute } = zoned(value, timeZone); return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`; };
const localDay = (date) => { const [y, m, d] = String(date).slice(0, 10).split('-').map(Number); return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`; };

/**
 * The one label for a visit on every surface (entertainment plan, Phase 10).
 * Slot visits: "Sat 4 Oct · Overnight". Time-booked visits:
 * "Sat 4 Oct · 7:00 pm – 9:00 pm · Court 2 · Box cricket" ("next day" when the
 * end falls after midnight). Missing court or activity (legacy rows) is skipped.
 */
export function describeVisit(visit, { timeZone = 'Asia/Kolkata' } = {}) {
  const date = visit.date ?? visit.local_day ?? visit.day;
  const day = date ? localDay(date instanceof Date ? date.toISOString() : date) : 'Date not recorded';
  // Hotel stays (hotel plan, Phase 5): "Wed 18 Nov – Fri 20 Nov · 2 nights".
  if (visit.slot === 'stay') {
    const stayEnd = visit.endsAt ?? visit.ends_at;
    if (!stayEnd || !date) return `${day} · Stay`;
    const { ymd } = zoned(stayEnd, timeZone);
    const out = `${Math.floor(ymd / 10000)}-${String(Math.floor(ymd / 100) % 100).padStart(2, '0')}-${String(ymd % 100).padStart(2, '0')}`;
    const start = String(date instanceof Date ? date.toISOString() : date).slice(0, 10);
    const nights = Math.round((Date.parse(`${out}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
    return `${day} – ${localDay(out)} · ${nights} night${nights === 1 ? '' : 's'}`;
  }
  if (visit.slot !== 'hourly') return `${day} · ${SLOT_LABELS[visit.slot] ?? String(visit.slot ?? 'Visit').replaceAll('_', ' ')}`;
  const startsAt = visit.startsAt ?? visit.starts_at;
  const endsAt = visit.endsAt ?? visit.ends_at;
  const nextDay = startsAt && endsAt && zoned(endsAt, timeZone).ymd > zoned(startsAt, timeZone).ymd ? ' next day' : '';
  const court = visit.resource?.name ?? visit.resourceName ?? visit.resource_name;
  const activity = visit.activity?.name ?? visit.activityName ?? visit.activity_name;
  return [day, startsAt && endsAt ? `${clock(startsAt, timeZone)} – ${clock(endsAt, timeZone)}${nextDay}` : null, court, activity].filter(Boolean).join(' · ');
}

/** describeVisit for a raw `booking` row (b.*): times only when known, court and activity from the visit snapshot. */
export function visitLabel(row) {
  const snapshot = row.slot_snapshot ?? {};
  const known = row.hours_known !== false;
  return describeVisit({ date: row.local_day instanceof Date ? row.local_day.toISOString() : row.local_day ?? row.date ?? row.day, slot: row.slot,
    startsAt: known ? row.starts_at : null, endsAt: known ? row.ends_at : null,
    resourceName: row.resource_name ?? snapshot.resourceName, activity: snapshot.activity }, { timeZone: row.time_zone ?? 'Asia/Kolkata' });
}

export function bookingSummary(record) {
  const lines = ['RENTRA BOOKING SUMMARY', record.title, `Reference: ${record.reference}`, `Booking: ${record.state}`,
    'This is a booking summary, not a tax invoice or proof of a real-money payment.',
    `Timezone: ${record.timeZone}`, `Contact: ${record.contact.name || 'Not recorded'} / ${record.contact.phone || 'Not recorded'}`,
    `Purpose: ${record.purpose || 'Not recorded'}`, '', 'VISITS'];
  for (const v of record.visits) lines.push(`${v.reference} | ${describeVisit(v, { timeZone: record.timeZone })} | ${v.state} | ${v.guests} ${v.slot === 'hourly' ? 'players' : 'guests'}`,
    `${bookingTime(v.startsAt, record.timeZone)} to ${bookingTime(v.endsAt, record.timeZone)}`,
    `Rent ${bookingMoney(v.rentMinor)}; fee ${bookingMoney(v.feeMinor)}; separate deposit ${bookingMoney(v.depositMinor)}`);
  if (record.stay) {
    // Hotel stay: rooms, plans and the GST invoice details (the hotel issues the tax invoice).
    lines.push('', 'ROOMS', ...record.stay.rooms.map(room => `${room.name} · ${room.plan?.name ?? ''} | ${room.guestName || 'Guest'} | ${room.adults} adult(s)${room.childAges?.length ? `, ${room.childAges.length} child(ren)` : ''} | room ${bookingMoney(room.roomMinor)} + tax ${bookingMoney(room.taxMinor)} | ${room.state}${room.departedAt ? ` | Ended early: ${bookingTime(room.departedAt, record.timeZone)}; ${room.inventoryEnd < record.stay.checkOut ? `unused nights released from ${room.inventoryEnd}` : 'no unused nights to release'}; original dates retained` : ''}`));
    const d = record.stay.details;
    if (d?.arrivalTime) lines.push(`Expected arrival: ${d.arrivalTime}`);
    if (d?.requests) lines.push(`Requests: ${d.requests}`);
    if (d?.gstin) lines.push(`GST invoice to: ${d.businessName} (GSTIN ${d.gstin})`);
  }
  lines.push('', `Accepted rent: ${bookingMoney(record.rentMinor)}; fee: ${bookingMoney(record.feeMinor)}; separate deposit: ${bookingMoney(record.depositMinor)}`, '', 'PAYMENT RECORDS');
  const payments = record.payments ?? [];
  const notLive = 'Not applicable (not live)';
  if (record.guestPayment) {
    // Owner: guest summary and own payout state only, never provider internals.
    const g = record.guestPayment, label = ENVIRONMENT[g.environment];
    lines.push(`Guest payment${label ? ` (${label})` : ''}: ${GUEST_PAYMENT[g.state] ?? 'Not recorded'}; received ${bookingMoney(g.receivedMinor)} of ${bookingMoney(g.dueMinor)}`,
      `Guest refunds: ${REFUND[g.refund.state] ?? 'Not recorded'}; requested ${bookingMoney(g.refund.requestedMinor)}; refunded ${bookingMoney(g.refund.refundedMinor)}`);
    if (g.mixedEnvironments) lines.push('Other test payments exist.');
    for (const v of record.visits) lines.push(`Your payout ${v.reference}: ${PAYOUT[v.payout?.state] ?? 'Not recorded'}${v.payout?.amountMinor != null ? ` ${bookingMoney(v.payout.amountMinor)}` : ''}${ENVIRONMENT[v.payout?.environment] ? ` (${ENVIRONMENT[v.payout.environment]})` : ''}`);
  } else {
    for (const p of payments) lines.push(`${p.provider} ${p.environment}${ENVIRONMENT[p.environment] ? ` (${ENVIRONMENT[p.environment]})` : ''} | ${p.state} | ${p.providerOrderId || 'Provider reference pending'}`,
      `Verified ${p.environment} capture: ${bookingMoney(p.capturedMinor)}${p.simulatedMinor != null ? `; Simulation amount (not money): ${bookingMoney(p.simulatedMinor)}` : ''}; ${p.environment} refunded: ${bookingMoney(p.refundedMinor)}; actual bank collection: ${p.environment !== 'live' ? notLive : bookingMoney(p.actualBankMinor)}`);
    if (!payments.length) lines.push('No verified payment record. Historical reported amounts are not proof of collection.');
    for (const p of payments) for (const refund of p.refunds || []) lines.push(`${p.environment} refund ${refund.state}: requested ${bookingMoney(refund.expectedMinor)}; completed ${bookingMoney(refund.actualMinor)}${p.environment !== 'live' ? `; actual bank refund: ${notLive}` : ''}`);
  }
  const environments = record.guestPayment ? [record.guestPayment.environment] : payments.map(p => p.environment);
  if (environments.includes('test')) lines.push('TEST PAYMENT: no actual bank money was collected by the Test gateway.');
  if (environments.includes('simulated')) lines.push('SIMULATION: no money was collected.');
  lines.push('', `Cancellation: ${record.policy.cancellationTier || 'Not recorded'}; policy ${record.policy.version || 'Not recorded'}`, ...record.policy.houseRules);
  // Arrival/contact instructions remain on the authenticated page, not in a portable receipt.
  return lines.join('\n') + '\n';
}
