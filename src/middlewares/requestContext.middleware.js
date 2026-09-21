import { randomUUID } from 'node:crypto';
import { runWithContext } from '@/runtime/context.js';

/**
 * Installs the per-request scope the ported service layer reads through
 * `cookies()`, `headers()` and React's `cache()`.
 *
 * Must be mounted before anything that touches the service layer, and after
 * cookie-parser — the cookie shim reads `req.cookies`.
 */
export function requestContext(req, res, next) {
  const requestId = req.get('x-request-id') ?? randomUUID();
  res.set('X-Request-Id', requestId);
  req.id = requestId;

  runWithContext({ req, res, requestId }, () => next());
}
