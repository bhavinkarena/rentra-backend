import { z } from 'zod';
import { uuid } from './common.validation.js';

export const applicationIdParam = z.object({ id: uuid });
export const userIdParam = z.object({ userId: uuid });
export const documentIdParam = z.object({ id: uuid });

export const clientIdParam = z.object({ id: uuid });
export const lifecyclePreviewQuery = z.object({ action: z.enum(['suspend', 'reinstate']) });

export const decisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const queuePageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
