/**
 * Express 4 does not catch rejections from async handlers — an unhandled one
 * hangs the request until the client times out. Every async route goes through
 * here so the error middleware actually sees it.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
