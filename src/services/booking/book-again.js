import 'server-only';
import { z } from 'zod';
import { readBookingRecord, BookingRecordError } from './records.js';
import { createBookingQuote } from './quotes.js';

export async function quoteBookAgain(database, session, orderId, selection, env = process.env) {
  const value = z.object({ dates: z.array(z.string()).min(1).max(10), slot: z.enum(['day','night','full_day']), guests: z.number().int().positive() }).strict().parse(selection);
  await readBookingRecord(database, { kind: 'customer', session }, orderId, env);
  const [source] = await database`SELECT rentable_id FROM booking_order WHERE id=${orderId} AND customer_id=${session.userId}`;
  if (!source) throw new BookingRecordError();
  // Reuse the authoritative live listing/date/capacity/price/config checks; old prices are never copied.
  return createBookingQuote(database, { ...value, rentableId: source.rentable_id }, { customerId: session.userId, variables: env });
}
