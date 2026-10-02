import { z } from 'zod';

/** Onboarding step schemas. Each step validates alone, so drafts can be partial. */

export const detailsSchema = z.object({
  legalName: z.string().trim().min(3, 'Enter your full name as printed on your ID').max(160),
  residentialAddress: z.string().trim().min(10, 'Enter your full address').max(500),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  preferredLocale: z.enum(['en', 'hi', 'gu']),
  clientType: z.enum(['owner', 'authorised_agent']),
  ownerName: z.string().trim().max(160).optional().or(z.literal('')),
  ownerRelationship: z.string().trim().max(80).optional().or(z.literal('')),
  intendedListingCount: z.coerce.number().int().min(1).max(200).optional(),
}).refine(
  // An agent must name whose property it is. Without this the "Authorised
  // manager" badge would be meaningless.
  (d) => d.clientType !== 'authorised_agent' || (d.ownerName && d.ownerName.length > 2),
  { message: "Tell us the owner's name", path: ['ownerName'] },
);

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const kycSchema = z.object({
  kycDocType: z.enum(['pan', 'aadhaar']),
  panNumber: z.string().trim().toUpperCase().optional().or(z.literal('')),
  aadhaarLast4: z.string().trim().optional().or(z.literal('')),
  kycNameOnDoc: z.string().trim().min(3, 'Enter the name exactly as printed').max(160),
})
  .refine(
    (d) => d.kycDocType !== 'pan' || PAN_RE.test(d.panNumber ?? ''),
    { message: 'PAN looks like ABCDE1234F', path: ['panNumber'] },
  )
  .refine(
    (d) => d.kycDocType !== 'aadhaar' || /^\d{4}$/.test(d.aadhaarLast4 ?? ''),
    { message: 'Enter the last 4 digits of your Aadhaar', path: ['aadhaarLast4'] },
  );

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const UPI_RE = /^[\w.-]{2,64}@[a-zA-Z]{2,32}$/;

const payoutFields = z.object({
  method: z.string().default(''),
  upiId: z.string().trim().toLowerCase().default(''),
  accountNumber: z.string().transform(v => v.replace(/[\s-]/g, '')).default(''),
  confirmAccountNumber: z.string().transform(v => v.replace(/[\s-]/g, '')).default(''),
  ifsc: z.string().transform(v => v.replace(/[\s-]/g, '').toUpperCase()).default(''),
  holderName: z.string().trim().default(''),
});
function checkPayout(d, ctx, confirmation) {
  const issue = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (!['upi','bank'].includes(d.method)) issue('method', 'Choose UPI or a bank account');
  if (d.holderName.length < 3 || d.holderName.length > 160) issue('holderName', 'Enter the account holder name (3–160 characters)');
  if (d.method === 'upi' && !UPI_RE.test(d.upiId)) issue('upiId', 'UPI ID looks like yourname@bank');
  if (d.method === 'bank') {
    if (!/^\d{9,18}$/.test(d.accountNumber)) issue('accountNumber', 'Enter a valid account number');
    if (!IFSC_RE.test(d.ifsc)) issue('ifsc', 'IFSC looks like SBIN0001234');
    if (confirmation && (!d.confirmAccountNumber || d.accountNumber !== d.confirmAccountNumber)) issue('confirmAccountNumber', 'Account numbers do not match');
  }
}
export const payoutSchema = payoutFields.superRefine((d,ctx) => checkPayout(d,ctx,false));
export const onboardingPayoutSchema = payoutFields.superRefine((d,ctx) => checkPayout(d,ctx,true));
export const destinationPayoutSchema = onboardingPayoutSchema;

export const consentSchema = z.object({
  acceptTerms: z.literal('on', { message: 'You need to accept the terms to continue' }),
  declareEntitled: z.literal('on', { message: 'Please confirm you are entitled to let the property' }),
});
