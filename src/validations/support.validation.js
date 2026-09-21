import { z } from 'zod';
import { uuid } from './common.validation.js';

export const supportIdParam = z.object({ id: uuid });

export const supportListQuery = z.object({
  state: z.enum(['all', 'open', 'awaiting_customer', 'awaiting_agent', 'closed']).default('all'),
  page: z.coerce.number().int().min(1).max(999999).default(1),
});
