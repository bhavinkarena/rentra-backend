import { randomUUID } from 'node:crypto';
import { AppError } from '@/utils/apiError.js';
import { isRedirect, isNotFound } from '@/runtime/signals.js';
import { fail, redirected } from '@/utils/respond.js';
import { logger } from '@/utils/logger.js';

/**
 * The single place errors become responses.
 *
 * The rule is AppError versus everything else. An AppError is operational —
 * someone decided this exact message should reach the caller. Anything else is
 * a bug or an infrastructure failure, and its message is withheld: this
 * process talks to Postgres, Cloudinary and Razorpay, whose errors carry
 * connection strings and key fragments. The caller gets a correlation id
 * instead, and the full error is logged against it.
 */

/**
 * Coded domain errors raised by the ported booking, checkout and inventory
 * code, mapped to HTTP. The messages are the ones the product already shows.
 *
 * Anything absent from this table falls through to a generic 500, which is
 * the correct default: an unmapped code is a gap in this table, not something
 * to hand to a caller unexamined.
 */
const DOMAIN_ERRORS = {
  INVENTORY_NOT_READY: [409, 'The owner needs to confirm the booking calendar.'],
  INVENTORY_REMEDIATION_REQUIRED: [409, 'The owner needs to confirm the booking calendar.'],
  SCHEDULE_UNAVAILABLE: [409, 'The owner needs to confirm the booking calendar.'],
  LISTING_UNAVAILABLE: [409, 'This place is not taking bookings right now.'],
  UNSUPPORTED_INVENTORY: [409, 'This place is not taking bookings right now.'],
  DATES_UNAVAILABLE: [409, 'Those dates have just been taken.'],
  HOLD_EXPIRED: [410, 'Your hold expired. Please pick your dates again.'],
  QUOTE_STALE: [409, 'The price changed. Review the new total before paying.'],
  CHECKOUT_NOT_FOUND: [404, 'That checkout no longer exists.'],
  CHECKOUT_FORBIDDEN: [403, 'That checkout belongs to someone else.'],
  PAYMENTS_NOT_CONFIGURED: [503, 'Payments are not switched on yet.'],
  PAYMENT_CREDENTIALS_MISSING: [503, 'Payments are not switched on yet.'],
  INVALID_EVENT: [400, 'Invalid event.'],
  INVALID_SIGNATURE: [400, 'Invalid event.'],
  EVENT_ID_CONFLICT: [400, 'Invalid event.'],
  CUSTOMER_ACCOUNT_LOCKED: [423, 'This account is temporarily locked.'],
  CUSTOMER_SESSION_INVALID: [401, 'Sign in again to continue.'],
  STALE_REQUEST: [409, 'This changed while you were looking at it. Reload and try again.'],
  RATE_LIMIT: [429, 'Too many requests. Please try again later.'],
};

/** Infrastructure errors that arrive with a code but no HTTP status. */
const INFRA_ERRORS = {
  LIMIT_FILE_SIZE: [413, 'FILE_TOO_LARGE', 'Keep each file under 2MB.'],
  LIMIT_FILE_COUNT: [400, 'TOO_MANY_FILES', 'Too many files.'],
  LIMIT_UNEXPECTED_FILE: [400, 'UNEXPECTED_FILE', 'Unexpected file field.'],
  ECONNREFUSED: [503, 'DATABASE_UNAVAILABLE', 'Temporarily unavailable. Please try again.'],
  ETIMEDOUT: [503, 'UPSTREAM_TIMEOUT', 'Temporarily unavailable. Please try again.'],
};

export function notFoundHandler(req, res) {
  return fail(res, {
    status: 404,
    code: 'ROUTE_NOT_FOUND',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}

// eslint-disable-next-line no-unused-vars -- Express identifies the error handler by arity.
export function errorHandler(error, req, res, next) {
  /** A `redirect()` that escaped an action. Still a success for the caller. */
  if (isRedirect(error)) return redirected(res, error.location);
  if (isNotFound(error)) {
    return fail(res, { status: 404, code: 'NOT_FOUND', message: 'Not found.' });
  }

  if (error instanceof AppError && error.isOperational) {
    return fail(res, {
      status: error.statusCode,
      code: error.code,
      message: error.message,
      fields: error.fields,
    });
  }

  const domain = DOMAIN_ERRORS[error?.code];
  if (domain) {
    const [status, message] = domain;
    return fail(res, { status, code: error.code, message });
  }

  const infra = INFRA_ERRORS[error?.code];
  if (infra) {
    const [status, code, message] = infra;
    return fail(res, { status, code, message });
  }

  /** body-parser and cors surface their own shapes. */
  if (error?.type === 'entity.parse.failed') {
    return fail(res, { status: 400, code: 'MALFORMED_JSON', message: 'Body is not valid JSON.' });
  }
  if (error?.type === 'entity.too.large') {
    return fail(res, { status: 413, code: 'BODY_TOO_LARGE', message: 'Request body too large.' });
  }
  if (error?.message === 'Origin not allowed') {
    return fail(res, { status: 403, code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' });
  }

  /**
   * Non-operational. Log everything against a correlation id, return nothing
   * but that id. In development the real message is included, because the only
   * person reading it is the one who caused it.
   */
  const correlationId = randomUUID();
  /**
   * Read NODE_ENV directly rather than through the cached config. This is the
   * one decision where a stale cache would leak a connection string, and the
   * check costs nothing.
   */
  const production = process.env.NODE_ENV === 'production';
  logger.error('unhandled', {
    cid: correlationId,
    requestId: req.id,
    route: `${req.method} ${req.originalUrl}`,
    name: error?.name,
  });
  if (!production) console.error(error);

  return fail(res, {
    status: error?.statusCode ?? 500,
    code: 'INTERNAL_ERROR',
    message: production
      ? `Something went wrong. Reference: ${correlationId}`
      : `${error?.message ?? 'Internal error'} (ref: ${correlationId})`,
  });
}
