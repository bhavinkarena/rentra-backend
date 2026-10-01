import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '@/utils/apiError.js';
import { authorize } from './service.js';
import { clearDiscoveryRegistryCache } from '../db/discovery.js';

/**
 * Verticals (Farmhouse, Entertainment) for administrators: rename, reorder and
 * the launch switch `status` (hidden → partners → public). No create or delete
 * in V1. Two-step like other catalogue writes: preview returns a hash that the
 * save must echo, a reason is required, and every change is audited.
 */
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const codeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,23}$/);

export async function listVerticals(database, actor) {
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const items = await tx`SELECT v.code, v.slug, v.name, v.status, v.sort_order AS "sortOrder", v.version, v.updated_at AS "updatedAt",
        (SELECT count(*)::int FROM category c WHERE c.vertical_code=v.code) AS categories,
        (SELECT count(*)::int FROM rentable r JOIN category c ON c.id=r.category_id WHERE c.vertical_code=v.code AND r.status='live') AS live
      FROM vertical v ORDER BY v.sort_order, v.code`;
    return { items, canWrite };
  });
}

export async function verticalCommand(database, actor, code, input) {
  codeSchema.parse(code);
  const v = z.object({
    version: z.number().int().min(1),
    name: z.string().trim().min(2).max(60),
    sortOrder: z.number().int().min(0).max(10000),
    status: z.enum(['hidden', 'partners', 'public']),
    reason: z.string().trim().min(10).max(1000),
    preview: z.boolean(),
    previewHash: z.string().length(64).optional(),
  }).strict().safeParse(input);
  if (!v.success) throw badRequest('INVALID_CATALOGUE', v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const value = v.data;
  const result = await database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const [before] = await tx`SELECT code,slug,name,status,sort_order AS "sortOrder",version FROM vertical WHERE code=${code} FOR UPDATE`;
    if (!before) throw notFound();
    if (before.version !== value.version) throw conflict('STALE_PREVIEW', 'This vertical changed. Reload and preview again.');
    if (code === 'farmhouse' && value.status !== 'public') throw conflict('MIGRATION_REQUIRED', 'Farmhouse is the default vertical and stays public.');
    const [{ live }] = await tx`SELECT count(*)::int AS live FROM rentable r JOIN category c ON c.id=r.category_id WHERE c.vertical_code=${code} AND r.status='live'`;
    const after = { name: value.name, sortOrder: value.sortOrder, status: value.status };
    const summary = { code, before, after, reason: value.reason, actorId: actor.id, live };
    const previewHash = hash(summary);
    const effect = value.status === before.status ? 'Label and order only.'
      : value.status === 'public' ? `Guests will see this vertical, its tabs and its ${live} live listing(s) after the public cache refreshes.`
        : value.status === 'partners' ? 'Owners can create and submit listings; guests see nothing.'
          : 'Hidden from guests and owners. Existing bookings stand and stay manageable.';
    if (value.preview) return { preview: true, previewHash, before, after, live, effect };
    if (value.previewHash !== previewHash) throw conflict('STALE_PREVIEW', 'The change or its impact moved. Preview again before saving.');
    const [saved] = await tx`UPDATE vertical SET name=${value.name}, sort_order=${value.sortOrder}, status=${value.status},
      version=version+1, updated_at=now() WHERE code=${code} RETURNING version`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES ('admin',${actor.id},'catalogue.verticals',${code},'catalogue.update',${JSON.stringify(before)}::text::jsonb,
        ${JSON.stringify({ ...after, version: saved.version, reason: value.reason, live })}::text::jsonb)`;
    return { ok: true, code, version: saved.version };
  });
  if (result.ok) clearDiscoveryRegistryCache(database);
  return result;
}
