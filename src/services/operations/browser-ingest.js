import 'server-only';
import { measurementSchema } from '../domain/measurement.js';
import { recordMeasurement } from './measurement.js';

// A process-local ceiling supplements ingress rate limits without retaining IPs.
let windowStart = 0, count = 0;
export async function ingestBrowserMeasurement(request, database, env = process.env) {
  const response = status => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  if (env.RENTRA_MEASUREMENT_ENABLED !== 'true' || request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1') return response(204);
  let origin;
  try { origin = new URL(env.NEXT_PUBLIC_SITE_URL).origin; } catch { return response(503); }
  if (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json')) return response(403);
  const now = Date.now();
  if (now - windowStart >= 60000) { windowStart = now; count = 0; }
  if (++count > 1200) return response(429);
  if (!request.body || Number(request.headers.get('content-length') || 0) > 512) return response(413);
  const reader = request.body.getReader();
  let length = 0;
  const chunks = [];
  let parsed;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 512) { await reader.cancel(); return response(413); }
      chunks.push(Buffer.from(value));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    parsed = measurementSchema.safeParse(input);
    if (!parsed.success || parsed.data.source !== 'browser') return response(400);
  } catch { return response(400); }
  finally { reader.releaseLock(); }
  try { await recordMeasurement(database, parsed.data); return response(204); }
  catch { return response(503); }
}
