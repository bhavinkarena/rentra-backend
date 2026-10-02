'use server';

import { z } from 'zod';
import { signListingPhoto, listingPhotoAsset, destroyListingPhoto } from '../uploads/cloudinary.js';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import { db, sql } from '@/services/db';
import { submitProperty } from '../admin/listings.js';
import { changePropertyPolicy } from '../booking/property-policy.js';
import { changeHourlyRates } from '../booking/hourly-rates.js';
import { saveVenueResources } from '../booking/venue.js';
import {
  rentable, rentableAmenity, documents, users,
  category, city, area,
} from '@/services/db/schema/index.js';
import { audit } from '@/services/audit';
import { fieldErrors } from '@/services/schemas/zod';
import {
  basicsSchema, listingStartSchema, locationSchema, capacitySchema, rulesSchema,
  ownershipDocSchema, venueRulesSchema, termsSchema,
} from '@/services/schemas/zod/listing';
import { MAX_PHOTOS, ownershipDocTypesFor } from '@/services/domain/listing-completion';
import { movePhoto, photoId, renumberPhotos } from '@/services/domain/listing-photos';
import { getListingForEdit } from '@/services/db/listing-queries';
import { revalidateListing } from '@/services/cache/listing-cache';
import { slugify } from '@/services/domain/listing-url';
import { ownerEditEffect, ownerPauseTarget, trustChanges } from '@/services/domain/listing-lifecycle';
import {
  uploadPrivateDocument, uploadPublicListingPhoto, detectMime, UPLOAD_LIMITS,
  isCloudinaryConfigured,
} from '@/services/uploads/cloudinary';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { requireClient, requireActiveClient } from './dal';

/**
 * GATE 2 — the listing builder.
 *
 * Every section saves independently, so a half-built listing survives a closed
 * tab and the sections can be done in any order. Pending owners may edit
 * drafts; publishing still requires an approved account.
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

/**
 * The content version the owner's form was rendered from (CP09). Optional so
 * older clients keep working; when present, a save made against content that
 * changed since (another tab, or a Rentra correction) is refused, not merged.
 */
function expectedVersion(formData) {
  const value = Number(formData.get('contentVersion'));
  return Number.isInteger(value) && value > 0 ? value : null;
}

const CHANGED_MESSAGE =
  'This property changed after you opened it (in another tab, or by Rentra). Reload to see the latest version before saving again.';

function assertVersion(current, expected) {
  if (expected != null && current !== expected) throw conflict('LISTING_CHANGED', CHANGED_MESSAGE);
}

async function load(id) {
  const user = await requireClient();
  const data = await getListingForEdit(id, user.id);
  // Scoped by clientId in the query: someone else's listing id returns null
  // rather than someone else's property.
  if (!data) redirect('/partner/listings');
  if (user.accountStatus !== 'active' && data.listing.status !== 'draft') throw notFound();
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
async function applyEdit(listing, fields, changed, { expected = null, children = null } = {}) {

  /**
   * The status decision is made on the row as it is NOW, under its lock, not
   * on the copy loaded before the form was parsed: an admin restriction or an
   * owner pause committed in between must not be overwritten by this edit.
   */
  const { sentBack, contentVersion } = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        status: rentable.status,
        priorStatus: rentable.priorStatus,
        contentVersion: rentable.contentVersion,
        title: rentable.title,
        categoryId: rentable.categoryId,
        capacity: rentable.capacity,
        bedrooms: rentable.bedrooms,
        exactAddress: rentable.exactAddress,
        location: rentable.location,
        houseRules: rentable.houseRules,
      })
      .from(rentable)
      .where(eq(rentable.id, listing.id))
      .for('update');
    const [owner] = await tx.select({ status: users.accountStatus }).from(users).where(eq(users.id, listing.clientId)).for('share');
    if (!owner || (owner.status !== 'active' && !(owner.status === 'pending_application' && current.status === 'draft'))) throw notFound();
    assertVersion(current.contentVersion, expected);
    // Pressing Save without changing anything must not take a live property out of search.
    const touchesTrust =
      trustChanges(current, fields, changed.filter((f) => TRUST_FIELDS.has(f))).length > 0;
    // Child rows (amenities) are written under the same lock, after the check.
    if (children) await children(tx);
    const effect = ownerEditEffect(current, touchesTrust);
    const [updated] = await tx
      .update(rentable)
      .set({ ...fields, ...effect.patch, updatedAt: new Date() })
      .where(eq(rentable.id, listing.id))
      .returning({ contentVersion: rentable.contentVersion });
    return { sentBack: effect.sentBack, contentVersion: updated.contentVersion };
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

  return { sentBack, contentVersion };
}

/* ------------------------------ create ------------------------------ */

export async function createListingFromBasics(_prev, formData) {
  const user = await requireClient();
  if(!formData.has('vertical')){const [category]=await sql`SELECT vertical_code FROM category WHERE id=${String(formData.get('categoryId'))}`;if(category)formData.set('vertical',category.vertical_code);}
  const parsed = listingStartSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const [choice] = await sql`SELECT c.* FROM category c JOIN vertical v ON v.code=c.vertical_code
    WHERE c.id=${parsed.data.categoryId} AND c.is_active AND v.status IN ('partners','public') AND c.vertical_code=${parsed.data.vertical}`;
  if (!choice) return { errors: { categoryId: 'Choose an available category for this property type' } };
  const legacy=formData.has('title')?basicsSchema.safeParse(Object.fromEntries(formData)):null;
  if(legacy&&!legacy.success)return {errors:fieldErrors(legacy.error)};
  if(legacy){const [area]=await sql`SELECT a.id FROM area a JOIN city c ON c.id=a.city_id WHERE a.id=${String(formData.get('areaId'))} AND c.id=${String(formData.get('cityId'))} AND a.is_active AND c.is_active`;if(!area)return {errors:{areaId:'Choose an available area in this city'}};}
  const row = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${user.id + ':new-property'},0))`;
    const [existing] = await tx`SELECT id FROM rentable WHERE client_id=${user.id} AND status='draft' AND title='' AND category_id=${choice.id} AND created_at>now()-interval '10 minutes' ORDER BY created_at DESC LIMIT 1`;
    if (existing) return existing;
    const code=publicCode();
    const [created]=await tx`INSERT INTO rentable(client_id,title,slug,public_code,status,form,fulfilment,rental_unit,category_id,booking_config,city_id,area_id,description,highlight)
      VALUES (${user.id},${legacy?.data.title||''},${legacy?slugify(legacy.data.title)+'-'+code:'untitled-'+code},${code},'draft',${choice.form},${choice.form==='fixed'?'visit_site':'pickup_from_owner'},${choice.default_rental_unit},${choice.id},${JSON.stringify(choice.default_rental_unit==='hour'?{model:'hourly',timeZone:'Asia/Kolkata',leadTimeMinutes:30,bookingHorizonDays:90,stepMinutes:60,minDurationMinutes:60,maxDurationMinutes:180,bufferBeforeMinutes:0,bufferAfterMinutes:0,weeklyHours:Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day=>[day,[{open:'08:00',close:'22:00',closesNextDay:false}]]))}:null)}::text::jsonb,${legacy?String(formData.get('cityId')):null},${legacy?String(formData.get('areaId')):null},${legacy?.data.description||null},${legacy?.data.highlight||null}) RETURNING id`;
    return created;
  });
  redirect(`/partner/listings/${row.id}/setup/location`);
}

/* ------------------------------ sections ------------------------------ */

export async function saveBasics(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const autosave=formData.get('autosave')==='1';
  if(autosave){ const [booking]=await sql`SELECT 1 FROM booking WHERE rentable_id=${listing.id} LIMIT 1`; if(!['draft','rejected'].includes(listing.status)||booking)throw conflict('EXPLICIT_SAVE_REQUIRED','Use Save for properties with bookings');}
  const schema=autosave?basicsSchema.extend({title:z.string().trim().max(90),description:z.string().trim().max(4000)}):basicsSchema;
  const parsed = schema.safeParse({
    categoryId: formData.get('categoryId'),
    title: formData.get('title'),
    description: formData.get('description'),
    highlight: formData.get('highlight') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;
  // A listing stays in its vertical; within it the category's booking model is copied again.
  const [choice] = await sql`SELECT c.form::text AS form, c.default_rental_unit::text AS rental_unit,
      c.vertical_code = (SELECT oc.vertical_code FROM rentable r JOIN category oc ON oc.id = r.category_id WHERE r.id = ${listing.id}) AS same_vertical
    FROM category c WHERE c.id = ${d.categoryId} AND c.is_active`;
  if (!choice) return { errors: { categoryId: 'Choose an available category' } };
  if (!choice.same_vertical) return { errors: { categoryId: 'A listing cannot move to another kind of place. Create a new listing instead.' } };
  const { sentBack, contentVersion } = await applyEdit(listing, {
    categoryId: d.categoryId,
    form: choice.form,
    fulfilment: choice.form === 'fixed' ? 'visit_site' : 'pickup_from_owner',
    rentalUnit: choice.rental_unit,
    title: d.title,
    // The slug follows the title, but the URL resolves by publicCode, so
    // retitling never breaks a link.
    slug: `${slugify(d.title)}-${listing.publicCode}`,
    description: d.description,
    highlight: d.highlight || null,
  }, ['categoryId', 'title'], { expected: expectedVersion(formData) });

  return { ok: true, contentVersion, sentBack };
}

export async function saveLocation(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  const parsed = locationSchema.safeParse({
    cityId: formData.get('cityId'),
    areaId: formData.get('areaId'),
    lat: formData.get('lat'),
    lng: formData.get('lng'),
    exactAddress: formData.get('exactAddress'),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const d = parsed.data;
  const [valid] = await sql`SELECT a.id FROM area a JOIN city c ON c.id=a.city_id WHERE a.id=${d.areaId} AND c.id=${d.cityId} AND a.is_active AND c.is_active`;
  if (!valid) return {errors:{areaId:'Choose an available area in this city'}};
  const { sentBack, contentVersion } = await applyEdit(listing, {
    cityId: d.cityId,
    areaId: d.areaId,
    location: { x: d.lng, y: d.lat },
    exactAddress: d.exactAddress,
  }, ['location', 'exactAddress'], { expected: expectedVersion(formData) });

  return { ok: true, contentVersion, sentBack };
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
  const { sentBack, contentVersion } = await applyEdit(listing, {
    capacity: d.capacity,
    bedrooms: d.bedrooms,
    farmSize: d.farmSize || null,
    farmSizeUnit: d.farmSizeUnit,
    poolSize: d.poolSize || null,
  }, ['capacity', 'bedrooms'], { expected: expectedVersion(formData) });

  return { ok: true, contentVersion, sentBack };
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
  const key = (list) => list.map((r) => `${r.amenityId}=${r.value ?? ''}`).sort().join('|');
  const stored = await sql`SELECT amenity_id::text AS "amenityId",value FROM rentable_amenity WHERE rentable_id=${listing.id}`;
  const { sentBack, contentVersion } = await applyEdit(listing, {}, key(stored) === key(rows) ? [] : ['amenities'], {
    expected: expectedVersion(formData),
    children: async (tx) => {
      await tx.delete(rentableAmenity).where(eq(rentableAmenity.rentableId, listing.id));
      if (rows.length) await tx.insert(rentableAmenity).values(rows);
    },
  });
  return { ok: true, contentVersion, sentBack, count: rows.length };
}

export async function saveRules(_prev, formData) {
  const { listing } = await load(String(formData.get('id')));
  if (formData.get('wizardRules')==='1') { const terms=termsSchema.safeParse(Object.fromEntries(formData)); if (!terms.success) return {errors:fieldErrors(terms.error)}; if(formData.get('cancellationConfirmed')!=='on') return {errors:{cancellationConfirmed:'Confirm your cancellation policy'}}; }
  if (listing.rentalUnit === 'hour') return saveVenueRules(listing, formData);
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
    cancellationConfirmed: formData.get('wizardRules')==='1' ? true : listing.houseRules?.cancellationConfirmed,
  };

  const { sentBack, contentVersion } = await applyEdit(listing, {
    checkInFrom: d.checkInFrom,
    checkOutBy: d.checkOutBy,
    houseRules,
    ...(formData.get('wizardRules')==='1'?{depositMinor:termsSchema.parse(Object.fromEntries(formData)).depositAmount*100,cancellationTier:termsSchema.parse(Object.fromEntries(formData)).cancellationTier,bookingConfigVersion:raw`${rentable.bookingConfigVersion}+1`}:{}),
  }, ['houseRules'], { expected: expectedVersion(formData) });

  return { ok: true, contentVersion, sentBack };
}

/** Venue rules: what players wear, age, food, smoking, alcohol, notes. No check-in window. */
async function saveVenueRules(listing, formData) {
  const parsed = venueRulesSchema.safeParse({
    footwear: formData.get('footwear') ?? '',
    minAge: formData.get('minAge') ?? '',
    foodAllowed: formData.get('foodAllowed') ?? 'yes',
    smokingAllowed: formData.get('smokingAllowed') ?? 'no',
    alcoholAllowed: formData.get('alcoholAllowed') ?? 'no',
    extraRules: formData.get('extraRules') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const d = parsed.data;
  const houseRules = {
    footwear: d.footwear || null,
    minAge: d.minAge === '' ? null : d.minAge,
    foodAllowed: d.foodAllowed,
    smokingAllowed: d.smokingAllowed === 'yes',
    alcoholAllowed: d.alcoholAllowed === 'yes',
    notes: d.extraRules || null,
    cancellationConfirmed: formData.get('wizardRules')==='1' ? true : listing.houseRules?.cancellationConfirmed,
  };
  const { sentBack, contentVersion } = await applyEdit(listing, { houseRules, ...(formData.get('wizardRules')==='1'?{depositMinor:termsSchema.parse(Object.fromEntries(formData)).depositAmount*100,cancellationTier:termsSchema.parse(Object.fromEntries(formData)).cancellationTier,bookingConfigVersion:raw`${rentable.bookingConfigVersion}+1`}:{}) }, ['houseRules'], { expected: expectedVersion(formData) });
  return { ok: true, contentVersion, sentBack };
}

/** Owner forms send structured lists (courts, rate bands) as one JSON field. */
function jsonField(formData, key) {
  try {
    return JSON.parse(String(formData.get(key) ?? ''));
  } catch {
    throw unprocessable({ [key]: ['Send the list as JSON.'] });
  }
}

async function policyAction(formData, command) {
  const user = await requireClient();
  const data = await getListingForEdit(String(formData.get('id')),user.id);
  if(!data) throw notFound();
  const {listing}=data;
  const [model] = await sql`SELECT rental_unit::text AS unit FROM rentable WHERE id=${listing.id}`;
  if (command === 'pricing' && model?.unit === 'hour') {
    // Time-booked venue: hourly bands per activity instead of slot prices.
    const result = await changeHourlyRates(sql, user.id, listing.id, {
      rates: jsonField(formData, 'rates'), expectedVersion: Number(formData.get('contentVersion')),
      direct: formData.get('direct')==='true', autosave:formData.get('autosave')==='1',preview: formData.get('mode') === 'preview', previewToken: formData.get('previewToken'),
    });
    if (result.ok) revalidateListing(listing);
    return result;
  }
  const keys = command === 'pricing' ? ['day_weekday','day_weekend','night_weekday','night_weekend','full_day_weekday','full_day_weekend','extraGuestCharge','extraHourCharge','includedGuests'] : ['depositAmount','cancellationTier'];
  const result = await changePropertyPolicy(sql,user.id,listing.id,command,{
    values:Object.fromEntries(keys.filter(key=>key!=='includedGuests'||formData.has(key)).map(key=>[key,formData.get(key)||0])),
    expectedVersion:Number(formData.get('contentVersion')),direct:formData.get('direct')==='true',autosave:formData.get('autosave')==='1',preview:formData.get('mode')==='preview',previewToken:formData.get('previewToken'),
  });
  if(result.ok) revalidateListing(listing);
  return result;
}
export async function savePricing(_prev, formData) { return policyAction(formData,'pricing'); }

/** Courts, lanes and stations of a time-booked venue (wizard step `venue`). */
export async function saveVenue(_prev, formData) {
  const user = await requireClient();
  const data = await getListingForEdit(String(formData.get('id')), user.id);
  if (!data) throw notFound();
  const result = await saveVenueResources(sql, user.id, {
    rentableId: data.listing.id, expectedVersion: Number(formData.get('contentVersion')), resources: jsonField(formData, 'resources'),
  });
  revalidateListing(data.listing);
  return result;
}
export async function saveTerms(_prev, formData) { return policyAction(formData,'terms'); }

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
    if (file.size > 8*1024*1024) {
      return { errors: { photos: `${file.name} is over 8MB` } };
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

  const { sentBack, contentVersion } = await applyEdit(
    listing, { photos: [...photos, ...added] }, ['photos'], { expected: expectedVersion(formData) },
  );

  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: listing.id, action: 'listing_photos_added',
    after: { count: added.length, total: photos.length + added.length },
    ip: await clientIp(),
  });

  return { ok: true, contentVersion, sentBack, added: added.length };
}

export async function removeListingPhoto(_prev, formData) {
  const { listing, photos } = await load(String(formData.get('id')));
  const key = String(formData.get('key'));

  // photoId, not p.key: seeded and imported photos carry a `url` instead, and
  // matching on `key` alone silently removed nothing at all from those.
  const next = photos.filter((p) => photoId(p) !== key);
  if (next.length === photos.length) return { errors: { _: 'That photo is already gone.' } };

  const { sentBack, contentVersion } = await applyEdit(
    listing, { photos: renumberPhotos(next, listing.title) }, [],
    { expected: expectedVersion(formData) ?? listing.contentVersion },
  );
  if(key.startsWith(`rentra/listings/${listing.id}/`)) await destroyListingPhoto(key).catch(()=>null);
  return { ok: true, contentVersion, sentBack, remaining: next.length };
}

/**
 * Reorder, and promote a photo to the cover.
 *
 * Uses `applyEdit`'s version check without marking a trust-field change. `photos` is a trust field
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
  const {contentVersion}=await applyEdit(listing,{photos:renumberPhotos(next,listing.title)},[],{expected:expectedVersion(formData) ?? listing.contentVersion});
  await audit({
    actorType: 'client', actorId: user.id, entity: 'rentable',
    entityId: listing.id, action: 'listing_photos_reordered',
    before: { cover: photoId(photos[0]) },
    after: { cover: photoId(next[0]), moved: key, from: result.from, to: result.to },
    ip: await clientIp(),
  });

  return { ok: true, contentVersion, cover: photoId(next[0]) };
}

/* --------------------------- ownership proof --------------------------- */

/**
 * THE gate. Name-matching this document against the Client's KYC name is what
 * keeps brokers from posting as owners — the single check that makes a Rentra
 * listing worth more than a classified ad.
 */
export async function uploadOwnershipDocument(_prev, formData) {
  const { user, listing } = await load(String(formData.get('id')));

  // The setup walkthrough's Continue submits this form; with no new file and a
  // document already on record, there is nothing to upload.
  // Only when the form still describes that same document, so an edited type or
  // name is never reported as saved without the file it refers to.
  const chosen = formData.get('file');
  if (!chosen || chosen.size === 0) {
    const [kept] = await sql`SELECT 1 FROM document WHERE owner_type='rentable' AND owner_id=${listing.id}
      AND status IN ('uploaded','accepted') AND deleted_at IS NULL
      AND doc_type=${String(formData.get('docType') ?? '')}
      AND coalesce(name_on_document,'')=${String(formData.get('nameOnDocument') ?? '').trim()} LIMIT 1`;
    if (kept) return { ok: true, unchanged: true };
  }

  if (!isCloudinaryConfigured()) {
    return { errors: { _: 'Document upload is not configured on this server yet.' } };
  }

  const parsed = ownershipDocSchema.safeParse({
    docType: formData.get('docType'),
    nameOnDocument: formData.get('nameOnDocument'),
    issuedAt: formData.get('issuedAt') ?? '',
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  // A venue proves a lease or business; a farmhouse proves land. Each takes only its own list.
  if (!ownershipDocTypesFor(listing.rentalUnit).some((type) => type.id === parsed.data.docType))
    return { errors: { docType: 'Choose one of the listed documents' } };

  if (parsed.data.docType==='electricity_bill') {
    const issued=new Date(parsed.data.issuedAt+'T00:00:00Z'), today=new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z'), cutoff=new Date(today); cutoff.setUTCMonth(cutoff.getUTCMonth()-3);
    if (!parsed.data.issuedAt || !Number.isFinite(+issued) || issued.toISOString().slice(0,10)!==parsed.data.issuedAt || issued<cutoff || issued>today) return {errors:{issuedAt:'Use an electricity bill issued within the last 3 months'}};
  }
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
    // A new file per upload: the superseded version keeps pointing at its own bytes.
    publicId: `${d.docType}_${randomUUID()}`,
  });

  // The reviewer sets nameMatch — we only record what the Client typed. The previous
  // live file and its review stay on record as superseded.
  await db.transaction(async (tx) => {
    // Serialise uploads to one slot so two tabs cannot both supersede and insert.
    await tx.execute(raw`SELECT pg_advisory_xact_lock(hashtextextended(${`document:${listing.id}:${d.docType}:single`}, 0))`);
    await tx.update(documents).set({ status: 'superseded' }).where(and(
      eq(documents.ownerType, 'rentable'),
      eq(documents.ownerId, listing.id),
      eq(documents.docType, d.docType),
      eq(documents.side, 'single'),
      inArray(documents.status, ['uploaded', 'accepted', 'rejected']),
      isNull(documents.deletedAt),
    ));
    await tx.insert(documents).values({
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
    });
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
  redirect(`/partner/listings/${listing.id}/submitted`);
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

export async function saveType(_prev, form) {
 const {listing}=await load(String(form.get('id')));
 const [choice]=await sql`SELECT c.id FROM category c WHERE c.id=${String(form.get('categoryId'))} AND c.is_active AND c.vertical_code=(SELECT oc.vertical_code FROM rentable r JOIN category oc ON oc.id=r.category_id WHERE r.id=${listing.id}) AND c.default_rental_unit=${listing.rentalUnit}`;
 if(!choice) return {errors:{categoryId:'Choose an available category for this property'}};
 return {ok:true,...await applyEdit(listing,{categoryId:choice.id},['categoryId'],{expected:expectedVersion(form)})};
}
export async function deleteDraft(_prev, form) {
 const {user,listing}=await load(String(form.get('id')));
 await sql.begin(async tx=> {
  const [current]=await tx`SELECT status FROM rentable WHERE id=${listing.id} AND client_id=${user.id} FOR UPDATE`;
  const [history]=await tx`SELECT 1 FROM listing_review WHERE rentable_id=${listing.id} UNION ALL SELECT 1 FROM listing_submission WHERE rentable_id=${listing.id} UNION ALL SELECT 1 FROM booking WHERE rentable_id=${listing.id} LIMIT 1`;
  if(current.status!=='draft'||history) throw conflict('DRAFT_ONLY','Only a draft that has never been submitted or booked can be deleted');
  await tx`DELETE FROM rentable WHERE id=${listing.id}`;
 });
 redirect('/partner/listings');
}

export async function signPhoto(_previous,form){const {listing}=await load(String(form.get('id'))); return signListingPhoto(listing.id,randomUUID());}
export async function attachPhoto(_previous,form){
 const {listing}=await load(String(form.get('id'))),key=String(form.get('publicId'));
 if(!key.startsWith(`rentra/listings/${listing.id}/`)||!/^rentra\/listings\/[a-f0-9-]+\/[a-f0-9-]+$/.test(key)) throw notFound();
 const asset=await listingPhotoAsset(key);
 if(!['jpg','jpeg','png','webp'].includes(asset.format)||asset.bytes>8*1024*1024||asset.type!=='upload')return {errors:{photos:'Choose a JPG, PNG or WEBP under 8MB'}};
 const current=await getListingForEdit(listing.id,listing.clientId);
 if(current.photos.some(p=>p.key===key))return {ok:true,contentVersion:current.listing.contentVersion};
 if(current.photos.length>=MAX_PHOTOS)return {errors:{photos:'15 of 15 — remove one to add another'}};
 const hash=String(form.get('hash')||'');
 if(current.photos.some(p=>hash&&p.hash===hash)){await destroyListingPhoto(key);return {ok:true,duplicate:true,contentVersion:current.listing.contentVersion};}
 const photo={key,alt:listing.title,width:asset.width,height:asset.height,tag:String(form.get('tag')||'Other').slice(0,40),hash:hash.slice(0,64)};
 return {ok:true,...await applyEdit(listing,{photos:[...current.photos,photo]},['photos'],{expected:expectedVersion(form) ?? current.listing.contentVersion})};
}
