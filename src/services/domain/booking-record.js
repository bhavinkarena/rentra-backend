export const bookingMoney = value => value == null ? 'Not recorded' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value / 100);
export function bookingTime(value, timeZone = 'Asia/Kolkata') {
  return value ? new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Exact hours not recorded';
}
export function bookingSummary(record) {
  const lines = ['RENTRA BOOKING SUMMARY', record.title, `Reference: ${record.reference}`, `Booking: ${record.state}`,
    'This is a booking summary, not a tax invoice or proof of a real-money payment.',
    `Timezone: ${record.timeZone}`, `Contact: ${record.contact.name || 'Not recorded'} / ${record.contact.phone || 'Not recorded'}`,
    `Purpose: ${record.purpose || 'Not recorded'}`, '', 'VISITS'];
  for (const v of record.visits) lines.push(`${v.reference} | ${v.date} | ${v.slot} | ${v.state} | ${v.guests} guests`,
    `${bookingTime(v.startsAt, record.timeZone)} to ${bookingTime(v.endsAt, record.timeZone)}`,
    `Rent ${bookingMoney(v.rentMinor)}; fee ${bookingMoney(v.feeMinor)}; separate deposit ${bookingMoney(v.depositMinor)}`);
  lines.push('', `Accepted rent: ${bookingMoney(record.rentMinor)}; fee: ${bookingMoney(record.feeMinor)}; separate deposit: ${bookingMoney(record.depositMinor)}`, '', 'PAYMENT RECORDS');
  for (const p of record.payments) lines.push(`${p.provider} ${p.environment} | ${p.state} | ${p.providerOrderId || 'Provider reference pending'}`,
    `Verified ${p.environment} capture: ${bookingMoney(p.capturedMinor)}; ${p.environment} refunded: ${bookingMoney(p.refundedMinor)}; actual bank collection: ${bookingMoney(p.actualBankMinor)}`);
  if (!record.payments.length) lines.push('No verified payment record. Historical reported amounts are not proof of collection.');
  for (const p of record.payments) for (const refund of p.refunds || []) lines.push(`${p.environment} refund ${refund.state}: requested ${bookingMoney(refund.expectedMinor)}; completed ${bookingMoney(refund.actualMinor)}${p.environment === 'test' ? '; actual bank refund: ₹0' : ''}`);
  if (record.payments.some(p => p.environment === 'test')) lines.push('TEST PAYMENT: no actual bank money was collected by the Test gateway.');
  lines.push('', `Cancellation: ${record.policy.cancellationTier || 'Not recorded'}; policy ${record.policy.version || 'Not recorded'}`, ...record.policy.houseRules);
  // Arrival/contact instructions remain on the authenticated page, not in a portable receipt.
  return lines.join('\n') + '\n';
}
