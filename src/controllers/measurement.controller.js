import { sql } from '@/config/database.js';
import { ingestBrowserMeasurement } from '@/services/operations/browser-ingest.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { config } from '@/config/env.js';

/**
 * Aggregate-only funnel counters from the browser.
 *
 * The ported ingest function takes a WHATWG `Request` and does the whole
 * policy check itself — feature flag, DNT and Sec-GPC, origin, content type,
 * a 512-byte body ceiling and a process-local rate cap. That policy is the
 * point of the module, so this controller adapts the Express request into the
 * shape it expects rather than reimplementing any of it.
 *
 * It answers with bare status codes and no body, deliberately: a beacon has
 * nobody to read a response, and returning data would invite it being used as
 * something other than a counter.
 */
export const ingest = asyncHandler(async (req, res) => {
  const url = `${config().NEXT_PUBLIC_SITE_URL}/api/measurement`;

  const request = new Request(url, {
    method: 'POST',
    headers: req.headers,
    body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
  });

  const result = await ingestBrowserMeasurement(request, sql);

  for (const [name, value] of result.headers) res.set(name, value);
  return res.status(result.status).end();
});
