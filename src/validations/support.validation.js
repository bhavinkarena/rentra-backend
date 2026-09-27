import { z } from 'zod';
import { uuid } from './common.validation.js';

export const supportIdParam = z.object({ id: uuid });

export const supportListQuery = z.object({
  state: z.enum(['all', 'open', 'in_progress', 'waiting_customer', 'resolved']).default('all'),
  participant: z.enum(['all', 'client', 'customer']).default('all'),
  assignment: z.enum(['all', 'mine', 'unassigned']).default('all'),
  page: z.coerce.number().int().min(1).max(999999).default(1),
});
