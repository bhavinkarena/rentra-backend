import 'server-only';
import { listingCompletion } from '../domain/listing-completion.js';
import {getEnv} from '../schemas/joi/env.js';
import {firstIncompleteStepId, stepIndex} from '../domain/listing-steps.js';
import { propertyStrength } from '../domain/listing-strength.js';
import { strengthFacts } from '../auth/property-overview.js';

import {
  and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql as raw,
} from 'drizzle-orm';
import { db, sql } from './index.js';
import {
  rentable, rentablePrice, rentableAmenity, amenity, documents,
  city, area, category, listingReview,
} from './schema/index.js';

/** Live is not bookable until hours are confirmed and a future date is open (CP09); venues open by weekly hours. */
const bookableNow = () => raw`(coalesce(${rentable.bookingConfig}->>'inventoryReady','')='true'
  AND (EXISTS (SELECT 1 FROM availability a WHERE a.rentable_id=${rentable.id}
    AND a.day >= (now() AT TIME ZONE 'Asia/Kolkata')::date AND a.units_available > 0)
    OR (${rentable.rentalUnit}::text='hour' AND EXISTS (SELECT 1 FROM rentable_resource rs WHERE rs.rentable_id=${rentable.id} AND rs.is_active)
      AND EXISTS (SELECT 1 FROM rentable_rate rr WHERE rr.rentable_id=${rentable.id}))))`;

/** Edited while waiting for review: no submission matches the current content (CP06). */
const needsResubmit = () => raw`NOT EXISTS (SELECT 1 FROM listing_submission s
  WHERE s.rentable_id=${rentable.id} AND s.pass_number=${rentable.reviewPass}
    AND s.content_version=${rentable.contentVersion})`;

const latestOutcome = () => raw`(SELECT lr.outcome FROM listing_review lr WHERE lr.rentable_id=${rentable.id}
  ORDER BY lr.pass_number DESC LIMIT 1)`;

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
  // Entertainment plan, Phase 11: venues show "3 courts · 12 players" instead of guests.
  rentalUnit: rentable.rentalUnit,
  vertical: raw`(select c.vertical_code from category c where c.id=${rentable.categoryId})`.as('vertical'),
  resourceCount: raw`(select count(*)::int from rentable_resource rs where rs.rentable_id=${rentable.id} and rs.is_active)`.mapWith(Number).as('resource_count'),
  maxPlayers: raw`(select max(rs.capacity) from rentable_resource rs where rs.rentable_id=${rentable.id} and rs.is_active)`.mapWith(Number).as('max_players'),
  mainActivityIcon: raw`(select c.icon_key from category c where c.id=${rentable.categoryId})`.as('main_activity_icon'),
  // PROP-04 cards: cover, next visit, bookability and why Rentra sent it back.
  cover: raw`(CASE WHEN jsonb_typeof(${rentable.photos})='array' THEN ${rentable.photos}->0 END)`.as('cover'),
  nextVisit: raw`(SELECT json_build_object('day',b.local_day,'slot',b.slot,'startsAt',CASE WHEN b.hours_known THEN b.starts_at END)
    FROM booking b WHERE b.rentable_id=${rentable.id} AND b.state IN ('confirmed','handed_over') AND b.ends_at > now()
    ORDER BY b.starts_at LIMIT 1)`.as('next_visit'),
  bookable: raw`${bookableNow()}`.mapWith(Boolean).as('bookable'),
  reviewOutcome: raw`${latestOutcome()}`.as('review_outcome'),
};

const FILTERABLE_STATUSES = new Set([
  'live', 'draft', 'pending_review', 'pending_verification',
  'rejected', 'paused', 'hidden',
]);

function listingFilters(clientId, { query = '', status = 'all', vertical = '' } = {}) {
  const filters = [eq(rentable.clientId, clientId)];
  if (['farmhouse', 'entertainment'].includes(vertical))
    filters.push(raw`exists (select 1 from category c where c.id=${rentable.categoryId} and c.vertical_code=${vertical})`);
  const term = String(query).trim().slice(0, 100);

  if (status === 'review') {
    filters.push(inArray(rentable.status, ['pending_review', 'pending_verification']));
  } else if (status === 'attention') {
    filters.push(inArray(rentable.status, ['draft', 'rejected']));
  } else if (status === 'resubmit') {
    filters.push(eq(rentable.status, 'pending_review'), needsResubmit());
  } else if (status === 'needs_you') {
    // PROP-04: everything waiting on the owner, not on Rentra.
    filters.push(or(
      eq(rentable.status, 'rejected'),
      and(eq(rentable.status, 'draft'), raw`${latestOutcome()}='changes_requested'`),
      and(eq(rentable.status, 'live'), raw`NOT ${bookableNow()}`),
      and(eq(rentable.status, 'pending_review'), needsResubmit()),
    ));
  } else if (status === 'drafts') {
    filters.push(eq(rentable.status, 'draft'));
  } else if (status === 'unbookable') {
    // Live is not bookable until hours are confirmed and a future date is open (CP09).
    // Venues (time-booked) instead need an active court and hourly prices; they open by weekly hours.
    filters.push(eq(rentable.status, 'live'), raw`NOT ${bookableNow()}`);
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

  const [{ value: needsYou }] = await db.select({ value: count() }).from(rentable)
    .where(listingFilters(clientId, { status: 'needs_you' }));
  return {
    total,
    needsYou: Number(needsYou),
    live: counts.live ?? 0,
    bookable,
    inReview: (counts.pending_review ?? 0) + (counts.pending_verification ?? 0),
    attention: (counts.draft ?? 0) + (counts.rejected ?? 0),
    counts,
    recent,
    // Kinds of place this owner lists; the dashboard offers a filter only when there are two.
    verticals: (await sql`SELECT DISTINCT c.vertical_code AS code FROM rentable r JOIN category c ON c.id=r.category_id
      WHERE r.client_id=${clientId} ORDER BY 1`).map((row) => row.code),
  };
}

/** Owner thumbnails: stored URL, or the stripped Cloudinary delivery URL for an uploaded key. */
const withPhotoUrl = (p) => ({
  ...p,
  url: p.url || (p.key && getEnv().CLOUDINARY_CLOUD_NAME
    ? `https://res.cloudinary.com/${getEnv().CLOUDINARY_CLOUD_NAME}/image/upload/fl_strip_profile/${p.key}`
    : undefined),
});

/** A filtered, URL-pageable slice for the owner property index. */
export async function getClientListingsPage(
  clientId,
  { query = '', status = 'all', vertical = '', page = 1, pageSize = 10 } = {},
) {
  const safePageSize = Math.min(50, Math.max(5, Number(pageSize) || 10));
  const requestedPage = Math.max(1, Number(page) || 1);
  const where = listingFilters(clientId, { query, status, vertical });

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
    // ponytail: one completion or strength read per card on a 10-row page; batch it if pages grow.
    items: await Promise.all(items.map(async (raw) => {
      const item = { ...raw, cover: raw.cover ? withPhotoUrl(raw.cover) : null };
      if (['live', 'paused'].includes(item.status)) {
        const facts = await strengthFacts(sql, item.id);
        return { ...item, strength: propertyStrength(facts, { venue: item.rentalUnit === 'hour' }).percent };
      }
      if (!['draft', 'rejected'].includes(item.status)) return item;
      const data = await getListingForEdit(item.id, clientId);
      const resumeStep = firstIncompleteStepId(data.listing.completion);
      return { ...item, resumeStep, resumeNumber: stepIndex(resumeStep) + 1, stepTotal: data.listing.completion.total + 1 };
    })),
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

  const [{ vertical, categorySlug }] = await sql`SELECT slug AS "categorySlug", vertical_code AS vertical FROM category WHERE id=${row.categoryId}`;
  const venue = row.rentalUnit === 'hour' ? await venueForEdit(id) : { resources: [], hourlyRates: [] };
  const [bookings]=await sql`SELECT count(*)::int AS n FROM booking WHERE rentable_id=${id}`;
  return {
    // Money is stored in paise; the editor keeps its whole-rupee fields.
    listing: { ...row, hasBookings:bookings.n>0,hasReviewHistory:reviews.length>0, vertical, categorySlug, completion: listingCompletion({...row,categorySlug,depositAmount:row.depositMinor/100},{prices,amenities:tags,photos:row.photos,documents:docs,...venue}), depositAmount: row.depositMinor / 100, extraGuestCharge: row.extraGuestChargeMinor / 100 },
    prices,
    ...venue,
    amenities: tags,
    photos: Array.isArray(row.photos) ? row.photos.map(withPhotoUrl) : [],
    documents: docs,
    reviews,
  };
}

/** Courts (all, including inactive) and hourly bands of a time-booked venue, for the owner's editor. */
async function venueForEdit(id) {
  const [resources, hourlyRates] = await Promise.all([
    sql`SELECT r.id, r.name, r.capacity, r.is_indoor AS "isIndoor", r.details, r.sort_order AS "sortOrder", r.is_active AS "isActive",
        -- Held or confirmed visits still ahead: the editor cannot remove these courts (RESOURCE_HAS_BOOKINGS).
        (SELECT count(*)::int FROM booking b JOIN inventory_reservation ir ON ir.booking_id = b.id AND ir.state IN ('held', 'committed')
          WHERE b.resource_id = r.id AND b.ends_at > now()) AS "upcomingBookings",
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
      centre:area.centre,
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
    map.get(r.cityId).areas.push({ id: r.areaId, name: r.areaName,centre:r.centre });
  }
  return [...map.values()];
}
