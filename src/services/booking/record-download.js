import 'server-only';
import { getCurrentUser, getSession } from '../auth/dal.js';
import { getCurrentAdmin } from '../auth/admin.js';
import { CustomerAccountError } from '../auth/customer-access.js';
import { sql } from '../db/index.js';
import { BookingRecordError, readBookingRecord } from './records.js';
import { bookingSummary } from '../domain/booking-record.js';
import { bookingCalendar } from '../domain/booking-calendar.js';

export async function bookingSummaryResponse(kind, orderId, calendar = false) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' };
  try {
    const admin = await getCurrentAdmin();
    let actor;
    if (kind === 'admin') {
      if (admin) actor = { kind, id: admin.id };
    } else {
      const user = await getCurrentUser();
      if (user?.accountStatus === 'active' && user.role === (kind === 'owner' ? 'client' : 'customer') && !(kind === 'customer' && admin)) {
        actor = kind === 'owner' ? { kind, id: user.id } : { kind, session: await getSession() };
      }
    }
    if (!actor) return new Response('Please log in to the correct account.', { status: 401, headers });
    const record = await readBookingRecord(sql, actor, orderId);
    return new Response(calendar ? bookingCalendar(record) : bookingSummary(record), { headers: { ...headers, 'Content-Type': calendar ? 'text/calendar; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="rentra-booking-${record.id}.${calendar ? 'ics' : 'txt'}"` } });
  } catch (error) {
    const status = error instanceof CustomerAccountError ? 401 : error instanceof BookingRecordError ? 404 : 503;
    return new Response(status === 503 ? 'Summary temporarily unavailable.' : 'Booking unavailable.', { status, headers });
  }
}
