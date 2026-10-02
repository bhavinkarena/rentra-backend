import { listingCompletion } from '../services/domain/listing-completion.js';
import { saveType, deleteDraft, signPhoto, attachPhoto } from '../services/auth/listings.js';
import { getListingByCode } from '../services/db/queries.js';
import { saveBookingConfiguration } from '../services/booking/owner-settings.js';
import { visitMoneyMinor } from '../services/domain/booking-money.js';
import { z } from 'zod';
import { unprocessable } from '../utils/apiError.js';
import {
  createListingFromBasics,
  saveBasics,
  saveLocation,
  saveCapacity,
  saveAmenities,
  saveRules,
  savePricing,
  saveVenue,
  saveTerms,
  uploadListingPhotos,
  removeListingPhoto,
  reorderListingPhotos,
  uploadOwnershipDocument,
  submitListing,
  toggleListingPause,
} from '@/services/auth/listings.js';
import {
  getClientListingSummary,
  getClientListingsPage,
  getListingForEdit,
  getAmenityCatalogue,
  getCategories,
  getPartnerVerticals,
  getCitiesWithAreas,
} from '@/services/db/listing-queries.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { notFound } from '@/utils/apiError.js';
import { propertyReviewContext } from '@/services/admin/listings.js';
import { ownerPropertyOverview } from '@/services/auth/property-overview.js';
import { propertyPolicyHistory } from '@/services/booking/property-policy.js';
import { sql } from '@/config/database.js';

/** The partner's own listings. Ownership is enforced by passing the client id. */
export const summary = asyncHandler(async (req, res) =>
  ok(res, await getClientListingSummary(req.user.id)),
);

export const page = asyncHandler(async (req, res) =>
  ok(res, await getClientListingsPage(req.user.id, req.valid?.query ?? req.query)),
);

/**
 * Passing the owner id is what makes this safe: the query filters on it, so a
 * Client requesting another Client's listing id gets nothing back rather than
 * someone else's address and payout details.
 */
export const detail = asyncHandler(async (req, res) => {
  const listing = await getListingForEdit(req.params.id, req.user.id);
  if (!listing) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
  const review = await propertyReviewContext(sql, req.params.id);
  listing.listing.reviewNeedsResubmission = review?.needsResubmission ?? false;
  listing.listing.reviewFlaggedFields = listing.reviews.at(-1)?.flaggedFields ?? [];
  listing.listing.reviewOutcome = listing.reviews.at(-1)?.outcome ?? null;
  listing.listing.reviewVerification = review?.verification ?? null;
  listing.listing.restriction = review?.restriction ?? null;
  listing.listing.adminCorrection = review?.correction ?? null;
  // Which operator acted stays internal.
  delete listing.listing.restrictedBy;
  listing.listing.policyHistory = await propertyPolicyHistory(sql, req.user.id, req.params.id);
  listing.review = review;
  listing.listing.completion = listingCompletion(listing.listing, listing);
  return ok(res, listing);
});

/** Reference data the wizard needs. Public, cacheable, no actor involved. */
/** Operations overview (CP09): inventory, upcoming visits, client-safe activity. */
export const overview = asyncHandler(async (req, res) => {
  const data = await ownerPropertyOverview(sql, req.user.id, req.params.id);
  if (!data) throw notFound('LISTING_NOT_FOUND', 'That listing does not exist.');
  return ok(res, data);
});

const verticalQuery = (req) =>
  /^[a-z][a-z0-9_]{0,23}$/.test(String(req.query.vertical ?? ''))
    ? String(req.query.vertical)
    : null;
export const amenities = asyncHandler(async (req, res) =>
  ok(res, await getAmenityCatalogue({ vertical: verticalQuery(req) })),
);
export const categories = asyncHandler(async (req, res) =>
  ok(res, await getCategories({ vertical: verticalQuery(req) })),
);
export const verticals = asyncHandler(async (_req, res) => ok(res, await getPartnerVerticals()));
export const places = asyncHandler(async (_req, res) => ok(res, await getCitiesWithAreas()));

/** The wizard, one step per route. Each step is independently saveable. */
export const create = runAction(createListingFromBasics);
export const basics = runAction(saveBasics);
export const location = runAction(saveLocation);
export const capacity = runAction(saveCapacity);
export const amenitiesStep = runAction(saveAmenities);
export const rules = runAction(saveRules);
export const venue = policyAction(saveVenue);
function policyAction(action) {
  const handler = runAction(action);
  return (req, res, next) => {
    req.body = { ...req.body, id: req.params.id };
    return handler(req, res, next);
  };
}
export const pricing = policyAction(savePricing);
export const terms = policyAction(saveTerms);
export const addPhotos = runAction(uploadListingPhotos);
export const removePhoto = runAction(removeListingPhoto);
export const reorderPhotos = runAction(reorderListingPhotos);
export const ownershipDocument = runAction(uploadOwnershipDocument);
const submitAction = runAction(submitListing);
export const submit = (req, res, next) => {
  req.body = { ...req.body, id: req.params.id };
  return submitAction(req, res, next);
};
export const togglePause = runAction(toggleListingPause);

export const type = runAction(saveType);
export const removeDraft = runAction(deleteDraft);
export const previewData = asyncHandler(async (req, res) => {
  const data = await getListingForEdit(req.params.id, req.user.id);
  if (!data) throw notFound();
  const dto = await getListingByCode(data.listing.publicCode, req.user.id);
  return ok(res, dto);
});
export const availability = asyncHandler(async (req, res) => {
  const input = z
    .object({
      configuration: z.string().max(20000),
      expectedVersion: z.coerce.number().int().nonnegative(),
    })
    .parse(req.body);
  let configuration;
  try {
    configuration = JSON.parse(input.configuration);
  } catch {
    throw unprocessable({ configuration: ['Check the availability settings and try again'] });
  }
  const result = await saveBookingConfiguration(sql, req.user.id, {
    rentableId: req.params.id,
    expectedVersion: input.expectedVersion,
    configuration,
  });
  const data = await getListingForEdit(req.params.id, req.user.id);
  return ok(res, { ok: true, contentVersion: data.listing.contentVersion, ...result });
});
export const pricePreview = asyncHandler(async (req, res) => {
  const data = await getListingForEdit(req.params.id, req.user.id);
  if (!data) throw notFound();
  const input = z
    .object({ rentMinor: z.coerce.number().int().min(0).max(50000000) })
    .parse(req.body);
  return ok(res, visitMoneyMinor({ baseRentMinor: input.rentMinor, depositMinor: 0 }));
});

export const photoSign = policyAction(signPhoto);
export const photoAttach = policyAction(attachPhoto);
