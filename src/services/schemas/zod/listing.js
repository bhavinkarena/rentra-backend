import { z } from 'zod';
import { slotEnum, cancellationTierEnum } from './booking';
import { cancellationPolicySchema } from '../../domain/cancellation-policy.js';
import { EXTRA_PLACE_TYPES, capacityShortfall, inclusionsProblem, resolveInclusions } from '../../domain/hotel-rooms.js';

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
export const listingStartSchema = z.object({vertical:z.enum(['farmhouse','entertainment','hotel']), categoryId:z.string().uuid('Choose a category')});

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
  // Story 2.6: the owner's percentage windows (JSON from the form); the tier is the preset it started from.
  cancellationPolicy: z.preprocess((v) => { if (typeof v !== 'string' || !v) return v || undefined; try { return JSON.parse(v); } catch { return 'invalid'; } }, cancellationPolicySchema.optional()),
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

/* --------------------------- hotels (hotel plan, Phase 3) --------------------------- */
const roomName = z.string().trim().min(1, 'Name each room type').max(60);
const wholeRupees = (min, max, label) => z.number({ error: `Enter ${label} in rupees` }).int(`Enter ${label} in whole rupees`).min(min, `${label} must be at least ₹${min}`).max(max, `${label} must be at most ₹${max.toLocaleString('en-IN')}`);
export const BED_TYPES = ['king', 'queen', 'double', 'single', 'sofa_bed', 'bunk'];
export const ROOM_VIEWS = ['city', 'garden', 'river', 'sea', 'pool', 'hill', 'courtyard'];

/** One room type. `id` present = an existing room type. Charges are whole rupees. */
export const hotelRoomSchema = z.object({
  id: z.string().uuid().optional(),
  name: roomName,
  beds: z.array(z.object({ type: z.enum(BED_TYPES), count: z.number().int().min(1).max(6) }).strict()).min(1, 'Add the beds').max(4),
  // Story 3.3: extra sleeping places are a physical promise, never a price.
  extraPlaces: z.array(z.object({ type: z.enum(EXTRA_PLACE_TYPES), count: z.number().int().min(1).max(4) }).strict()).max(2).default([]),
  sizeSqm: z.number().int().min(4).max(2000).nullable().default(null),
  view: z.enum(ROOM_VIEWS).nullable().default(null),
  maxAdults: z.number().int().min(1).max(12),
  maxChildren: z.number().int().min(0).max(12),
  maxOccupancy: z.number().int().min(1).max(16),
  baseOccupancy: z.number().int().min(1).max(16),
  roomCount: z.number().int().min(1, 'At least 1 room').max(500),
  extraAdult: wholeRupees(0, 50000, 'Extra adult charge'),
  extraChild: wholeRupees(0, 50000, 'Extra child charge'),
  amenities: z.array(z.string().max(60).regex(/^[a-z0-9_]+$/)).max(40).default([]),
  sortOrder: z.number().int().min(0).max(1000),
  isActive: z.boolean().default(true),
}).strict().superRefine((row, ctx) => {
  if (row.maxAdults > row.maxOccupancy) ctx.addIssue({ code: 'custom', path: ['maxAdults'], message: 'More adults than the room takes in total' });
  if (row.baseOccupancy > row.maxOccupancy) ctx.addIssue({ code: 'custom', path: ['baseOccupancy'], message: 'The price cannot include more guests than the room takes' });
  // Removed rooms are resubmitted inactive; they promise nothing, so they never block a save.
  const shortfall = row.isActive ? capacityShortfall(row) : null;
  if (shortfall) ctx.addIssue({ code: 'custom', path: ['maxAdults'], message: shortfall });
});

export const hotelRoomsSchema = z.object({
  rooms: z.array(hotelRoomSchema).min(1, 'Add at least one room type').max(30),
}).strict().superRefine((value, ctx) => {
  const names = value.rooms.map((row) => row.name.toLowerCase());
  names.forEach((name, index) => {
    if (names.indexOf(name) !== index) ctx.addIssue({ code: 'custom', path: ['rooms', index, 'name'], message: 'Each room type needs a different name' });
  });
});

/** Guest-facing cancellation templates; the plan columns are derived from these. */
export const HOTEL_CANCELLATION = {
  flexible: { freeCancelHours: 24, lateCharge: 'first_night', noShow: 'first_night' },
  moderate: { freeCancelHours: 72, lateCharge: 'first_night', noShow: 'first_night' },
  strict: { freeCancelHours: 168, lateCharge: 'full_stay', noShow: 'full_stay' },
  non_refundable: { freeCancelHours: null, lateCharge: 'full_stay', noShow: 'full_stay' },
};

/**
 * One rate plan. A base plan has weekday/weekend prices; a derived plan follows
 * a base plan of the same room (± %, + ₹ per guest). `key` names a new plan so a
 * derived plan in the same save can point at it before it has an id.
 */
export const hotelPlanSchema = z.object({
  id: z.string().uuid().optional(),
  key: z.string().max(60).optional(),
  roomTypeId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name the plan').max(60),
  mealPlan: z.enum(['EP', 'CP', 'MP', 'AP']).default('EP'),
  derivedFrom: z.string().max(60).nullable().default(null),
  weekday: wholeRupees(300, 200000, 'Weekday price').nullable().default(null),
  weekend: wholeRupees(300, 200000, 'Weekend price').nullable().default(null),
  adjustPct: z.number().int().min(-50).max(50).default(0),
  perGuest: wholeRupees(0, 10000, 'Per-guest charge').default(0),
  // Story 2.6: 'default' uses the hotel default; a preset fills the windows; 'custom' sends its own.
  cancellation: z.enum(['default', ...Object.keys(HOTEL_CANCELLATION), 'custom']).default('default'),
  cancellationPolicy: cancellationPolicySchema.optional(),
  minNights: z.number().int().min(1).max(30).default(1),
  // Story 3.3: null = the meal plan code's default; an override may add meals, never remove the minimum.
  inclusions: z.object({ breakfast: z.boolean(), lunch: z.boolean(), dinner: z.boolean() }).strict().nullable().default(null),
  sortOrder: z.number().int().min(0).max(1000),
  isActive: z.boolean().default(true),
}).strict().superRefine((row, ctx) => {
  const meals = inclusionsProblem(row.mealPlan, resolveInclusions(row.mealPlan, row.inclusions));
  if (meals) ctx.addIssue({ code: 'custom', path: ['inclusions'], message: `${row.name}: ${meals}` });
  if (row.derivedFrom == null) {
    if (row.weekday == null) ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Enter the weekday price' });
    if (row.weekend == null) ctx.addIssue({ code: 'custom', path: ['weekend'], message: 'Enter the weekend price' });
  }
  if (row.cancellation === 'custom' && !row.cancellationPolicy)
    ctx.addIssue({ code: 'custom', path: ['cancellationPolicy'], message: 'Set the refund windows for this rate' });
  if (row.derivedFrom != null && row.adjustPct === 0 && row.perGuest === 0 && row.cancellation === 'default') {
    ctx.addIssue({ code: 'custom', path: ['adjustPct'], message: 'A plan that follows another needs a different price or terms' });
  }
});

export const hotelPlansSchema = z.object({
  plans: z.array(hotelPlanSchema).min(1, 'Add at least one rate').max(120),
  // Story 2.6: the hotel default every 'default' rate uses.
  defaultPolicy: cancellationPolicySchema.optional(),
}).strict();

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
export const hotelStaySchema = z.object({
  checkInTime: clockTime,
  checkOutTime: clockTime,
  childFreeAge: z.coerce.number().int().min(0).max(17),
  weekendNights: z.array(z.coerce.number().int().min(0).max(6)).max(7),
  starRating: z.union([z.literal(''), z.coerce.number().int().min(1).max(5)]).default(''),
});

export const ID_TYPES = ['aadhaar', 'passport', 'driving_licence', 'voter_id'];
export const hotelRulesSchema = z.object({
  couples: z.enum(['yes', 'no'], { error: 'Say whether couples can stay' }),
  localId: z.enum(['yes', 'no'], { error: 'Say whether local ID is accepted' }),
  idTypes: z.array(z.enum(ID_TYPES)).min(1, 'Choose at least one ID you accept'),
  pets: z.enum(['yes', 'no']).default('no'),
  smoking: z.enum(['yes', 'no']).default('no'),
  parties: z.enum(['yes', 'no']).default('no'),
  extraRules: z.string().trim().max(500).default(''),
});

export const hotelGstSchema = z.object({
  gstRegistered: z.enum(['yes', 'no'], { error: 'Say whether the hotel is GST registered' }),
  gstin: z.string().trim().toUpperCase().default(''),
}).superRefine((value, ctx) => {
  if (value.gstRegistered === 'yes' && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value.gstin)) {
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Enter the 15-character GSTIN, like 24ABCDE1234F1Z5' });
  }
});
