import { getContext } from '@/runtime/context.js';

/**
 * Thin wrappers over the `res.success` / `res.error` helpers installed by the
 * response enhancer middleware.
 *
 * Controllers may call either form. These exist so a handler that wants a
 * redirect, or a 422 with a field map, does not have to remember the exact
 * option keys each time.
 */
export const ok = (res, data = null, status = 200, message = 'Success') =>
  res.success(status, data, message);

export const created = (res, data = null, message = 'Created') => res.success(201, data, message);

export const fail = (res, { status = 400, code, message = 'Error', fields, data = null }) =>
  res.error(status, message, { code, errors: fields, data });

/**
 * A successful action that told the caller where to go next.
 *
 * Still a 200: the work was done, and the location is advice for the client's
 * router — not an HTTP redirect the browser should follow. A real 3xx here
 * would make fetch() silently re-issue a POST against a page URL.
 */
export const redirected = (res, location, data = null, message = 'Success') => {
  const { revalidate } = getContext();
  return res.status(200).json({
    statusCode: 200,
    data,
    message,
    success: true,
    redirect: location,
    ...(revalidate?.size ? { revalidate: [...revalidate] } : {}),
  });
};
