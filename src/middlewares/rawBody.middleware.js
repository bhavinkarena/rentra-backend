import express from 'express';
import { APP } from '@/config/appConfig.js';

/**
 * Raw body capture for signed webhooks.
 *
 * Razorpay signs the exact bytes it sent. Parsing to JSON and re-serialising
 * changes key order and whitespace, and the HMAC no longer matches — so this
 * route, and only this route, gets the untouched Buffer. It must be mounted
 * before express.json().
 *
 * The size cap is the same one the Next route handler enforced: a legitimate
 * event is a few kilobytes, and anything past 256KB is not worth buffering.
 */
export const rawBody = express.raw({
  type: '*/*',
  limit: APP.webhookBodyLimit,
});
