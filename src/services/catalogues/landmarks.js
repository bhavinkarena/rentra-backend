import 'server-only';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '@/utils/apiError.js';
import { authorize } from './service.js';

/**
 * Landmarks (hotel plan, Phase 6) for administrators: the places guests search
 * near ("Surat Railway Station"). Create, edit, deactivate; slugs are public
 * URLs (/hotels/near/{slug}), so a slug never changes once saved. Audited.
 */
export const LANDMARK_KINDS = ['station', 'airport', 'temple', 'business', 'hospital', 'attraction', 'education', 'mall'];

const fields = z.object({
  version: z.number().int().min(1).optional(),
  cityId: z.string().uuid(),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(LANDMARK_KINDS),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  sortOrder: z.number().int().min(0).max(10000).default(0),
  isActive: z.boolean().default(true),
  reason: z.string().trim().min(10).max(1000),
}).strict();

const columns = (tx) => tx`l.id, l.city_id AS "cityId", c.name AS "cityName", l.slug, l.name, l.kind,
  l.latitude::float8 AS latitude, l.longitude::float8 AS longitude, l.sort_order AS "sortOrder", l.is_active AS "isActive", l.version, l.updated_at AS "updatedAt"`;

export async function listLandmarks(database, actor) {
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const [items, cities] = await Promise.all([
      tx`SELECT ${columns(tx)} FROM landmark l JOIN city c ON c.id = l.city_id ORDER BY c.name, l.sort_order, l.name`,
      tx`SELECT id, name FROM city WHERE is_active ORDER BY sort_order, name`,
    ]);
    return { items, cities, kinds: LANDMARK_KINDS, canWrite };
  });
}

/** `id` is 'new' to create. A changed slug on an existing landmark is refused: it is a public URL. */
export async function landmarkCommand(database, actor, id, input) {
  const parsed = fields.safeParse(input);
  if (!parsed.success) throw badRequest('INVALID_CATALOGUE', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const value = parsed.data;
  const creating = id === 'new';
  if (!creating && !z.string().uuid().safeParse(id).success) throw notFound();
  return database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const [city] = await tx`SELECT id FROM city WHERE id = ${value.cityId} AND is_active`;
    if (!city) throw badRequest('INVALID_CITY', 'Choose an active city.');
    let before = null;
    if (!creating) {
      [before] = await tx`SELECT ${columns(tx)} FROM landmark l JOIN city c ON c.id = l.city_id WHERE l.id = ${id} FOR UPDATE OF l`;
      if (!before) throw notFound();
      if (before.version !== value.version) throw conflict('STALE_PREVIEW', 'This landmark changed. Reload and try again.');
      if (before.slug !== value.slug) throw conflict('SLUG_LOCKED', 'A landmark link cannot change once saved. Add a new landmark instead.');
    }
    if ((await tx`SELECT 1 FROM landmark WHERE slug = ${value.slug} AND id <> ${creating ? '00000000-0000-0000-0000-000000000000' : id}`).length) {
      throw conflict('SLUG_TAKEN', 'Another landmark already uses this link.');
    }
    const [saved] = creating
      ? await tx`INSERT INTO landmark (city_id, slug, name, kind, latitude, longitude, sort_order, is_active)
          VALUES (${value.cityId}, ${value.slug}, ${value.name}, ${value.kind}, ${value.latitude}, ${value.longitude}, ${value.sortOrder}, ${value.isActive})
          RETURNING id, version`
      : await tx`UPDATE landmark SET city_id = ${value.cityId}, name = ${value.name}, kind = ${value.kind},
          latitude = ${value.latitude}, longitude = ${value.longitude},
          sort_order = ${value.sortOrder}, is_active = ${value.isActive}, version = version + 1, updated_at = now()
          WHERE id = ${id} RETURNING id, version`;
    const { reason, version: _version, ...after } = value;
    await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, "before", "after")
      VALUES ('admin', ${actor.id}, 'catalogue.landmarks', ${saved.id}, ${creating ? 'catalogue.create' : 'catalogue.update'},
        ${before ? JSON.stringify(before) : null}::text::jsonb, ${JSON.stringify({ ...after, version: saved.version, reason })}::text::jsonb)`;
    return { ok: true, id: saved.id, version: saved.version };
  });
}
