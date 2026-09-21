import { unprocessable, badRequest } from '@/utils/apiError.js';
import { fieldErrors } from '@/services/schemas/zod';

/**
 * Request-shape validation at the edge.
 *
 * This is NOT where business rules are checked — the actions re-validate every
 * field they use with the same shared Zod schemas, and they have to, because
 * they are also reachable from the cron worker and the scripts. What this does
 * is reject obviously malformed requests before they reach a database
 * connection, and give the client a field map instead of a 500.
 *
 * `body` is validated non-destructively for multipart routes: the parsed value
 * replaces req.body only when there are no files, since rebuilding FormData
 * from a coerced object would lose the uploads.
 */
export const validate = ({ body, query, params }) =>
  function validateRequest(req, _res, next) {
    for (const [source, schema] of [
      ['params', params],
      ['query', query],
      ['body', body],
    ]) {
      if (!schema) continue;

      const parsed = schema.safeParse(req[source]);
      if (!parsed.success) {
        return next(
          source === 'body'
            ? unprocessable(fieldErrors(parsed.error))
            : badRequest('INVALID_REQUEST', 'Check the request parameters.', {
                fields: fieldErrors(parsed.error),
              }),
        );
      }

      /**
       * Express 5 makes req.query a getter; assigning to it throws. Stash the
       * coerced value beside it instead and let handlers read req.valid.
       */
      req.valid = { ...(req.valid ?? {}), [source]: parsed.data };
      if (source === 'body' && !req.file && !req.files) req.body = parsed.data;
    }

    next();
  };
