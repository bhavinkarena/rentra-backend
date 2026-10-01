/** Top-level verticals (entertainment plan). Data lives in the `vertical` table; these are the fixed facts code needs. */
export const DEFAULT_VERTICAL = 'farmhouse';
export const VERTICAL_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

/** The booking engine branches on this and nothing else. */
export const bookingModel = (listing) => (listing?.rental_unit === 'hour' ? 'hourly' : 'slot');
