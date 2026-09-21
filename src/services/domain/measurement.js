import { z } from 'zod';

// No identifiers, URLs, arbitrary strings or payload objects enter this contract.
export const browserEvents = ['search_submitted', 'listing_viewed', 'dates_selected', 'history_viewed', 'share_attempted', 'share_completed'];
export const serverEvents = ['quote_ready', 'login_completed', 'checkout_started', 'inventory_conflict', 'quote_changed', 'payment_unavailable', 'otp_request_rejected', 'otp_rejected'];
export const measurementSchema = z.object({
  event: z.enum([...browserEvents, ...serverEvents]),
  source: z.enum(['browser', 'server']),
  device: z.enum(['mobile', 'desktop', 'unknown']).default('unknown'),
  visits: z.enum(['single', 'multiple', 'unknown']).default('unknown'),
}).strict().refine(value => (value.source === 'browser' ? browserEvents : serverEvents).includes(value.event));

export function measurementError(code) {
  if (['AVAILABILITY_CONFLICT', 'INVENTORY_CONFLICT'].includes(code)) return 'inventory_conflict';
  if (['QUOTE_CHANGED', 'QUOTE_EXPIRED', 'GATEWAY_VERSION_CONFLICT'].includes(code)) return 'quote_changed';
  if (['PAYMENTS_DISABLED', 'GATEWAY_CREDENTIALS_MISSING', 'PROVIDER_OUTCOME_UNKNOWN'].includes(code)) return 'payment_unavailable';
  return null;
}
