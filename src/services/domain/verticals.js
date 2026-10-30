/** Top-level verticals (entertainment plan). Data lives in the `vertical` table; these are the fixed facts code needs. */
export const DEFAULT_VERTICAL = 'farmhouse';
export const VERTICAL_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

/** The booking engine branches on this and nothing else. */
// 'apartment' (unit_night, Stories 3.10/3.11) never enters the slot or hourly engines; apartment-stays.js books it.
export const bookingModel = (listing) =>
  listing?.rental_unit === 'hour' ? 'hourly' : listing?.rental_unit === 'unit_night' ? 'apartment' : 'slot';
/** Slot-calendar writers refuse whole apartments (Story 3.10). */
export const APARTMENT_SLOT_MESSAGE = 'Whole apartments do not use slot calendars yet.';
