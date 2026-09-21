/**
 * AppError — an OPERATIONAL error whose message is safe to show the caller.
 *
 * Throw this when you deliberately want a status and a message to reach the
 * client. Anything that is NOT an AppError is treated as a programmer or infra
 * error: its message is withheld and logged server-side under a correlation id
 * the caller can quote to support. That distinction is the whole point — this
 * process talks to Postgres, Cloudinary and Razorpay, and their raw errors
 * carry connection strings and key fragments.
 */
export class AppError extends Error {
  constructor(message, statusCode = 400, { code, fields, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code ?? defaultCode(statusCode);
    if (fields) this.fields = fields;
    if (cause) this.cause = cause;
  }
}

/** Kept as an alias: `ApiError` reads better at some call sites. */
export { AppError as ApiError };

/** Argument order matches the other helpers: code first, then the human text. */
export const badRequest = (code = 'BAD_REQUEST', message = 'Invalid request.', extra) =>
  new AppError(message, 400, { code, ...extra });

export const unauthorized = (code = 'AUTH_REQUIRED', message = 'Sign in to continue.') =>
  new AppError(message, 401, { code });

export const forbidden = (code = 'FORBIDDEN', message = 'You cannot do that.') =>
  new AppError(message, 403, { code });

export const notFound = (code = 'NOT_FOUND', message = 'Not found.') =>
  new AppError(message, 404, { code });

export const conflict = (code = 'CONFLICT', message = 'That has already changed.') =>
  new AppError(message, 409, { code });

export const unprocessable = (fields, message = 'Check the highlighted fields.') =>
  new AppError(message, 422, { code: 'VALIDATION_FAILED', fields });

export const tooLarge = (code = 'PAYLOAD_TOO_LARGE', message = 'That is too large.') =>
  new AppError(message, 413, { code });

export const unavailable = (code = 'SERVICE_UNAVAILABLE', message = 'Temporarily unavailable.') =>
  new AppError(message, 503, { code });

function defaultCode(status) {
  return (
    {
      400: 'BAD_REQUEST',
      401: 'AUTH_REQUIRED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      422: 'VALIDATION_FAILED',
      429: 'RATE_LIMITED',
      503: 'SERVICE_UNAVAILABLE',
    }[status] ?? 'INTERNAL_ERROR'
  );
}
