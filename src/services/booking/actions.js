'use server';

import { sql } from '../db/index.js';
import { getCurrentUser } from '../auth/dal.js';
import { createBookingQuote } from './quotes.js';
import { measure } from '../operations/measurement.js';
import { measurementError } from '../domain/measurement.js';

/** No browser-supplied customer id, prices, policy or provider identity is accepted. */
export async function requestBookingQuote(input) {
  const user = await getCurrentUser();
  try {
    if (user?.role === 'customer' && user.accountStatus !== 'active') return { error: 'Your customer account is not active.', code: 'CUSTOMER_REQUIRED' };
    const quote = await createBookingQuote(sql, input, { customerId: user?.role === 'customer' ? user.id : null });
    await measure(sql, 'quote_ready', quote.visits.length > 1 ? 'multiple' : 'single');
    return { quote };
  } catch (error) {
    const event = measurementError(error.code);
    if (event) await measure(sql, event);
    if (error.name === 'ZodError') return { error: 'Check your dates, slot and guest count.', code: 'INVALID_SELECTION' };
    if (error instanceof RangeError || (error.code && !/^[0-9A-Z]{5}$/.test(error.code))) {
      return { error: error.message, code: error.code ?? 'INVALID_SELECTION', conflicts: error.conflicts ?? [] };
    }
    return { error: 'Quotes are temporarily unavailable. Please try again.', code: 'QUOTE_UNAVAILABLE' };
  }
}
