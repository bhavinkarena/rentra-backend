import 'server-only';

import {
  and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql as raw,
} from 'drizzle-orm';
import { db, sql } from './index.js';
import {
  rentable, rentablePrice, rentableAmenity, amenity, documents,
  city, area, category, listingReview,
} from './schema/index.js';

const CLIENT_LISTING_COLUMNS = {
  id: rentable.id,
  publicCode: rentable.publicCode,
  title: rentable.title,
  status: rentable.status,
  rejectionReason: rentable.rejectionReason,
  capacity: rentable.capacity,
  ratingAvg: rentable.ratingAvg,
  reviewCount: rentable.reviewCount,
  updatedAt: rentable.updatedAt,
  areaName: area.name,
  cityName: city.name,
};

const FILTERABLE_STATUSES = new Set([
  'live', 'draft', 'pending_review', 'pending_verification',
  'rejected', 'paused', 'hidden',
]);

function listingFilters(clientId, { query = '', status = 'all' } = {}) {
  const filters = [eq(rentable.clientId, clientId)];
  const term = String(query).trim().slice(0, 100);

  if (status === 'review') {
    filters.push(inArray(rentable.status, ['pending_review', 'pending_verification']));
  } else if (status === 'attention') {
    filters.push(inArray(rentable.status, ['draft', 'rejected']));
  } else if (status === 'resubmit') {
    // Edited while waiting for review: no submission matches the current content (CP06).
    filters.push(eq(rentable.status, 'pending_review'), raw`NOT EXISTS (SELECT 1 FROM listing_submission s
      WHERE s.rentable_id=${rentable.id} AND s.pass_number=${rentable.reviewPass}
        AND s.content_version=${rentable.contentVersion})`);
  } else if (status === 'unbookable') {
    // Live is not bookable until hours are confirmed and a future date is open (CP09).
    // Venues (time-booked) instead need an active court and hourly prices; they open by weekly hours.
    filters.push(eq(rentable.status, 'live'), raw`NOT (coalesce(${rentable.bookingConfig}->>'inventoryReady','')='true'
      AND (EXISTS (SELECT 1 FROM availability a WHERE a.rentable_id=${rentable.id}
        AND a.day >= (now() AT TIME ZONE 'Asia/Kolkata')::date AND a.units_available > 0)
        OR (${rentable.rentalUnit}::text='hour' AND EXISTS (SELECT 1 FROM rentable_resource rs WHERE rs.rentable_id=${rentable.id} AND rs.is_active)
          AND EXISTS (SELECT 1 FROM rentable_rate rr WHERE rr.rentable_id=${rentable.id}))))`);
  } else if (FILTERABLE_STATUSES.has(status)) {
    filters.push(eq(rentable.status, status));
  }

  if (term) {
    const pattern = `%${term}%`;
    filters.push(or(
      ilike(rentable.title, pattern),
      ilike(rentable.publicCode, pattern),
      ilike(area.name, pattern),
      ilike(city.name, pattern),
    ));
  }

  return and(...filters);
}

/**
 * Aggregate cards and a deliberately small recent list for the owner overview.
 * Counts never depend on a UI row limit, so they stay truthful as a portfolio grows.
 */
export async function getClientListingSummary(clientId) {
  const [grouped, recent] = await Promise.all([
    db
      .select({ status: rentable.status, value: count() })
      .from(rentable)
      .where(eq(rentable.clientId, clientId))
      .groupBy(rentable.status),
    db
      .select(CLIENT_LISTING_COLUMNS)
      .from(rentable)
      .leftJoin(area, eq(area.id, rentable.areaId))
      .leftJoin(city, eq(city.id, rentable.cityId))
      .where(eq(rentable.clientId, clientId))
      .orderBy(desc(rentable.updatedAt), desc(rentable.createdAt))
      .limit(6),
  ]);

  // Live is not bookable: hours must be confirmed and dates opened (CP09).
  const [{ bookable }] = await sql`SELECT count(*)::int AS bookable FROM rentable r
    WHERE r.client_id=${clientId} AND r.status='live' AND r.booking_config->>'inventoryReady'='true'
      AND (EXISTS (SELECT 1 FROM availability a WHERE a.rentable_id=r.id
        AND a.day >= (now() AT TIME ZONE 'Asia/Kolkata')::date AND a.units_available > 0)
        OR (r.rental_unit::text='hour' AND EXISTS (SELECT 1 FROM rentable_resource rs WHERE rs.rentable_id=r.id AND rs.is_active)
          AND EXISTS (SELECT 1 FROM rentable_rate rr WHERE rr.rentable_id=r.id)))`;
  const counts = Object.fromEntries(grouped.map((row) => [row.status, Number(row.value)]));
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return {
    total,
    live: counts.live ?? 0,
    bookable,
    inReview: (counts.pending_review ?? 0) + (counts.pending_verification ?? 0),
    attention: (counts.draft ?? 0) + (counts.rejected ?? 0),
    counts,
    recent,
  };
}

/** A filtered, URL-pageable slice for the owner property index. */
export async function getClientListingsPage(
  clientId,
  { query = '', status = 'all', page = 1, pageSize = 10 } = {},
) {
  const safePageSize = Math.min(50, Math.max(5, Number(pageSize) || 10));
  const requestedPage = Math.max(1, Number(page) || 1);
  const where = listingFilters(clientId, { query, status });

  const [{ value }] = await db
    .select({ value: count() })
    .from(rentable)
    .leftJoin(area, eq(area.id, rentable.areaId))
    .leftJoin(city, eq(city.id, rentable.cityId))
    .where(where);

  const total = Number(value);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(requestedPage, totalPages);

  const items = await db
    .select({
      ...CLIENT_LISTING_COLUMNS,
    })
    .from(rentable)
    .leftJoin(area, eq(area.id, rentable.areaId))
    .leftJoin(city, eq(city.id, rentable.cityId))
    .where(where)
    .orderBy(desc(rentable.updatedAt), desc(rentable.createdAt))
    .limit(safePageSize)
    .offset((currentPage - 1) * safePageSize);

  return {
    items,
    total,
    page: currentPage,
    pageSize: safePageSize,
    totalPages,
  };
}

/**
 * One listing plus everything the builder and the reviewer need.
 *
 * Scoped by clientId on purpose: passing a listing id that belongs to someone
 * else must return nothing rather than someone else's property. Pass
 * clientId=null only from the admin side.
 */
export async function getListingForEdit(id, clientId = null) {
  const filters = [eq(rentable.id, id)];
  if (clientId) filters.push(eq(rentable.clientId, clientId));

  const [row] = await db.select().from(rentable).where(and(...filters)).limit(1);
  if (!row) return null;

  const [prices, tags, docs, reviews] = await Promise.all([
    db.select({
      slot: rentablePrice.slot,
      weekday: raw`(${rentablePrice.weekdayMinor}/100)::int`.mapWith(Number).as('weekday'),
      weekend: raw`(${rentablePrice.weekendMinor}/100)::int`.mapWith(Number).as('weekend'),
    }).from(rentablePrice).where(eq(rentablePrice.rentableId, id)),

    db.select({
      amenityId: rentableAmenity.amenityId,
      value: rentableAmenity.value,
      slug: amenity.slug,
      groupSlug: amenity.groupSlug,
      labelEn: amenity.labelEn,
      valueType: amenity.valueType,
    })
      .from(rentableAmenity)
      .innerJoin(amenity, eq(amenity.id, rentableAmenity.amenityId))
      .where(eq(rentableAmenity.rentableId, id)),

    db.select({
      id: documents.id,
      docType: documents.docType,
      side: documents.side,
      status: documents.status,
      reviewNote: documents.reviewNote,
      nameOnDocument: documents.nameOnDocument,
      issuedAt: documents.issuedAt,
      bytes: documents.bytes,
      mimeType: documents.mimeType,
      uploadedAt: documents.uploadedAt,
    }).from(documents).where(and(
      eq(documents.ownerType, 'rentable'),
      eq(documents.ownerId, id),
      isNull(documents.deletedAt),
      ne(documents.status, 'superseded'),
    )),

    db.select().from(listingReview)
      .where(eq(listingReview.rentableId, id))
      .orderBy(asc(listingReview.passNumber)),
  ]);

  const [{ vertical }] = await sql`SELECT vertical_code AS vertical FROM category WHERE id=${row.categoryId}`;
  const venue = row.rentalUnit === 'hour' ? await venueForEdit(id) : { resources: [], hourlyRates: [] };
  return {
    // Money is stored in paise; the editor keeps its whole-rupee fields.
    listing: { ...row, vertical, depositAmount: row.depositMinor / 100, extraGuestCharge: row.extraGuestChargeMinor / 100 },
    prices,
    ...venue,
    amenities: tags,
    photos: Array.isArray(row.photos) ? row.photos : [],
    documents: docs,
    reviews,
  };
}

/** Courts (all, including inactive) and hourly bands of a time-booked venue, for the owner's editor. */
async function venueForEdit(id) {
  const [resources, hourlyRates] = await Promise.all([
    sql`SELECT r.id, r.name, r.capacity, r.is_indoor AS "isIndoor", r.details, r.sort_order AS "sortOrder", r.is_active AS "isActive",
        COALESCE(json_agg(c.slug ORDER BY c.sort_order) FILTER (WHERE c.id IS NOT NULL), '[]'::json) AS activities
      FROM rentable_resource r LEFT JOIN rentable_resource_activity a ON a.resource_id = r.id LEFT JOIN category c ON c.id = a.category_id
      WHERE r.rentable_id = ${id} GROUP BY r.id ORDER BY r.sort_order, r.name, r.id`,
    sql`SELECT c.slug AS activity, rr.day_kind AS "dayKind", rr.start_minute AS "startMinute", rr.end_minute AS "endMinute",
        (rr.hourly_rate_minor / 100)::int AS "hourlyRate"
      FROM rentable_rate rr JOIN category c ON c.id = rr.category_id WHERE rr.rentable_id = ${id}
      ORDER BY c.sort_order, rr.day_kind, rr.start_minute`,
  ]);
  return { resources, hourlyRates };
}

/** Verticals an owner may list in: open to partners, or public. */
export async function getPartnerVerticals(database = sql) {
  return database`SELECT code, slug, name, status, sort_order AS "sortOrder" FROM vertical
    WHERE status IN ('partners','public') ORDER BY sort_order, code`;
}

/** The fixed taxonomy, grouped, in display order. With `vertical`, only that vertical's amenities. */
export async function getAmenityCatalogue({ vertical = null } = {}) {
  const rows = await db
    .select({
      id: amenity.id,
      slug: amenity.slug,
      groupSlug: amenity.groupSlug,
      labelEn: amenity.labelEn,
      labelHi: amenity.labelHi,
      labelGu: amenity.labelGu,
      valueType: amenity.valueType,
      isFilterable: amenity.isFilterable,
    })
    .from(amenity)
    .where(vertical
      ? and(eq(amenity.isActive, true), raw`exists (select 1 from amenity_vertical av where av.amenity_id=${amenity.id} and av.vertical_code=${vertical})`)
      : eq(amenity.isActive, true))
    .orderBy(asc(amenity.sortOrder));

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.groupSlug)) groups.set(row.groupSlug, []);
    groups.get(row.groupSlug).push(row);
  }
  return [...groups.entries()].map(([slug, items]) => ({ slug, items }));
}

/** Categories an owner may pick: active, in a vertical open to partners; optionally one vertical. */
export async function getCategories({ vertical = null } = {}, database = sql) {
  return database`SELECT c.id, c.slug, c.name, c.vertical_code AS vertical, c.icon_key AS "iconKey", c.default_rental_unit::text AS "rentalUnit"
    FROM category c JOIN vertical v ON v.code = c.vertical_code AND v.status IN ('partners','public')
    WHERE c.is_active AND (${!vertical} OR c.vertical_code = ${vertical})
    ORDER BY v.sort_order, c.sort_order, c.name`;
}

export async function getCitiesWithAreas() {
  const rows = await db
    .select({
      cityId: city.id,
      citySlug: city.slug,
      cityName: city.name,
      areaId: area.id,
      areaName: area.name,
    })
    .from(city)
    .innerJoin(area, eq(area.cityId, city.id))
    .where(and(eq(city.isActive, true), eq(area.isActive, true)))
    .orderBy(asc(city.sortOrder), asc(city.name), asc(area.sortOrder), asc(area.name));

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.cityId)) {
      map.set(r.cityId, { id: r.cityId, slug: r.citySlug, name: r.cityName, areas: [] });
    }
    map.get(r.cityId).areas.push({ id: r.areaId, name: r.areaName });
  }
  return [...map.values()];
}
