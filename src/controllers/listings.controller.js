import {
  createListingFromBasics,
  saveBasics,
  saveLocation,
  saveCapacity,
  saveAmenities,
  saveRules,
  savePricing,
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
  getCitiesWithAreas,
} from '@/services/db/listing-queries.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';
import { notFound } from '@/utils/apiError.js';
import { propertyReviewContext } from '@/services/admin/listings.js';
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
  listing.review = review;
  return ok(res, listing);
});

/** Reference data the wizard needs. Public, cacheable, no actor involved. */
export const amenities = asyncHandler(async (_req, res) => ok(res, await getAmenityCatalogue()));
export const categories = asyncHandler(async (_req, res) => ok(res, await getCategories()));
export const places = asyncHandler(async (_req, res) => ok(res, await getCitiesWithAreas()));

/** The wizard, one step per route. Each step is independently saveable. */
export const create = runAction(createListingFromBasics);
export const basics = runAction(saveBasics);
export const location = runAction(saveLocation);
export const capacity = runAction(saveCapacity);
export const amenitiesStep = runAction(saveAmenities);
export const rules = runAction(saveRules);
export const pricing = runAction(savePricing);
export const terms = runAction(saveTerms);
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
