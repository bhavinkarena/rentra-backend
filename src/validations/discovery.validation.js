import { z } from 'zod';
import { publicCode, slug } from './common.validation.js';

export const codeParam = z.object({ code: publicCode });

export const liveListingsQuery = z.object({
  citySlug: slug.optional(),
  areaSlug: slug.optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

/**
 * Bounds, not just types. An unbounded radius turns one request into a full
 * table scan with a PostGIS distance on every row.
 */
export const nearbyQuery = z.object({
  lng: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  km: z.coerce.number().min(1).max(200).default(25),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

/**
 * Deliberately permissive.
 *
 * The real normalisation is `parseDiscoveryQuery` in the shared domain layer,
 * which the frontend uses too and which returns human-readable errors per
 * filter. Re-specifying those rules here would give us two definitions that
 * drift, so this only caps the things that would be expensive before the
 * parser ever sees them: an absurdly long path, and an unbounded page number.
 */
export const searchQuery = z
  .object({
    path: z.string().max(200).optional(),
    page: z.coerce.number().int().min(1).max(200).optional(),
  })
  .passthrough();

export const routePathQuery = z.object({ path: z.string().min(1).max(200) });
