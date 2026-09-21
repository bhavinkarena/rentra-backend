import { sql } from '@/config/database.js';
import { requestBookingQuote } from '@/services/booking/actions.js';
import {
  saveSchedule,
  saveOverride,
  addOpenDates,
  blockDates,
  unblockDates,
} from '@/services/booking/calendar-actions.js';
import { getInventoryState, prepareInventoryCheck } from '@/services/booking/inventory.js';
import { ownerCalendarPage } from '@/services/booking/calendar-page.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { notFound } from '@/utils/apiError.js';

/**
 * Price a selection without reserving anything.
 *
 * Quoting and holding are separate on purpose: a guest changing dates five
 * times should not take inventory out of circulation five times. The hold
 * happens at checkout, and the quote is re-validated there — see the checkout
 * controller.
 */
export const quote = runAction(requestBookingQuote, { style: 'input' });

/** Owner booking calendar. All behind requireActiveClient. */
export const schedule = runAction(saveSchedule);
export const priceOverride = runAction(saveOverride);
export const openDates = runAction(addOpenDates);
export const block = runAction(blockDates);
export const unblock = runAction(unblockDates);

/**
 * Everything the owner's calendar screen renders: the listing's booking
 * configuration and its current owner blocks.
 */
export const calendarPage = asyncHandler(async (req, res) => {
  const page = await ownerCalendarPage(sql, req.user.id, req.params.id);
  if (!page) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
  return ok(res, page);
});

/**
 * The raw inventory state behind that screen — bookings, reservations and the
 * availability rows — for checking whether the calendar is complete enough to
 * accept a booking at all.
 */
export const calendarState = asyncHandler(async (req, res) =>
  ok(
    res,
    await sql.begin(async (tx) => {
      const listing = await prepareInventoryCheck(tx, req.params.id);
      return getInventoryState(tx, listing);
    }),
  ),
);
