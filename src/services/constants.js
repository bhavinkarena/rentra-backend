/** Search-intent routes. Each maps to /[city]/[category]/[intent]. */
export const INTENTS = [
  { slug: 'day-picnic', label: 'Day picnic' },
  { slug: 'with-pool', label: 'With pool' },
  { slug: 'bonfire-allowed', label: 'Bonfire allowed' },
  { slug: 'pre-wedding-shoot', label: 'Pre-wedding shoot' },
  { slug: 'corporate-offsite', label: 'Corporate offsite' },
];

/**
 * Identity documents we accept, and which sides each needs.
 *
 * PAN first, deliberately: it proves identity for our purposes and carries
 * none of Aadhaar's restrictions. Aadhaar is accepted only as the MASKED
 * version UIDAI provides — a full Aadhaar copy is sensitive personal data
 * under the DPDP Act and non-authorised entities are restricted from storing
 * it at all, so there is real downside and no upside.
 */
export const ID_DOCUMENT_TYPES = [
  {
    id: 'pan_card',
    label: 'PAN card',
    sides: ['front'],
    note: 'Preferred — one photo, and the least sensitive document to hold.',
  },
  {
    id: 'aadhaar_masked',
    label: 'Aadhaar — masked only',
    sides: ['front', 'back'],
    note: 'Download the masked copy from the UIDAI site. We cannot accept a full Aadhaar.',
    requiresMaskConfirm: true,
  },
  {
    id: 'driving_licence',
    label: 'Driving licence',
    sides: ['front', 'back'],
  },
  {
    id: 'passport',
    label: 'Passport',
    sides: ['front', 'back'],
    note: 'Photo page and the address page.',
  },
  {
    id: 'voter_id',
    label: 'Voter ID',
    sides: ['front', 'back'],
  },
];

export const ID_DOCUMENT_BY_ID = Object.fromEntries(
  ID_DOCUMENT_TYPES.map((d) => [d.id, d]),
);

export const MAX_DOC_BYTES = 2 * 1024 * 1024;
