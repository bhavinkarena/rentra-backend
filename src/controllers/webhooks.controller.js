import { sql } from '@/config/database.js';
import { ingestRazorpayEvent } from '@/services/payments/webhooks.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { APP } from '@/config/appConfig.js';

/**
 * Razorpay events.
 *
 * Three things make this route different from every other one:
 *
 *   · it is NOT behind the session middleware — Razorpay has no cookie, and
 *     the HMAC over the raw body is the authentication;
 *   · it receives the untouched Buffer (see rawBody.middleware), because
 *     re-serialising the JSON changes the bytes and breaks that signature;
 *   · it answers in Razorpay's shape, not this API's envelope, because the
 *     provider's retry logic reads the status code and nothing else.
 *
 * A 4xx tells Razorpay to stop retrying, a 5xx tells it to try again. So a bad
 * signature is 400 and a database outage is 503 — inverting those either
 * replays a forged event forever or silently drops a real payment.
 */
export const razorpay = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!raw || raw.length === 0) {
    return res.status(400).json({ error: 'Invalid event' });
  }
  if (raw.length > APP.webhookBodyLimit) {
    return res.status(413).json({ error: 'Event too large' });
  }

  try {
    await ingestRazorpayEvent(
      sql,
      raw,
      req.get('x-razorpay-signature'),
      req.get('x-razorpay-event-id'),
    );
    return res.json({ received: true });
  } catch (error) {
    const invalid = ['INVALID_EVENT', 'INVALID_SIGNATURE', 'EVENT_ID_CONFLICT'].includes(
      error.code,
    );
    return res
      .status(invalid ? 400 : 503)
      .json({ error: invalid ? 'Invalid event' : 'Event storage unavailable' });
  }
});
