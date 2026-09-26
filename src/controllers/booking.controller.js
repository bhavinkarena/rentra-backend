import { sql } from '@/config/database.js';
import { requestBookingQuote } from '@/services/booking/actions.js';
import {
  saveSchedule,
  saveOverride,
  addOpenDates,
  blockDates,
  unblockDates,
} from '@/services/booking/calendar-actions.js';
import { ownerPortfolioCalendar } from '@/services/booking/owner-calendar.js';
import { ownerCalendarPage } from '@/services/booking/calendar-page.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { notFound, badRequest } from '@/utils/apiError.js';

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
function calendarAction(action) {
  const handler = runAction(action);
  return (req, res, next) => {
    req.body = { ...req.body, rentableId: req.params.id };
    return handler(req, res, next);
  };
}
export const schedule = calendarAction(saveSchedule);
export const priceOverride = calendarAction(saveOverride);
export const openDates = calendarAction(addOpenDates);
export const block = calendarAction(blockDates);
export const unblock = calendarAction(unblockDates);

/**
 * Everything the owner's calendar screen renders: the listing's booking
 * configuration and its current owner blocks.
 */
export const calendarPage = asyncHandler(async (req, res) => {
  const page = await ownerCalendarPage(sql, req.user.id, req.params.id);
  if (!page) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
  return ok(res, page);
});

/** Owner-safe inventory, never the raw internal booking/customer state. */
export const calendarState = asyncHandler(async (req, res) => {
  const page = await readCalendar(req.user.id, {
    ...req.query,
    property: req.params.id,
  });
  if (!page.items.length) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
  return ok(res, page);
});
export const portfolioCalendar = asyncHandler(async (req, res) =>
  ok(res, await readCalendar(req.user.id, req.query)),
);

async function readCalendar(ownerId, query) {
  try {
    return await ownerPortfolioCalendar(sql, ownerId, query);
  } catch (error) {
    if (error instanceof RangeError || error.name === 'ZodError')
      throw badRequest('INVALID_CALENDAR_FILTER', 'Choose a valid date, property, slot and view.');
    throw error;
  }
}
