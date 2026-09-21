import 'server-only';
import { getCurrentUser, getSession } from '../auth/dal.js';
import { getCurrentAdmin } from '../auth/admin.js';
import { CustomerAccountError } from '../auth/customer-access.js';
import { sql } from '../db/index.js';
import { BookingRecordError, readBookingRecord } from './records.js';
import { bookingSummary } from '../domain/booking-record.js';
import { bookingCalendar } from '../domain/booking-calendar.js';

/**
 * The printable booking summary, and its .ics calendar variant.
 *
 * Returns a plain descriptor rather than a `Response`. This was ported from a
 * Next route handler that could return one directly; under Express the
 * controller has to write the bytes itself, and a `Response` handed to
 * `res.json()` serialises to `{}` — the download silently arrives empty.
 * Keeping this a plain object means neither side can make that mistake.
 */
export async function bookingSummaryResponse(kind, orderId, calendar = false) {
  try {
    const admin = await getCurrentAdmin();
    let actor;
    if (kind === 'admin') {
      if (admin) actor = { kind, id: admin.id };
    } else {
      const user = await getCurrentUser();
      if (
        user?.accountStatus === 'active' &&
        user.role === (kind === 'owner' ? 'client' : 'customer') &&
        !(kind === 'customer' && admin)
      ) {
        actor = kind === 'owner' ? { kind, id: user.id } : { kind, session: await getSession() };
      }
    }
    if (!actor) {
      return { status: 401, body: 'Please log in to the correct account.', contentType: 'text/plain; charset=utf-8' };
    }

    const record = await readBookingRecord(sql, actor, orderId);
    return {
      status: 200,
      body: calendar ? bookingCalendar(record) : bookingSummary(record),
      contentType: calendar ? 'text/calendar; charset=utf-8' : 'text/plain; charset=utf-8',
      filename: `rentra-booking-${record.id}.${calendar ? 'ics' : 'txt'}`,
    };
  } catch (error) {
    const status =
      error instanceof CustomerAccountError ? 401 : error instanceof BookingRecordError ? 404 : 503;
    return {
      status,
      body: status === 503 ? 'Summary temporarily unavailable.' : 'Booking unavailable.',
      contentType: 'text/plain; charset=utf-8',
    };
  }
}
