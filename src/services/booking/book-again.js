import 'server-only';
import { z } from 'zod';
import { readBookingRecord, BookingRecordError } from './records.js';
import { createBookingQuote } from './quotes.js';
import { listingPath } from '../domain/listing-url.js';

export class RebookUnsupportedError extends Error {
  constructor(listingUrl) {
    super('Choose a new time on the venue page.');
    this.code = 'REBOOK_UNSUPPORTED';
    this.listingUrl = listingUrl;
  }
}

export async function quoteBookAgain(database, session, orderId, selection, env = process.env) {
  await readBookingRecord(database, { kind: 'customer', session }, orderId, env);
  // V1: a court booking is rebooked from the venue page (pick a fresh time), not copied.
  const [hourly] = await database`SELECT r.slug,r.public_code FROM booking_order o JOIN rentable r ON r.id=o.rentable_id
    WHERE o.id=${orderId} AND o.customer_id=${session.userId} AND r.rental_unit::text='hour'`;
  if (hourly) throw new RebookUnsupportedError(listingPath(hourly.slug, hourly.public_code));
  const value = z.object({ dates: z.array(z.string()).min(1).max(10), slot: z.enum(['day','night','full_day']), guests: z.number().int().positive() }).strict().parse(selection);
  const [source] = await database`SELECT rentable_id FROM booking_order WHERE id=${orderId} AND customer_id=${session.userId}`;
  if (!source) throw new BookingRecordError();
  // Reuse the authoritative live listing/date/capacity/price/config checks; old prices are never copied.
  return createBookingQuote(database, { ...value, rentableId: source.rentable_id }, { customerId: session.userId, variables: env });
}
