import 'server-only';

import {
  and, asc, count, desc, eq, ilike, inArray, isNull, or,
} from 'drizzle-orm';
import { db } from './index.js';
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

  const counts = Object.fromEntries(grouped.map((row) => [row.status, Number(row.value)]));
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return {
    total,
    live: counts.live ?? 0,
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
      weekday: rentablePrice.weekday,
      weekend: rentablePrice.weekend,
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
    )),

    db.select().from(listingReview)
      .where(eq(listingReview.rentableId, id))
      .orderBy(asc(listingReview.passNumber)),
  ]);

  return {
    listing: row,
    prices,
    amenities: tags,
    photos: Array.isArray(row.photos) ? row.photos : [],
    documents: docs,
    reviews,
  };
}

/** The fixed taxonomy, grouped, in display order. */
export async function getAmenityCatalogue() {
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
    .where(eq(amenity.isActive, true))
    .orderBy(asc(amenity.sortOrder));

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.groupSlug)) groups.set(row.groupSlug, []);
    groups.get(row.groupSlug).push(row);
  }
  return [...groups.entries()].map(([slug, items]) => ({ slug, items }));
}

export async function getCategories() {
  return db
    .select({ id: category.id, slug: category.slug, name: category.name })
    .from(category)
    .where(eq(category.isActive, true))
    .orderBy(asc(category.name));
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
    .where(eq(city.isActive, true))
    .orderBy(asc(city.name), asc(area.name));

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.cityId)) {
      map.set(r.cityId, { id: r.cityId, slug: r.citySlug, name: r.cityName, areas: [] });
    }
    map.get(r.cityId).areas.push({ id: r.areaId, name: r.areaName });
  }
  return [...map.values()];
}
