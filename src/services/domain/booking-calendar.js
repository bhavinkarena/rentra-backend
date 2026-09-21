const escape = value => String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const stamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function fold(value) {
  const lines = []; let line = '';
  for (const character of value) {
    if (new TextEncoder().encode(line + character).length > 75) { lines.push(line); line = ' '; }
    line += character;
  }
  lines.push(line); return lines.join('\r\n');
}
export function bookingCalendar(record) {
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Rentra//Booking calendar//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  for (const visit of record.visits) {
    if (!visit.startsAt || !visit.endsAt || !['confirmed','handed_over','returned','completed','disputed','cancelled'].includes(visit.state)) continue;
    lines.push('BEGIN:VEVENT',`UID:${visit.id}@rentra`, `DTSTAMP:${stamp(visit.updatedAt || record.createdAt)}`,
      `DTSTART:${stamp(visit.startsAt)}`, `DTEND:${stamp(visit.endsAt)}`, `SEQUENCE:${visit.version || 0}`,
      `SUMMARY:${escape('Rentra: ' + record.title)}`, `DESCRIPTION:${escape(`Visit ${visit.reference}. Booking ${record.reference}. Times were booked in ${record.timeZone}. ${record.payments.some(p => p.environment === 'test') ? 'Test payment; no actual bank payment.' : ''} ${visit.provenance && visit.provenance !== 'real' ? 'Test / simulation or unverified visit; not evidence of a real visit.' : ''} Open your authenticated booking record for arrival details.`)}`,
      `STATUS:${visit.state === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
