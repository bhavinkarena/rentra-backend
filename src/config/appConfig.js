import { config } from './env.js';

/** Constants the HTTP layer needs that are not environment-dependent. */
export const APP = {
  name: 'rentra-api',
  /** Razorpay signs the raw body; anything larger is not a legitimate event. */
  webhookBodyLimit: 256 * 1024,
  /** KYC and listing photos. Mirrors MAX_DOC_BYTES in the shared constants. */
  uploadFileBytes: 2 * 1024 * 1024,
  uploadMaxFiles: 12,
};

export function apiPrefix() {
  return config().API_PREFIX;
}
