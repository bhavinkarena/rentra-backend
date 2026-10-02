import { priceGaps } from './hourly.js';
import { hourlyBookingConfigSchema } from '../schemas/zod/booking-config.js';

/**
 * Listing completeness — DERIVED, never stored.
 *
 * Same rule as the onboarding stepper, for the same reason: a stored
 * `current_step` drifts the moment reality changes underneath it. A photo gets
 * deleted, an admin rejects the ownership document, a price row is removed —
 * each should move the bar backwards, and only derivation does that honestly.
 *
 * Sections mirror the nine in docs/rentra-role-flow.html §Stage 2.
 */

export const MIN_PHOTOS = 6;
export const MAX_PHOTOS = 15;

/** Documents that can prove ownership, best first. */
export const OWNERSHIP_DOC_TYPES = [
  {
    id: 'extract_7_12',
    label: '7/12 extract (Satbara)',
    note: 'Strongest for farm land — shows the survey number and the recorded holder.',
    sides: ['single'],
  },
  {
    id: 'electricity_bill',
    label: 'Electricity bill',
    note: 'Easiest to get. Must be under 3 months old.',
    sides: ['single'],
    freshMonths: 3,
  },
  {
    id: 'property_tax',
    label: 'Property tax receipt',
    note: 'Good for built property inside municipal limits.',
    sides: ['single'],
  },
  {
    id: 'index_ii',
    label: 'Index-II',
    note: 'Registration index of the sale deed — far easier to obtain than the deed.',
    sides: ['single'],
  },
  {
    id: 'extract_8a',
    label: '8-A extract',
    note: 'Useful when a family holds several survey numbers.',
    sides: ['single'],
  },
  {
    id: 'sale_deed',
    label: 'Registered sale deed',
    note: 'Definitive, but long — we do not ask for it by default.',
    sides: ['single'],
  },
  {
    id: 'authorisation_letter',
    label: 'Authorisation letter',
    note: "Required if you are not the owner. Send the owner's ID and their ownership document too.",
    sides: ['single'],
    agentOnly: true,
  },
];

/** Venues are often leased commercial premises: prove the right to run it there. */
export const VENUE_OWNERSHIP_DOC_TYPES = [
  { id: 'rent_agreement', label: 'Rent or lease agreement', note: 'For a leased venue — must cover today’s date.', sides: ['single'] },
  { id: 'property_tax', label: 'Property tax receipt', note: 'If you own the premises.', sides: ['single'] },
  { id: 'electricity_bill', label: 'Electricity bill', note: 'In the venue’s or your name. Must be under 3 months old.', sides: ['single'], freshMonths: 3 },
  { id: 'shop_establishment', label: 'Shop & Establishment registration', note: 'The business registration for the venue.', sides: ['single'] },
  { id: 'gst_certificate', label: 'GST registration certificate', note: 'Shows the business name and the premises address.', sides: ['single'] },
  { id: 'sale_deed', label: 'Registered sale deed', note: 'If you own the land outright.', sides: ['single'] },
  { id: 'noc', label: 'Owner’s NOC', note: 'If the landlord’s permission is needed to run the venue.', sides: ['single'] },
  { id: 'authorisation_letter', label: 'Authorisation letter', note: "Required if you are not the owner. Send the owner's ID and their document too.", sides: ['single'], agentOnly: true },
];

/** Which documents prove a listing, by booking model ('hour' = venue). */
/** An electricity bill (YYYY-MM-DD) issued today or within the last 3 calendar months, UTC dates. */
export function billIsFresh(issuedAt, now = new Date()) {
  const issued = new Date(`${issuedAt}T00:00:00Z`);
  if (!issuedAt || !Number.isFinite(+issued) || issued.toISOString().slice(0, 10) !== issuedAt) return false;
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const cutoff = new Date(today);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  return issued >= cutoff && issued <= today;
}
export const ownershipDocTypesFor = (rentalUnit) => (rentalUnit === 'hour' ? VENUE_OWNERSHIP_DOC_TYPES : OWNERSHIP_DOC_TYPES);

export function listingCompletion(
  listing,
  { prices = [], amenities = [], photos = [], documents = [], legacySubmission=false, resources = [], hourlyRates = [] } = {},
) {
  const l = listing ?? {};
  const photoList = Array.isArray(photos) ? photos : [];
  const pricedSlots = prices.filter((p) => p.weekday >= 500 && p.weekend >= 500);

  const liveDocs = documents.filter((d) => d.status !== 'rejected');
  const rejectedDoc = documents.find((d) => d.status === 'rejected');

  let sections = [
    {
      id: 'basics',
      label: 'What it is',
      hint: 'Category, title, description',
      done: Boolean(l.categoryId && l.title?.length >= 8 && l.description?.length >= 40),
      minutes: 4,
    },
    {
      id: 'location',
      label: 'Where it is',
      hint: 'Area, map pin, exact address',
      done: Boolean(l.cityId && l.areaId && l.location && l.exactAddress),
      // The exact address is stored but never shown until a booking confirms.
      note: l.exactAddress ? 'Exact address is hidden from guests until a booking is confirmed' : null,
      minutes: 3,
    },
    {
      id: 'capacity',
      label: 'Size and capacity',
      hint: 'Guests, bedrooms, farm size',
      done: Boolean(l.capacity > 0 && Number.isInteger(l.bedrooms) && l.bedrooms >= 0),
      minutes: 2,
    },
    {
      id: 'amenities',
      label: 'What it has',
      hint: 'Pool, AC, parking, bonfire…',
      done: amenities.length >= 3,
      note: amenities.length > 0 && amenities.length < 3
        ? `${amenities.length} picked — choose at least 3`
        : null,
      minutes: 2,
    },
    {
      id: 'rules',
      label: 'House rules',
      hint: 'Check-in window, what is and is not allowed',
      done: Boolean(l.checkInFrom && l.checkOutBy),
      minutes: 2,
    },
    {
      id: 'pricing',
      label: 'Slots and pricing',
      hint: 'Day picnic, overnight, full day',
      done: pricedSlots.length >= 1,
      note: pricedSlots.length
        ? `${pricedSlots.length} slot${pricedSlots.length === 1 ? '' : 's'} priced`
        : null,
      minutes: 3,
    },
    {
      id: 'terms',
      label: 'Deposit and cancellation',
      hint: 'What guests pay and what they get back',
      done: Boolean(l.cancellationTier) && l.depositAmount != null,
      minutes: 1,
    },
    {
      id: 'photos',
      label: 'Photos',
      hint: `${MIN_PHOTOS}–${MAX_PHOTOS} photos of the actual property`,
      done: photoList.length >= MIN_PHOTOS,
      note: photoList.length > 0 && photoList.length < MIN_PHOTOS
        ? `${photoList.length} of ${MIN_PHOTOS} minimum`
        : null,
      minutes: 6,
    },
    {
      id: 'ownership',
      label: 'Proof it is yours',
      hint: 'One document, name-matched to your ID',
      /**
       * THE gate. This single check is what keeps brokers from posting as
       * owners, and it is the whole reason a Rentra listing is worth more than
       * a classified ad.
       */
      done: liveDocs.length >= 1,
      failed: !liveDocs.length && Boolean(rejectedDoc),
      note: !liveDocs.length && rejectedDoc
        ? `Rejected — ${rejectedDoc.reviewNote ?? 'please upload a clearer copy'}`
        : null,
      minutes: 3,
    },
  ];

  // Time-booked venues (entertainment plan): courts and opening hours replace size and
  // slots; venue rules replace the check-in window; hourly bands replace slot prices.
  if (l.rentalUnit === 'hour') sections = venueSections(sections, l, { resources, hourlyRates });

  const by = id => sections.find(section=>section.id===id);
  const story=by('basics'), rules=by('rules'), terms=by('terms');
  const space=by(l.rentalUnit==='hour'?'venue':'capacity');
  const availability=l.rentalUnit==='hour'?by('hours'):{id:'availability',label:'Availability',hint:'Arrival, departure and open dates',done:legacySubmission || l.bookingConfig?.inventoryReady===true,minutes:3};
  sections=[{id:'type',label:'Type',done:Boolean(l.categoryId),minutes:1},by('location'),{...space,id:'space'},by('amenities'),by('photos'),{...story,id:'story',label:'Title and description'},by('pricing'),{...availability,id:'availability'}, {...rules,id:'rules',label:'Rules and cancellation',done:rules.done && terms.done && (legacySubmission || !['draft','rejected'].includes(l.status??'draft') || l.houseRules?.cancellationConfirmed===true)},by('ownership')];
  const total = sections.length;
  const done = sections.filter((s) => s.done).length;
  const remaining = sections.filter((s) => !s.done);

  const status = l.status ?? 'draft';
  const inReview = status === 'pending_review' || status === 'pending_verification';

  return {
    sections,
    done,
    total,
    remaining,
    minutesLeft: remaining.reduce((n, s) => n + (s.minutes ?? 0), 0),
    percent: Math.round((done / total) * 100),
    canSubmit:
      done === total &&
      (status === 'draft' ||
        status === 'rejected' ||
        (status === 'pending_review' && l.reviewNeedsResubmission)),
    status,
    inReview,
    isLive: status === 'live',
    review: {
      label: status === 'pending_verification'
        ? 'Verification visit'
        : 'Rentra reviews this property',
      hint: status === 'pending_verification'
        ? 'We check the property matches, then publish it.'
        : '2 working days. Every property is checked before it goes live.',
      state: status === 'live' ? 'done' : inReview ? 'in_review' : 'waiting',
    },
  };
}

/** The venue variant of the section list, in the venue walkthrough order. */
function venueSections(farm, l, { resources, hourlyRates }) {
  const by = (id) => farm.find((s) => s.id === id);
  const active = resources.filter((r) => r.isActive !== false);
  const rules = l.houseRules && !Array.isArray(l.houseRules) ? l.houseRules : {};
  const config = l.bookingConfig;
  const { inventoryReady, ...configuration } = config ?? {};
  const hoursReady = inventoryReady === true && hourlyBookingConfigSchema.safeParse(configuration).success;
  const activities = [...new Set(active.flatMap((r) => r.activities ?? []))];
  const courtsReady = active.length >= 1 && active.every((r) =>
    Number.isInteger(r.capacity) && r.capacity > 0 && (r.activities ?? []).length >= 1,
  ) && Boolean(l.categorySlug && activities.includes(l.categorySlug));
  const pricingReady = hoursReady && activities.length > 0 && activities.every((activity) => {
    const bands = hourlyRates.filter((r) => r.activity === activity);
    if (!bands.length || bands.some((r) => !Number.isFinite(r.hourlyRate) || r.hourlyRate <= 0 ||
      !Number.isInteger(r.startMinute) || !Number.isInteger(r.endMinute) ||
      r.startMinute < 0 || r.startMinute >= 1440 || r.endMinute <= r.startMinute || r.endMinute > 1800)) return false;
    for (const kind of ['weekday', 'weekend']) {
      const own = bands.filter((r) => r.dayKind === kind).sort((a, b) => a.startMinute - b.startMinute);
      if (own.some((r, i) => i > 0 && r.startMinute < own[i - 1].endMinute)) return false;
    }
    return priceGaps(config, bands).length === 0;
  });
  return [
    by('basics'),
    by('location'),
    {
      id: 'venue',
      label: 'Courts',
      hint: 'Each court, lane or station, and what it is for',
      done: courtsReady,
      note: active.length ? `${active.length} active` : null,
      minutes: 3,
    },
    { ...by('amenities'), hint: 'Floodlights, parking, changing rooms…' },
    {
      id: 'hours',
      label: 'Opening hours',
      hint: 'Weekly hours and how long a booking can be',
      done: hoursReady,
      minutes: 3,
    },
    {
      id: 'rules',
      label: 'Venue rules',
      hint: 'Footwear, age, food and drink',
      done: Boolean(rules.footwear || rules.notes),
      minutes: 2,
    },
    {
      id: 'pricing',
      label: 'Hourly prices',
      hint: 'Per hour, weekday and weekend, peak and off-peak',
      done: pricingReady,
      note: hourlyRates.length ? `${hourlyRates.length} price band${hourlyRates.length === 1 ? '' : 's'}` : null,
      minutes: 3,
    },
    by('terms'),
    { ...by('photos'), hint: `${MIN_PHOTOS}–${MAX_PHOTOS} photos of the actual venue` },
    by('ownership'),
  ];
}
