import { z } from 'zod';
import { BOOKING_POLICY, BOOKING_SLOTS } from '../../domain/booking-policy.js';
import { isLocalDate } from '../../domain/booking-dates.js';

export const slotEnum = z.enum(BOOKING_SLOTS);
export const cancellationTierEnum = z.enum(['flexible', 'moderate', 'strict']);

export const localDateSchema = z.string().refine(isLocalDate, 'Pick a valid calendar date');

/** Canonical one-listing selection; prices and customer identity come from the server. */
export const bookingSelectionSchema = z.object({
  rentableId: z.string().uuid(),
  currency: z.literal(BOOKING_POLICY.currency).default(BOOKING_POLICY.currency),
  dates: z.array(localDateSchema).min(1).max(BOOKING_POLICY.maxVisits)
    .refine((dates) => new Set(dates).size === dates.length, 'Choose each visit date only once')
    .transform((dates) => [...dates].sort()),
  slot: slotEnum,
  guests: z.number().int().min(1).max(500),
}).strict();

export const availabilityQuerySchema = z.object({
  from: localDateSchema.optional(),
  days: z.coerce.number().int().min(1).max(120).default(90),
  guests: z.coerce.number().int().min(1).max(500).default(1),
});

const phoneIN = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number');

export const bookingRequestSchema = z.object({
  rentableId: z.string().uuid(),
  date: localDateSchema,
  slot: slotEnum,
  guests: z.coerce.number().int().min(1, 'At least 1 guest').max(500),
  balanceMode: z.enum(['online_before', 'cash_on_arrival']),
  contactPhone: phoneIN,
  note: z.string().trim().max(500).optional(),
});

export const cancelBookingSchema = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().trim().min(4, 'Tell us why so we can improve').max(500),
});

/**
 * Razorpay webhook payload. This is UNTRUSTED input arriving at the money
 * flow — validate the shape here and verify the signature separately before
 * this ever runs. Runtime validation is the actual protection; a type
 * annotation would not have helped.
 */
export const razorpayWebhookSchema = z.object({
  event: z.string().min(1),
  payload: z.object({
    payment: z
      .object({
        entity: z.object({
          id: z.string(),
          order_id: z.string().nullable(),
          amount: z.number().int().nonnegative(),
          currency: z.string(),
          status: z.string(),
        }),
      })
      .optional(),
  }),
});
