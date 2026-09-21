import { z } from 'zod';
import { uuid } from './common.validation.js';

export const listingIdParam = z.object({ id: uuid });

export const listingsPageQuery = z.object({
  query: z.string().max(100).default(''),
  status: z.enum(['all', 'draft', 'in_review', 'live', 'paused', 'rejected']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10),
});
