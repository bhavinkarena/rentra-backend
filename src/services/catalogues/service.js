import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { intentsFor } from '../domain/discovery.js';
import { badRequest, forbidden, notFound, conflict } from '@/utils/apiError.js';
import { clearDiscoveryRegistryCache } from '../db/discovery.js';

const types = {
  cities: { table: 'city', label: 'name', reference: 'city_id' },
  areas: { table: 'area', label: 'name', reference: 'area_id' },
  categories: { table: 'category', label: 'name', reference: 'category_id' },
  amenities: { table: 'amenity', label: 'label_en' },
};
const uuid = z.string().uuid();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw badRequest(
      'INVALID_CATALOGUE',
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return result.data;
};
function typeOf(type) {
  if (!Object.hasOwn(types, type)) throw notFound();
  return types[type];
}
export async function authorize(tx, actor, write = false) {
  if (actor?.kind !== 'admin' || !uuid.safeParse(actor.id).success) throw forbidden();
  const [row] =
    await tx`SELECT permissions FROM admin_user WHERE id=${actor.id} AND is_active FOR SHARE`;
  const allowed = (action) =>
    row && (row.permissions == null || row.permissions.includes(`admin.catalogues.${action}`));
  if (!allowed(write ? 'write' : 'read')) throw forbidden();
  return Boolean(allowed('write'));
}
async function rowById(tx, c, id) {
  if (!uuid.safeParse(id).success) throw notFound();
  const [row] =
    await tx`SELECT to_jsonb(t)-'centre' AS record FROM ${tx(c.table)} t WHERE id=${id}`;
  if (!row) throw notFound();
  return row.record;
}
async function impact(tx, type, id) {
  const c = typeOf(type);
  const rows =
    type === 'amenities'
      ? await tx`SELECT r.id,r.title,r.status,r.slug,r.public_code,c.slug city,a.slug area,cat.slug category,ra.value FROM rentable_amenity ra JOIN rentable r ON r.id=ra.rentable_id JOIN city c ON c.id=r.city_id JOIN area a ON a.id=r.area_id JOIN category cat ON cat.id=r.category_id WHERE ra.amenity_id=${id} ORDER BY r.id`
      : await tx`SELECT r.id,r.title,r.status,r.slug,r.public_code,c.slug city,a.slug area,cat.slug category FROM rentable r JOIN city c ON c.id=r.city_id JOIN area a ON a.id=r.area_id JOIN category cat ON cat.id=r.category_id WHERE ${tx('r.' + c.reference)}=${id} ORDER BY r.id`;
  const children =
    type === 'cities'
      ? await tx`SELECT id,slug,name,version FROM area WHERE city_id=${id} ORDER BY id`
      : [];
  const routeRows =
    type === 'amenities'
      ? []
      : await tx`SELECT c.slug city,cat.slug category,cat.vertical_code vertical,a.slug area FROM city c CROSS JOIN category cat LEFT JOIN area a ON a.city_id=c.id AND a.is_active WHERE c.is_active AND cat.is_active AND ${type === 'cities' ? tx`c.id=${id}` : type === 'categories' ? tx`cat.id=${id}` : tx`a.id=${id}`} ORDER BY c.slug,cat.slug,a.slug`;
  const paths = new Set(
    rows.flatMap((r) => [`/${r.city}/${r.category}`, `/${r.city}/${r.category}/area/${r.area}`]),
  );
  for (const r of routeRows) {
    if (type !== 'areas') {
      paths.add(`/${r.city}/${r.category}`);
      for (const intent of intentsFor(r.vertical))
        paths.add(`/${r.city}/${r.category}/intent/${intent.slug}`);
    }
    if (r.area) paths.add(`/${r.city}/${r.category}/area/${r.area}`);
  }
  return {
    count: rows.length,
    liveCount: rows.filter((r) => r.status === 'live').length,
    children,
    listings: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      value: r.value ?? null,
      href: `/listing/${r.slug}-${r.public_code}`,
    })),
    paths: [...paths],
    redirects: paths.size
      ? await tx`SELECT from_path,to_path FROM redirect WHERE split_part(to_path,'?',1)=ANY(${[...paths]}::text[]) ORDER BY from_path`
      : [],
  };
}
export async function listCatalogues(database, actor, type, query = {}) {
  const c = typeOf(type);
  const q = parse(
    z
      .object({
        q: z.string().trim().max(100).default(''),
        status: z.enum(['all', 'active', 'inactive']).default('all'),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .strict(),
    query,
  );
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const term = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    const where = tx`(${tx(c.label)} ILIKE ${term} OR slug ILIKE ${term}) AND (${q.status === 'all'} OR is_active=${q.status === 'active'})`;
    const [{ total }] = await tx`SELECT count(*)::int total FROM ${tx(c.table)} WHERE ${where}`;
    const rows =
      await tx`SELECT to_jsonb(t)-'centre' AS record FROM ${tx(c.table)} t WHERE ${where} ORDER BY sort_order,${tx(c.label)},id LIMIT 25 OFFSET ${(q.page - 1) * 25}`;
    const items = [];
    for (const { record } of rows) {
      const [{ count }] =
        type === 'amenities'
          ? await tx`SELECT count(*)::int count FROM rentable_amenity WHERE amenity_id=${record.id}`
          : await tx`SELECT count(*)::int count FROM rentable WHERE ${tx(c.reference)}=${record.id}`;
      items.push({ ...record, usageCount: count });
    }
    return {
      type,
      items,
      total,
      page: q.page,
      totalPages: Math.max(1, Math.ceil(total / 25)),
      canWrite,
      query: q,
    };
  });
}
export async function readCatalogue(database, actor, type, id) {
  const c = typeOf(type);
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    const record = id === 'new' ? null : await rowById(tx, c, id);
    const cities =
      type === 'areas'
        ? await tx`SELECT id,name FROM city WHERE is_active ORDER BY sort_order,name,id`
        : [];
    const replacements = record
      ? await tx`SELECT id,${tx(c.label)} AS name FROM ${tx(c.table)} WHERE is_active AND id<>${id} ORDER BY sort_order,${tx(c.label)},id`
      : [];
    // Centres are approximate locality coordinates, never rentable.location.
    if (record && type === 'areas') {
      const [extension] = await tx`SELECT 1 FROM pg_extension WHERE extname='postgis'`;
      if (extension) {
        const [point] =
          await tx`SELECT ST_X(centre) longitude,ST_Y(centre) latitude FROM area WHERE id=${id}`;
        record.centre = point.latitude == null ? null : point;
      }
    }
    return {
      type,
      record,
      canWrite,
      cities,
      replacements,
      impact: record ? await impact(tx, type, id) : null,
    };
  });
}
const common = {
  label: z.string().trim().min(2).max(120),
  sortOrder: z.number().int().min(0).max(10000),
  isActive: z.boolean(),
};
function fieldsFor(type, creating) {
  const structural = creating
    ? {
        slug: z
          .string()
          .max(type === 'amenities' ? 60 : 80)
          .regex(
            type === 'amenities' ? /^[a-z0-9]+(?:_[a-z0-9]+)*$/ : /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          ),
      }
    : {};
  if (type === 'cities')
    return z.object({ ...common, ...structural, state: z.string().trim().min(2).max(80) }).strict();
  if (type === 'areas')
    return z
      .object({
        ...common,
        ...structural,
        ...(creating ? { cityId: uuid } : {}),
        centre: z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            approved: z.literal(true),
          })
          .strict()
          .optional(),
      })
      .strict();
  if (type === 'categories')
    return z
      .object({
        ...common,
        ...structural,
        iconKey: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable().optional(),
        ...(creating
          ? {
              form: z.enum(['fixed', 'movable']),
              rentalUnit: z.enum(['slot', 'night', 'day', 'week', 'month', 'hour']),
              // The vertical is immutable after create, like the booking model. The default keeps
              // the pre-entertainment admin form working until it sends the vertical.
              verticalCode: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/).default('farmhouse'),
            }
          : {}),
      })
      .strict()
      .superRefine((value, ctx) => {
        // V1 booking model per vertical: farmhouse sells slots, entertainment sells hours.
        const allowed = { farmhouse: ['slot'], entertainment: ['hour'] }[value.verticalCode];
        if (creating && allowed && !allowed.includes(value.rentalUnit))
          ctx.addIssue({ code: 'custom', path: ['rentalUnit'], message: `${value.verticalCode} categories use ${allowed.join('/')} booking` });
      });
  return z
    .object({
      ...common,
      label: z.string().trim().min(2).max(80),
      ...structural,
      labelHi: z.string().trim().max(120),
      labelGu: z.string().trim().max(120),
      groupSlug: z
        .string()
        .max(40)
        .regex(/^[a-z0-9_]+$/),
      isFilterable: z.boolean(),
      verticals: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,23}$/)).min(1).max(10).optional(),
      ...(creating ? { valueType: z.enum(['none', 'count', 'dimensions', 'area', 'charge']) } : {}),
    })
    .strict();
}
/** Saves, then drops this process's cached public registry once the write has committed. */
export async function catalogueCommand(database, actor, type, id, input) {
  const result = await saveCatalogue(database, actor, type, id, input);
  if (result?.ok) clearDiscoveryRegistryCache(database);
  return result;
}

async function saveCatalogue(database, actor, type, id, input) {
  const c = typeOf(type),
    creating = id === 'new';
  const v = parse(
    z
      .object({
        command: z.enum(['save', 'replace']),
        version: z.number().int().min(0),
        fields: z.record(z.string(), z.unknown()).optional(),
        replacementId: uuid.optional(),
        reason: z.string().trim().min(10).max(1000),
        preview: z.boolean(),
        previewHash: z.string().length(64).optional(),
      })
      .strict(),
    input,
  );
  if (creating && v.command !== 'save')
    throw badRequest('INVALID_CATALOGUE', 'Create a record before proposing a replacement.');
  return database.begin(async (tx) => {
    await authorize(tx, actor, true);
    // Serialize catalogue changes and reference writes while recalculating a confirmed impact.
    if (!v.preview)
      await tx`LOCK TABLE city,area,category,amenity,rentable,rentable_amenity,redirect IN SHARE ROW EXCLUSIVE MODE`;
    const before = creating ? null : await rowById(tx, c, id);
    if ((before?.version ?? 0) !== v.version)
      throw conflict('STALE_CATALOGUE', 'This record changed. Reload and preview again.');
    const usage = before
      ? await impact(tx, type, id)
      : { count: 0, liveCount: 0, children: [], listings: [], paths: [] };
    let fields = null,
      replacement = null,
      blocked = null;
    if (v.command === 'replace') {
      if (!v.replacementId || v.replacementId === id)
        throw badRequest('INVALID_REPLACEMENT', 'Choose a different active record.');
      replacement = await rowById(tx, c, v.replacementId);
      if (!replacement.is_active)
        throw badRequest('INVALID_REPLACEMENT', 'Choose an active replacement.');
      if (type === 'areas' && replacement.city_id !== before.city_id)
        throw badRequest('INVALID_REPLACEMENT', 'Replacement area must belong to the same city.');
      replacement.impact = await impact(tx, type, replacement.id);
      replacement.overlapCount = replacement.impact.listings.filter((r) =>
        usage.listings.some((source) => source.id === r.id),
      ).length;
      blocked =
        'Replacement requires an explicit data migration with listing review, value conversion and URL redirects. This preview does not move references.';
      if (type === 'amenities' && replacement.value_type !== before.value_type)
        blocked += ` Value type changes from ${before.value_type} to ${replacement.value_type}; values cannot be copied in place.`;
    } else {
      fields = parse(fieldsFor(type, creating), v.fields);
      if (type === 'categories' && creating) {
        const [vertical] = await tx`SELECT code FROM vertical WHERE code=${fields.verticalCode}`;
        if (!vertical) throw badRequest('INVALID_CATALOGUE', 'verticalCode: choose an existing vertical');
        // /{city}/{slug} resolves a category before a vertical landing; never let one shadow another vertical.
        const [shadow] = await tx`SELECT code FROM vertical WHERE slug=${fields.slug} AND code<>${fields.verticalCode}`;
        if (shadow) throw badRequest('RESERVED_SLUG', 'This slug is the landing page of another vertical.');
      }
      const cityId = before?.city_id ?? fields.cityId;
      if (type === 'areas') {
        const [parent] = await tx`SELECT id,is_active FROM city WHERE id=${cityId}`;
        if (!parent || (fields.isActive && !parent.is_active))
          throw badRequest('INVALID_CITY', 'Choose an active city for an active area.');
      }
      const duplicate =
        await tx`SELECT id FROM ${tx(c.table)} WHERE lower(trim(${tx(c.label)}))=lower(${fields.label}) AND (${creating} OR id<>${before?.id ?? '00000000-0000-0000-0000-000000000000'}) ${type === 'areas' ? tx`AND city_id=${cityId}` : tx``} LIMIT 1`;
      if (duplicate.length)
        throw conflict(
          'DUPLICATE_LABEL',
          'A record with this label already exists in this scope, including inactive records.',
        );
      if (
        creating &&
        type === 'cities' &&
        [
          'admin',
          'partner',
          'staff',
          'api',
          'account',
          'login',
          'signup',
          'auth',
          'bookings',
          'checkout',
          'disputes',
          'help',
          'listing',
          'notifications',
          'policies',
          'privacy',
          'saved',
          'search',
          'support',
        ].includes(fields.slug)
      )
        throw badRequest('RESERVED_SLUG', 'This city slug is reserved by an application route.');
      if (creating) {
        const slugs =
          await tx`SELECT id FROM ${tx(c.table)} WHERE slug=${fields.slug} ${type === 'areas' ? tx`AND city_id=${cityId}` : tx``}`;
        if (slugs.length) throw conflict('DUPLICATE_SLUG', 'This slug already exists.');
      }
      if (!fields.isActive && (usage.count || usage.children.length || usage.redirects?.length))
        blocked =
          'Referenced records cannot be deactivated here. Prepare an explicit replacement migration first; existing listings and public routes must remain valid.';
      // Intent routes have permanent amenity meanings even when no listing currently uses them.
      if (
        type === 'amenities' &&
        !fields.isActive &&
        // Entertainment intents (plan Phase 4) use the last three; guarded from the start.
        ['swimming_pool', 'bonfire', 'open_lawn', 'banquet_lawn', 'floodlights', 'air_conditioned', 'equipment_rental'].includes(
          before?.slug ?? fields.slug,
        )
      )
        blocked =
          'This amenity powers a permanent discovery intent. Deactivation requires a reviewed navigation migration.';
    }
    const summary = {
      type,
      id,
      before,
      fields,
      replacement,
      impact: usage,
      reason: v.reason,
      actorId: actor.id,
    };
    const previewHash = hash(summary);
    const result = {
      preview: true,
      previewHash,
      canApply: !blocked,
      blocked,
      fields,
      replacement,
      impact: usage,
      notice:
        'Slugs, city membership, category rental semantics and amenity value types are immutable. Existing references, booking snapshots and redirects remain unchanged. Label/order changes refresh public discovery and listing displays.',
    };
    if (v.preview) return result;
    if (blocked) throw conflict('MIGRATION_REQUIRED', blocked);
    if (v.previewHash !== previewHash)
      throw conflict(
        'STALE_PREVIEW',
        'The edit or its references changed. Preview again before saving.',
      );
    const values = {
      [c.label]: fields.label,
      sort_order: fields.sortOrder,
      is_active: fields.isActive,
    };
    if (creating) values.slug = fields.slug;
    if (type === 'cities') values.state = fields.state;
    if (type === 'areas' && creating) values.city_id = fields.cityId;
    if (type === 'categories' && creating)
      Object.assign(values, { form: fields.form, default_rental_unit: fields.rentalUnit, vertical_code: fields.verticalCode });
    if (type === 'categories' && fields.iconKey !== undefined) values.icon_key = fields.iconKey;
    if (type === 'amenities')
      Object.assign(values, {
        label_hi: fields.labelHi || null,
        label_gu: fields.labelGu || null,
        group_slug: fields.groupSlug,
        is_filterable: fields.isFilterable,
        ...(creating ? { value_type: fields.valueType } : {}),
      });
    const [saved] = creating
      ? await tx`INSERT INTO ${tx(c.table)} ${tx(values)} RETURNING id,version`
      : await tx`UPDATE ${tx(c.table)} SET ${tx(values)},version=version+1 WHERE id=${id} RETURNING id,version`;
    // Which verticals may use the amenity. New amenities default to farmhouse until a vertical is chosen.
    if (type === 'amenities' && (creating || fields.verticals)) {
      const wanted = fields.verticals ?? ['farmhouse'];
      const known = await tx`SELECT code FROM vertical WHERE code IN ${tx(wanted)}`;
      if (known.length !== new Set(wanted).size) throw badRequest('INVALID_CATALOGUE', 'verticals: choose existing verticals');
      const dropped = await tx`SELECT DISTINCT c.vertical_code FROM rentable_amenity ra JOIN rentable r ON r.id=ra.rentable_id
        JOIN category c ON c.id=r.category_id WHERE ra.amenity_id=${saved.id} AND NOT (c.vertical_code = ANY(${wanted}::text[]))`;
      if (dropped.length) throw conflict('MIGRATION_REQUIRED', `Listings in ${dropped.map((r) => r.vertical_code).join(', ')} use this amenity; keep that vertical.`);
      await tx`DELETE FROM amenity_vertical WHERE amenity_id=${saved.id} AND NOT (vertical_code = ANY(${wanted}::text[]))`;
      for (const code of wanted)
        await tx`INSERT INTO amenity_vertical(amenity_id,vertical_code) VALUES (${saved.id},${code}) ON CONFLICT DO NOTHING`;
    }
    if (type === 'areas' && fields.centre)
      await tx`UPDATE area SET centre=ST_SetSRID(ST_MakePoint(${fields.centre.longitude},${fields.centre.latitude}),4326) WHERE id=${saved.id}`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after") VALUES ('admin',${actor.id},${'catalogue.' + type},${saved.id},${creating ? 'catalogue.create' : 'catalogue.update'},${JSON.stringify(before)}::text::jsonb,${JSON.stringify({ ...values, version: saved.version, centre: fields.centre ?? null, reason: v.reason, impactCount: usage.count })}::text::jsonb)`;
    return { ok: true, id: saved.id, version: saved.version };
  });
}
