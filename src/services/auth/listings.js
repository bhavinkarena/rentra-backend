'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '@/services/db';
import { submitProperty } from '../admin/listings.js';
import { withListingInventory, InventoryError } from '@/services/booking/inventory';
import { legacyRupeesToMinor } from '@/services/domain/booking-money';
import {
  rentable, rentablePrice, rentableAmenity, documents,
  category, city, area,
} from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
import {
  basicsSchema, listingStartSchema, locationSchema, capacitySchema, rulesSchema,
  pricingSchema, termsSchema, ownershipDocSchema,
} from '@/services/schemas/zod/listing';
import { MAX_PHOTOS } from '@/services/domain/listing-completion';
import { movePhoto, photoId, renumberPhotos } from '@/services/domain/listing-photos';
import { getListingForEdit } from '@/services/db/listing-queries';
import { revalidateListing } from '@/services/cache/listing-cache';
import { slugify } from '@/services/domain/listing-url';
import { ownerEditEffect, ownerPauseTarget } from '@/services/domain/listing-lifecycle';
import {
  uploadPrivateDocument, uploadPublicListingPhoto, detectMime, UPLOAD_LIMITS,
  isCloudinaryConfigured,
} from '@/services/uploads/cloudinary';
import { requireActiveClient } from './dal';

/**
 * GATE 2 — the listing builder.
 *
 * Every section saves independently, so a half-built listing survives a closed
 * tab and the sections can be done in any order. `requireActiveClient` on each
 * one is the enforcement of Gate 1: an approved account is the precondition for
 * touching a property at all.
 */

/** Fields that, once changed on a LIVE listing, re-open Gate 2. */
const TRUST_FIELDS = new Set([
  'photos', 'location', 'exactAddress', 'capacity', 'bedrooms',
  'categoryId', 'title', 'amenities', 'houseRules',
]);

async function clientIp() {
  const h = await headers();
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
}

/** Short, permanent, public id. The URL resolves by THIS, not the slug. */
function publicCode() {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return Array.from({ length: 8 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

async function load(id) {
  const user = await requireActiveClient();
  const data = await getListingForEdit(id, user.id);
  // Scoped by clientId in the query: someone else's listing id returns null
  // rather than someone else's property.
  if (!data) redirect('/partner/listings');
  return { user, ...data };
}

/**
 * A trust-field edit on a live listing sends it back for review.
 *
 * Price and calendar are free — a Client raising Saturday pricing has done
 * something completely normal. Swapping in photos of a nicer farm after
 * approval defeats the entire verification, which is why the two are not
 * treated the same. Existing confirmed bookings are untouched either way.
 */
async function applyEdit(listing, fields, changed) {
  const touchesTrust = changed.some((f) => TRUST_FIELDS.has(f));

  /**
   * The status decision is made on the row as it is NOW, under its lock, not
   * on the copy loaded before the form was parsed: an admin restriction or an
   * owner pause committed in between must not be overwritten by this edit.
   */
  const sentBack = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: rentable.status, priorStatus: rentable.priorStatus })
      .from(rentable)
      .where(eq(rentable.id, listing.id))
      .for('update');
    const effect = ownerEditEffect(current, touchesTrust);
    await tx
      .update(rentable)
      .set({ ...fields, ...effect.patch, updatedAt: new Date() })
      .where(eq(rentable.id, listing.id));
    return effect.sentBack;
  });

  /**
   * Every write goes through here, so every write purges the cache. Doing it
   * in the one shared helper rather than in each of the nine callers is what
   * stops the tenth section being added without it.
   */
  revalidateListing(
    { ...listing, slug: fields.slug ?? listing.slug },
    { previousSlug: listing.slug, statusChanged: sentBack },
  );

  return sentBack;
}

/* ------------------------------ create ------------------------------ */

export async function createListingFromBasics(_prev, formData) {
  const user = await requireActiveClient();
  const parsed = listingStartSchema.safeParse({
    categoryId: formData.get('categoryId'),
    title: formData.get('title'),
    description: formData.get('description'),
    highlight: formData.get('highlight') ?? '',
    cityId: formData.get('cityId'),
    areaId: formData.get('areaId'),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;

  // Browser UUIDs are still untrusted. Confirm that the taxonomy is active
  // and, crucially, that the selected area belongs to the selected city
  // before the first property row is written.
  const [[selectedCategory], [selectedCity], [selectedArea]] = await Promise.all([
    db
      .select({
        id: category.id,
        form: category.form,
        defaultRentalUnit: category.defaultRentalUnit,
      })
      .from(category)
      .where(and(eq(category.id, d.categoryId), eq(category.isActive, true)))
      .limit(1),
    db
      .select({ id: city.id })
      .from(city)
      .where(and(eq(city.id, d.cityId), eq(city.isActive, true)))
      .limit(1),
    db
      .select({ id: area.id })
      .from(area)
      .where(and(eq(area.id, d.areaId), eq(area.cityId, d.cityId)))
      .limit(1),
  ]);

  const selectionErrors = {};
  if (!selectedCategory) selectionErrors.categoryId = 'Choose an available category';
  if (!selectedCity) selectionErrors.cityId = 'Choose an available city';
  if (!selectedArea) selectionErrors.areaId = 'Choose an area in this city';
  if (Object.keys(selectionErrors).length) return { errors: selectionErrors };

  const code = publicCode();

  const [row] = await db
    .insert(rentable)
    .values({
      clientId: user.id,
      title: d.title,
      slug: `${slugify(d.title)}-${code}`,
      publicCode: code,
      status: 'draft',
      description: d.description,
      highlight: d.highlight || null,
      form: selectedCategory.form,
      fulfilment: selectedCategory.form === 'fixed' ? 'visit_site' : 'pickup_from_owner',
      rentalUnit: selectedCategory.defaultRentalUnit,
      categoryId: selectedCategory.id,
      cityId: selectedCity.id,
      areaId: selectedArea.id,
    })
    .returning({ id: rentable.id });

  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: row.id, action: 'listing_draft_created', ip: await clientIp(),
  });

  redirect(`/partner/listings/${row.id}/setup/location`);
}

/* ------------------------------ sections ------------------------------ */

export async function saveBasics(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const parsed = basicsSchema.safeParse({
    categoryId: formData.get('categoryId'),
    title: formData.get('title'),
    description: formData.get('description'),
    highlight: formData.get('highlight') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;
  const sentBack = await applyEdit(listing, {
    categoryId: d.categoryId,
    title: d.title,
    // The slug follows the title, but the URL resolves by publicCode, so
    // retitling never breaks a link.
    slug: `${slugify(d.title)}-${listing.publicCode}`,
    description: d.description,
    highlight: d.highlight || null,
  }, ['categoryId', 'title']);

  return { ok: true, sentBack };
}

export async function saveLocation(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const parsed = locationSchema.safeParse({
    cityId: formData.get('cityId'),
    areaId: formData.get('areaId'),
    lat: formData.get('lat'),
    lng: formData.get('lng'),
    exactAddress: formData.get('exactAddress'),
    approachNote: formData.get('approachNote') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;
  const sentBack = await applyEdit(listing, {
    cityId: d.cityId,
    areaId: d.areaId,
    location: { x: d.lng, y: d.lat },
    exactAddress: d.exactAddress,
  }, ['location', 'exactAddress']);

  return { ok: true, sentBack };
}

export async function saveCapacity(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const parsed = capacitySchema.safeParse({
    capacity: formData.get('capacity'),
    bedrooms: formData.get('bedrooms'),
    farmSize: formData.get('farmSize'),
    farmSizeUnit: formData.get('farmSizeUnit'),
    poolSize: formData.get('poolSize') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;
  const sentBack = await applyEdit(listing, {
    capacity: d.capacity,
    bedrooms: d.bedrooms,
    farmSize: d.farmSize,
    farmSizeUnit: d.farmSizeUnit,
    poolSize: d.poolSize || null,
  }, ['capacity', 'bedrooms']);

  return { ok: true, sentBack };
}

export async function saveAmenities(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));

  // Repeated fields shaped "<amenityId>" plus optional "value:<amenityId>".
  const picked = formData.getAll('amenity').map(String).filter(Boolean);

  const rows = picked.map((amenityId) => ({
    rentableId: listing.id,
    amenityId,
    value: String(formData.get(`value:${amenityId}`) ?? '').trim() || null,
  }));

  // Replace wholesale: the form submits the complete set, so a diff would only
  // add a way for the two to disagree.
  await db.delete(rentableAmenity).where(eq(rentableAmenity.rentableId, listing.id));
  if (rows.length) await db.insert(rentableAmenity).values(rows);

  const sentBack = await applyEdit(listing, {}, ['amenities']);
  return { ok: true, sentBack, count: rows.length };
}

export async function saveRules(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const parsed = rulesSchema.safeParse({
    checkInFrom: formData.get('checkInFrom'),
    checkOutBy: formData.get('checkOutBy'),
    petsAllowed: formData.get('petsAllowed') ?? 'no',
    alcoholAllowed: formData.get('alcoholAllowed') ?? 'no',
    stagAllowed: formData.get('stagAllowed') ?? 'on_request',
    musicCutoff: formData.get('musicCutoff') ?? '',
    extraRules: formData.get('extraRules') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;

  /**
   * Structured toggles, not prose, so they can be filtered and translated.
   * `extraRules` is the only free text and it goes through moderation — the
   * checklist has an explicit reject for discriminatory terms (religion,
   * caste, marital status), which are live on competitor sites today.
   */
  const houseRules = {
    petsAllowed: d.petsAllowed === 'yes',
    alcoholAllowed: d.alcoholAllowed === 'yes',
    stagGroups: d.stagAllowed,
    musicCutoff: d.musicCutoff || null,
    notes: d.extraRules || null,
  };

  const sentBack = await applyEdit(listing, {
    checkInFrom: d.checkInFrom,
    checkOutBy: d.checkOutBy,
    houseRules,
  }, ['houseRules']);

  return { ok: true, sentBack };
}

export async function savePricing(_prev, formData) {
  const { listing, user } = await load(String(formData.get('id')));
  const parsed = pricingSchema.safeParse(Object.fromEntries(
    ['day_weekday', 'day_weekend', 'night_weekday', 'night_weekend',
      'full_day_weekday', 'full_day_weekend', 'extraGuestCharge', 'extraHourCharge']
      .map((k) => [k, formData.get(k) || 0]),
  ));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;
  const rows = ['day', 'night', 'full_day']
    .map((slot) => ({
      rentableId: listing.id,
      slot,
      weekday: d[`${slot}_weekday`],
      weekend: d[`${slot}_weekend`],
    }))
    // A slot priced at zero is a slot not offered, not a free slot.
    .filter((r) => r.weekday > 0 || r.weekend > 0);

  await withListingInventory(sql, listing.id, async (tx, locked) => {
    const [active] = await tx`SELECT id FROM "user" WHERE id=${user.id} AND role='client' AND account_status='active' FOR SHARE`;
    if (!active || locked.client_id !== user.id) throw new InventoryError('FORBIDDEN', 'Property access unavailable.');
    await tx`DELETE FROM rentable_price WHERE rentable_id=${listing.id}`;
    for (const row of rows) await tx`INSERT INTO rentable_price (rentable_id,slot,weekday,weekend) VALUES (${listing.id},${row.slot},${row.weekday},${row.weekend})`;
    const config = locked.booking_config;
    if (config) for (const schedule of Object.values(config.slots)) if (schedule.enabled) schedule.extraGuestChargeMinor = legacyRupeesToMinor(d.extraGuestCharge ?? 0);
    await tx`UPDATE rentable SET extra_guest_charge=${d.extraGuestCharge ?? 0}, booking_config=${JSON.stringify(config)}::jsonb, booking_config_version=booking_config_version+1,updated_at=now() WHERE id=${listing.id}`;
  });

  // Free of review, but NOT free of cache: the page, its metadata and its OG
  // card all quote this number, and a card promising one price beside a page
  // opening at another is a bait-and-switch even when it is only staleness.
  revalidateListing(listing);

  return { ok: true, slots: rows.length };
}

export async function saveTerms(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const parsed = termsSchema.safeParse({
    depositAmount: formData.get('depositAmount') || 0,
    cancellationTier: formData.get('cancellationTier'),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  // Deposit and cancellation tier are free fields too.
  await db.update(rentable).set({
    depositAmount: parsed.data.depositAmount,
    cancellationTier: parsed.data.cancellationTier,
    updatedAt: new Date(),
  }).where(eq(rentable.id, listing.id));

  // The cancellation policy is shown to a guest in rupees before they pay.
  revalidateListing(listing);

  return { ok: true };
}

/* ------------------------------ photos ------------------------------ */

export async function uploadListingPhotos(_prev, formData) {
  const { user, listing, photos } = await load(String(formData.get('id')));

  if (!isCloudinaryConfigured()) {
    return { errors: { _: 'Photo upload is not configured on this server yet.' } };
  }

  const files = formData.getAll('photos').filter((f) => f && f.size > 0);
  if (!files.length) return { errors: { photos: 'Choose at least one photo' } };
  if (photos.length + files.length > MAX_PHOTOS) {
    return { errors: { photos: `That would be more than ${MAX_PHOTOS} photos` } };
  }

  const staged = [];
  for (const file of files) {
    if (file.size > UPLOAD_LIMITS.maxBytes) {
      return { errors: { photos: `${file.name} is over 2MB` } };
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = detectMime(buffer);
    if (!mime || !mime.startsWith('image/')) {
      return { errors: { photos: `${file.name} is not a JPG, PNG or WEBP` } };
    }
    staged.push({ buffer, mime });
  }

  const added = [];
  for (const [i, item] of staged.entries()) {
    const result = await uploadPublicListingPhoto({
      buffer: item.buffer,
      folder: `rentra/listings/${listing.id}`,
      publicId: `photo_${Date.now()}_${i}`,
    });
    added.push({
      key: result.publicId,
      alt: `${listing.title} — photo ${photos.length + i + 1}`,
      width: result.width,
      height: result.height,
    });
  }

  const sentBack = await applyEdit(listing, { photos: [...photos, ...added] }, ['photos']);

  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: listing.id, action: 'listing_photos_added',
    after: { count: added.length, total: photos.length + added.length },
    ip: await clientIp(),
  });

  return { ok: true, sentBack, added: added.length };
}

export async function removeListingPhoto(_prev, formData) {
  const { listing, photos } = await load(String(formData.get('id')));
  const key = String(formData.get('key'));

  // photoId, not p.key: seeded and imported photos carry a `url` instead, and
  // matching on `key` alone silently removed nothing at all from those.
  const next = photos.filter((p) => photoId(p) !== key);
  if (next.length === photos.length) return { errors: { _: 'That photo is already gone.' } };

  const sentBack = await applyEdit(
    listing, { photos: renumberPhotos(next, listing.title) }, ['photos'],
  );
  return { ok: true, sentBack, remaining: next.length };
}

/**
 * Reorder, and promote a photo to the cover.
 *
 * Deliberately NOT routed through `applyEdit`. `photos` is a trust field
 * because swapping in pictures of a nicer farm after approval defeats the
 * entire verification — but a reorder is the same approved set in a different
 * order. Nothing new enters the listing, so there is nothing to re-verify, and
 * sending a live listing out of search over it would penalise the single edit
 * we most want owners to make: the first photo IS the listing card, and until
 * now it was whichever file the phone happened to hand over first.
 */
export async function reorderListingPhotos(_prev, formData) {
  const { user, listing, photos } = await load(String(formData.get('id')));
  const key = String(formData.get('key'));
  const move = String(formData.get('move'));

  const result = movePhoto(photos, key, move);
  if (!result) return { errors: { _: 'That photo is no longer here.' } };

  // Already at the end it was asked to move towards: a no-op, not an error.
  if (!result.changed) return { ok: true, cover: photoId(photos[0]) };

  const next = result.photos;

  await db.update(rentable)
    .set({ photos: renumberPhotos(next, listing.title), updatedAt: new Date() })
    .where(eq(rentable.id, listing.id));

  revalidateListing(listing);

  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: listing.id, action: 'listing_photos_reordered',
    before: { cover: photoId(photos[0]) },
    after: { cover: photoId(next[0]), moved: key, from: result.from, to: result.to },
    ip: await clientIp(),
  });

  return { ok: true, cover: photoId(next[0]) };
}

/* --------------------------- ownership proof --------------------------- */

/**
 * THE gate. Name-matching this document against the Client's KYC name is what
 * keeps brokers from posting as owners — the single check that makes a Rentra
 * listing worth more than a classified ad.
 */
export async function uploadOwnershipDocument(_prev, formData) {
  const { user, listing } = await load(String(formData.get('id')));

  if (!isCloudinaryConfigured()) {
    return { errors: { _: 'Document upload is not configured on this server yet.' } };
  }

  const parsed = ownershipDocSchema.safeParse({
    docType: formData.get('docType'),
    nameOnDocument: formData.get('nameOnDocument'),
    issuedAt: formData.get('issuedAt') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const file = formData.get('file');
  if (!file || file.size === 0) return { errors: { file: 'Choose the document' } };
  if (file.size > UPLOAD_LIMITS.maxBytes) return { errors: { file: 'Keep it under 2MB' } };

  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = detectMime(buffer);
  if (!mime || !UPLOAD_LIMITS.mimeTypes.includes(mime)) {
    return { errors: { file: 'Must be a JPG, PNG, WEBP or PDF' } };
  }

  const d = parsed.data;
  const result = await uploadPrivateDocument({
    buffer,
    folder: `rentra/ownership/${listing.id}`,
    publicId: d.docType,
  });

  // The reviewer sets nameMatch — we only record what the Client typed.
  await db.insert(documents).values({
    ownerType: 'rentable',
    ownerId: listing.id,
    docType: d.docType,
    side: 'single',
    storageKey: result.publicId,
    mimeType: mime,
    bytes: result.bytes,
    nameOnDocument: d.nameOnDocument,
    issuedAt: d.issuedAt || null,
    status: 'uploaded',
    uploadedBy: user.id,
  }).onConflictDoUpdate({
    target: [documents.ownerType, documents.ownerId, documents.docType, documents.side],
    set: {
      storageKey: result.publicId,
      mimeType: mime,
      bytes: result.bytes,
      nameOnDocument: d.nameOnDocument,
      issuedAt: d.issuedAt || null,
      status: 'uploaded',
      reviewNote: null,
      reviewedBy: null,
      nameMatch: null,
      uploadedAt: new Date(),
    },
  });

  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: listing.id, action: 'ownership_document_uploaded',
    after: { docType: d.docType }, ip: await clientIp(),
  });

  // Nothing public changes, but the completion bar on both owner chromes does.
  revalidateListing(listing);

  return { ok: true };
}

/* ------------------------------- submit ------------------------------- */

export async function submitListing(_prev, formData) {
  const user = await requireActiveClient();
  const listing = await submitProperty(sql, { id: String(formData.get('id')), clientId: user.id, ip: await clientIp() });
  revalidateListing(listing, { statusChanged: true });
  redirect(`/partner/listings/${listing.id}?submitted=1`);
}

/** Owner-side pause. Leaves search; calendar and bookings are preserved. */
export async function toggleListingPause(_prev, formData) {
  const { user, listing } = await load(String(formData.get('id')));

  const target = ownerPauseTarget(listing.status);
  if (target.error) return { errors: { _: target.error } };

  // Conditional on the status the owner saw: a restriction, review or publish
  // committed since then wins, and the owner is told to reload.
  const [moved] = await db.update(rentable).set({
    status: target.next, priorStatus: listing.status, updatedAt: new Date(),
  }).where(and(eq(rentable.id, listing.id), eq(rentable.status, listing.status)))
    .returning({ id: rentable.id });
  if (!moved) {
    const [now] = await db.select({ status: rentable.status }).from(rentable)
      .where(eq(rentable.id, listing.id));
    return { errors: { _: ownerPauseTarget(now?.status).error ?? 'This property changed. Reload and try again.' } };
  }

  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: listing.id, action: target.next === 'paused' ? 'listing_paused' : 'listing_resumed',
    before: { status: listing.status }, after: { status: target.next }, ip: await clientIp(),
  });

  // Pausing removes the listing from every surface that lists it, so this is
  // the one case where `/` and the sitemap have to go too.
  revalidateListing(listing, { statusChanged: true });

  return { ok: true, status: target.next };
}
