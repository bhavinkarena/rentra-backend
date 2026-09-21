import { getContext } from '@/runtime/context.js';

/**
 * One response envelope for the whole API, matching the house format:
 *
 *   { statusCode, data, message, success }
 *
 * Two fields are added on top of that base, and only ever when they apply:
 *
 *   · `code`       — a stable machine-readable error code on failures. The
 *                    `message` is written for a person and will be reworded;
 *                    clients must branch on `code`, never on the text.
 *   · `errors`     — the { field: message } map a form needs. Present only on
 *                    a 422.
 *   · `redirect` / `revalidate` — see below.
 *
 * The last two exist because the service layer was ported from Next.js and
 * still expresses those intents: `redirect('/support/123')` after opening a
 * ticket, `revalidatePath('/partner')` after a save. Discarding them would
 * make every caller re-derive where to go next and what went stale, so they
 * are carried across the wire instead. See src/runtime.
 */
export function responseEnhancer(_req, res, next) {
  res.success = (statusCode = 200, data = null, message = 'Success') =>
    res.status(statusCode).json({
      statusCode,
      data,
      message,
      success: true,
      ...sideEffects(),
    });

  res.error = (statusCode = 500, message = 'Error', { code, errors, data = null } = {}) =>
    res.status(statusCode).json({
      statusCode,
      data,
      message,
      success: false,
      ...(code ? { code } : {}),
      ...(errors ? { errors } : {}),
      ...sideEffects(),
    });

  next();
}

function sideEffects() {
  const { revalidate } = getContext();
  return revalidate?.size ? { revalidate: [...revalidate] } : {};
}
