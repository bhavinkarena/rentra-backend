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
  title: z.string().trim().min(8, "Use at least 8 characters — e.g. 'Riverside farmhouse with pool'").max(90),
  description: z.string().trim().min(40, {
      error: (issue) => `Add a little more — ${40 - (issue.input?.length ?? 0)} more characters`,
    }).max(4000),
  highlight: z.string().trim().max(60).optional().or(z.literal('')),
});

/**
 * The minimum real data needed to create a property workspace.
 *
 * City and area live here as well as on the detailed location step because
 * both foreign keys are required by the database. Asking for them is honest;
 * silently borrowing seeded values would store a place the owner never chose.
 */
export const listingStartSchema = z.object({vertical:z.enum(['farmhouse','entertainment']), categoryId:z.string().uuid('Choose a category')});

export const locationSchema = z.object({
  cityId: z.string().uuid('Choose a city'),
  areaId: z.string().uuid('Choose an area'),
  lat: z.coerce.number().min(6, 'Drop the pin on your property in India').max(37, 'The pin must be in India'),
  lng: z.coerce.number().min(68, 'Drop the pin on your property in India').max(98, 'The pin must be in India'),
  exactAddress: z.string().trim().min(10, 'Give the full address').max(500),
});

export const capacitySchema = z.object({
  capacity: z.coerce.number('How many guests can visit at once?').int().min(1, 'How many guests can visit at once?').max(1000),
  bedrooms: z.coerce.number().int().min(0).max(50),
  farmSize: z.coerce.number().min(0).optional(),
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

/** Venue rules (time-booked listings). Structured, like house rules; notes go through moderation. */
export const venueRulesSchema = z.object({
  footwear: z.enum(['non_marking', 'no_studs', 'studs_ok', 'any', '']).default(''),
  minAge: z.union([z.literal(''), z.coerce.number().int().min(1).max(99)]).default(''),
  foodAllowed: z.enum(['yes', 'no', 'seating_only']).default('yes'),
  smokingAllowed: z.enum(['yes', 'no']).default('no'),
  alcoholAllowed: z.enum(['yes', 'no']).default('no'),
  extraRules: z.string().trim().max(1000).optional().or(z.literal('')),
}).refine((d) => d.footwear || d.extraRules, { message: 'Say what players should wear, or add a rule', path: ['footwear'] });

const rupees = z.preprocess(v=>typeof v==='string'?v.replace(/[\u20b9,\s]/g,''):v,z.coerce.number('Enter a price in rupees, e.g. 4500').int().min(0).max(500000));

export const pricingSchema = z.object({
  day_weekday: rupees, day_weekend: rupees,
  night_weekday: rupees, night_weekend: rupees,
  full_day_weekday: rupees, full_day_weekend: rupees,
  extraGuestCharge: rupees.optional(),
  includedGuests:z.coerce.number().int().min(1).max(500).optional(),
  extraHourCharge: rupees.optional(),
}).refine(
  (d) => [d.day_weekday, d.day_weekend, d.night_weekday,
    d.night_weekend, d.full_day_weekday, d.full_day_weekend].some((v) => v > 0),
  { message: 'Price at least one slot', path: ['day_weekday'] },
).superRefine((d, ctx) => {
  // A zero side would be quoted to guests as ₹0, so an offered slot needs both.
  for (const slot of ['day', 'night', 'full_day']) {
    const [weekday, weekend] = [d[`${slot}_weekday`], d[`${slot}_weekend`]];
    if ((weekday > 0 && weekday < 500) || (weekend > 0 && weekend < 500)) ctx.addIssue({code:'custom',path:[`${slot}_weekday`],message:'Offer this slot from 500 rupees, or turn it off'});
    if ((weekday > 0) !== (weekend > 0))
      ctx.addIssue({
        code: 'custom',
        path: [`${slot}_${weekday > 0 ? 'weekend' : 'weekday'}`],
        message: 'Enter both weekday and weekend prices, or leave both at 0 if you do not offer this slot',
      });
  }
});

export const termsSchema = z.object({
  depositAmount: rupees,
  cancellationTier: cancellationTierEnum,
});

export const ownershipDocSchema = z.object({
  docType: z.enum([
    'extract_7_12', 'electricity_bill', 'property_tax', 'index_ii',
    'extract_8a', 'sale_deed', 'authorisation_letter',
    // Venues (often leased commercial premises).
    'rent_agreement', 'shop_establishment', 'gst_certificate', 'noc',
  ]),
  nameOnDocument: z.string().trim().min(3, 'Enter the name printed on it').max(160),
  issuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'When was it issued?').optional().or(z.literal('')),
});

/* --------------- time-booked venues (entertainment plan, Phase 4) --------------- */
const activitySlug = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

/** One court, lane, turf or station. `id` present = an existing resource. */
export const venueResourceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name each court').max(60),
  capacity: z.number().int().min(1).max(500),
  isIndoor: z.boolean().nullable().default(null),
  details: z.object({
    size: z.string().trim().max(40).optional(),
    surface: z.string().trim().max(40).optional(),
    format: z.string().trim().max(40).optional(),
    equipment: z.string().trim().max(60).optional(),
  }).strict().default({}),
  activities: z.array(activitySlug).min(1, 'Choose at least one activity').max(10),
  sortOrder: z.number().int().min(0).max(1000),
  isActive: z.boolean().default(true),
}).strict();

export const venueResourcesSchema = z.object({
  resources: z.array(venueResourceSchema).min(1, 'Add at least one court').max(30),
}).strict().superRefine((value, ctx) => {
  const names = value.resources.map((row) => row.name.toLowerCase());
  names.forEach((name, index) => {
    if (names.indexOf(name) !== index) ctx.addIssue({ code: 'custom', path: ['resources', index, 'name'], message: 'Each court needs a different name' });
  });
});

/** One hourly band: activity × weekday/weekend × [from, to). `toNextDay` for bands past midnight. */
export const hourlyRateSchema = z.object({
  activity: activitySlug,
  dayKind: z.enum(['weekday', 'weekend']),
  from: clock,
  to: clock,
  toNextDay: z.boolean().default(false),
  hourlyRate: z.number().int().min(0).max(500_000),
}).strict();

export const hourlyRatesSchema = z.object({
  rates: z.array(hourlyRateSchema).min(1, 'Add at least one price').max(100),
}).strict();
