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

export function listingCompletion(listing, { prices = [], amenities = [], photos = [], documents = [] } = {}) {
  const l = listing ?? {};
  const photoList = Array.isArray(photos) ? photos : [];
  const pricedSlots = prices.filter((p) => p.weekday > 0 || p.weekend > 0);

  const liveDocs = documents.filter((d) => d.status !== 'rejected');
  const rejectedDoc = documents.find((d) => d.status === 'rejected');

  const sections = [
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
      done: Boolean(l.capacity > 0 && l.farmSize),
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
      failed: Boolean(rejectedDoc),
      note: rejectedDoc
        ? `Rejected — ${rejectedDoc.reviewNote ?? 'please upload a clearer copy'}`
        : null,
      minutes: 3,
    },
  ];

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
    canSubmit: done === total && (status === 'draft' || status === 'rejected'),
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
