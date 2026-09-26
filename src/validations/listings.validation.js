import { z } from 'zod';
import { uuid } from './common.validation.js';

export const listingIdParam = z.object({ id: uuid });

export const listingsPageQuery = z.object({
  query: z.string().max(100).default(''),
  // Same values listingFilters understands; the owner's filter chips send all of these.
  status: z
    .enum([
      'all',
      'review',
      'attention',
      'resubmit',
      'unbookable',
      'draft',
      'pending_review',
      'pending_verification',
      'live',
      'paused',
      'hidden',
      'rejected',
    ])
    .default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10),
});
