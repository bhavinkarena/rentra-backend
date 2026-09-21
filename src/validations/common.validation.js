import { z } from 'zod';

/**
 * Shapes shared across route validators.
 *
 * These guard the URL and query string only. Request BODIES are validated by
 * the shared schemas in src/services/schemas/zod, inside the actions, because
 * those are also reachable from the cron worker and the scripts — duplicating
 * them here would give us two definitions of the same rule and the one that
 * drifts is always the one guarding the money.
 */
export const uuid = z.string().uuid('Not a valid id');

/** Public listing codes appear in URLs and WhatsApp links. */
export const publicCode = z.string().regex(/^[A-Za-z0-9-]{4,40}$/, 'Not a valid listing code');

export const slug = z.string().regex(/^[a-z0-9-]{1,80}$/, 'Not a valid slug');

export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10),
});

export const idParam = z.object({ id: uuid });
export const orderIdParam = z.object({ orderId: uuid });
export const reviewIdParam = z.object({ reviewId: uuid });
