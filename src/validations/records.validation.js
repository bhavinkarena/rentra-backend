import { z } from 'zod';
import { uuid } from './common.validation.js';

export const recordIdParam = z.object({ id: uuid });

/** CP13: one private visit photo, always addressed through its order. */
export const recordAttachmentParams = z.object({ id: uuid, attachmentId: uuid });

/** CP14: one booking case. */
export const caseIdParam = z.object({ caseId: uuid });

/**
 * Mirrors `historyFilters` in the booking service, which re-derives all of
 * this anyway. Validating here means a malformed tab is a clean 400 instead of
 * silently collapsing to "all" three layers down.
 */
export const historyQuery = z.object({
  tab: z.enum(['all', 'upcoming', 'past', 'cancelled']).default('all'),
  page: z.coerce.number().int().min(1).max(999999).default(1),
  q: z.string().max(100).default(''),
});

export const operationalHistoryQuery = historyQuery.extend({
  tab: z.enum(['all', 'upcoming', 'today', 'action_needed', 'past', 'cancelled']).default('all'),
  property: z.union([uuid, z.literal('')]).optional(),
});
