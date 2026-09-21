import { z } from 'zod';
import { slotEnum, cancellationTierEnum } from './booking';

export const slotPriceSchema = z.object({
  slot: slotEnum,
  weekday: z.coerce.number().int().min(500).max(500000),
  weekend: z.coerce.number().int().min(500).max(500000),
});

export const listingDraftSchema = z.object({
  title: z.string().trim().min(8, 'At least 8 characters').max(90),
  description: z.string().trim().min(40, 'Tell guests a bit more').max(4000),

  // The three columns that keep goods rental a feature and not a rewrite.
  form: z.enum(['fixed', 'movable']).default('fixed'),
  fulfilment: z
    .enum(['visit_site', 'pickup_from_owner', 'delivered'])
    .default('visit_site'),
  rentalUnit: z.enum(['slot', 'night', 'day', 'week', 'month']).default('slot'),

  categoryId: z.string().min(1),
  cityId: z.string().min(1),
  areaId: z.string().min(1),
  totalUnits: z.coerce.number().int().min(1).default(1),

  capacity: z.coerce.number().int().min(1).max(1000),
  bedrooms: z.coerce.number().int().min(0).max(50).default(0),
  amenities: z.array(z.string()).max(40).default([]),
  houseRules: z.array(z.string()).max(30).default([]),

  prices: z.array(slotPriceSchema).min(1, 'Set a price for at least one slot'),
  deposit: z.coerce.number().int().min(0).max(200000).default(0),
  cancellationTier: cancellationTierEnum.default('moderate'),

  photos: z.array(z.string().url()).min(6, 'At least 6 photos').max(15),
});

/** Public search params. Kept loose on purpose — a bad URL should not 500. */
export const searchParamsSchema = z.object({
  city: z.string().trim().max(60).optional(),
  area: z.string().trim().max(60).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  slot: slotEnum.optional(),
  guests: z.coerce.number().int().min(1).max(500).optional(),
  min: z.coerce.number().int().min(0).optional(),
  max: z.coerce.number().int().min(0).optional(),
  amenities: z.union([z.string(), z.array(z.string())]).optional(),
  sort: z.enum(['price_asc', 'price_desc', 'rating', 'recent']).optional(),
});

/* ==========================================================================
   Per-section schemas for the listing builder.
   Each section validates alone, so a draft can be saved half-finished.
   ========================================================================== */

export const basicsSchema = z.object({
  categoryId: z.string().uuid('Choose a category'),
  title: z.string().trim().min(8, 'At least 8 characters').max(90),
  description: z.string().trim().min(40, 'Tell guests a bit more — 40 characters minimum').max(4000),
  highlight: z.string().trim().max(60).optional().or(z.literal('')),
});

/**
 * The minimum real data needed to create a property workspace.
 *
 * City and area live here as well as on the detailed location step because
 * both foreign keys are required by the database. Asking for them is honest;
 * silently borrowing seeded values would store a place the owner never chose.
 */
export const listingStartSchema = basicsSchema.extend({
  cityId: z.string().uuid('Choose a city'),
  areaId: z.string().uuid('Choose an area'),
});

export const locationSchema = z.object({
  cityId: z.string().uuid('Choose a city'),
  areaId: z.string().uuid('Choose an area'),
  lat: z.coerce.number().min(6).max(37, 'Pin must be inside India'),
  lng: z.coerce.number().min(68).max(98, 'Pin must be inside India'),
  exactAddress: z.string().trim().min(10, 'Give the full address').max(500),
  approachNote: z.string().trim().max(300).optional().or(z.literal('')),
});

export const capacitySchema = z.object({
  capacity: z.coerce.number().int().min(1, 'At least 1 guest').max(1000),
  bedrooms: z.coerce.number().int().min(0).max(50),
  farmSize: z.coerce.number().positive('Enter the land size'),
  farmSizeUnit: z.enum(['vigha', 'var', 'acre', 'sqft']),
  poolSize: z.string().trim().max(24).optional().or(z.literal('')),
});

export const amenitiesSchema = z.object({
  // Sent as repeated fields: amenity=<id>:<value?>
  amenity: z.union([z.string(), z.array(z.string())]).optional(),
});

export const rulesSchema = z.object({
  checkInFrom: z.string().trim().min(3, 'When can guests arrive?').max(32),
  checkOutBy: z.string().trim().min(3, 'When must they leave?').max(32),
  petsAllowed: z.enum(['yes', 'no']).default('no'),
  alcoholAllowed: z.enum(['yes', 'no']).default('no'),
  stagAllowed: z.enum(['yes', 'no', 'on_request']).default('on_request'),
  musicCutoff: z.string().trim().max(20).optional().or(z.literal('')),
  extraRules: z.string().trim().max(1000).optional().or(z.literal('')),
});

const rupees = z.coerce.number().int().min(0).max(500000);

export const pricingSchema = z.object({
  day_weekday: rupees, day_weekend: rupees,
  night_weekday: rupees, night_weekend: rupees,
  full_day_weekday: rupees, full_day_weekend: rupees,
  extraGuestCharge: rupees.optional(),
  extraHourCharge: rupees.optional(),
}).refine(
  (d) => [d.day_weekday, d.day_weekend, d.night_weekday,
    d.night_weekend, d.full_day_weekday, d.full_day_weekend].some((v) => v > 0),
  { message: 'Price at least one slot', path: ['day_weekday'] },
);

export const termsSchema = z.object({
  depositAmount: rupees,
  cancellationTier: cancellationTierEnum,
});

export const ownershipDocSchema = z.object({
  docType: z.enum([
    'extract_7_12', 'electricity_bill', 'property_tax', 'index_ii',
    'extract_8a', 'sale_deed', 'authorisation_letter',
  ]),
  nameOnDocument: z.string().trim().min(3, 'Enter the name printed on it').max(160),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'When was it issued?').optional().or(z.literal('')),
});
