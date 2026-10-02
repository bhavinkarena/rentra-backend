import { z } from 'zod';
import { BOOKING_POLICY } from '../../domain/booking-policy.js';
import { visitInterval } from '../../domain/booking-dates.js';
import { localDateSchema, slotEnum } from './booking.js';
import { validateHourlyConfig } from '../../domain/hourly.js';

const enabledSlot = z.object({
  enabled: z.literal(true),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endDayOffset: z.number().int().min(0).max(1),
  bufferBeforeMinutes: z.number().int().min(0).max(1440),
  bufferAfterMinutes: z.number().int().min(0).max(1440),
  capacity: z.number().int().min(1).max(500),
  includedGuests: z.number().int().min(1).max(500),
  extraGuestChargeMinor: z.number().int().min(0).max(50_000_000),
}).strict().refine((value) => value.includedGuests <= value.capacity, 'Included guests exceed capacity');
const slot = z.union([z.object({ enabled: z.literal(false) }).strict(), enabledSlot]);

export const bookingConfigSchema = z.object({
  timeZone: z.literal(BOOKING_POLICY.timeZone),
  weekendDays:z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  earlyArrivalMinutes:z.number().int().min(0).max(1440).optional(),
  autoOpen: z.boolean().optional(),
  pricingIncludedGuests:z.number().int().min(1).max(500).optional(),
  leadTimeMinutes: z.number().int().min(0).max(525600),
  bookingHorizonDays: z.number().int().min(1).max(365),
  slots: z.object({ day: slot, night: slot, full_day: slot }).strict(),
}).strict().superRefine((config, ctx) => {
  if (!Object.values(config.slots).some((value) => value.enabled)) {
    ctx.addIssue({ code: 'custom', path: ['slots'], message: 'Enable at least one slot' });
  }
  for (const [name, schedule] of Object.entries(config.slots)) {
    if (!schedule.enabled) continue;
    try { visitInterval({ date: '2030-01-01', slot: name, schedule, timeZone: config.timeZone }); }
    catch (error) { ctx.addIssue({ code: 'custom', path: ['slots', name], message: error.message }); }
  }
});

export const priceOverrideSchema = z.object({
  rentableId: z.string().uuid(), day: localDateSchema, slot: slotEnum,
  rentMinor: z.number().int().min(50000,'Enter at least ?500, or close the slot instead').max(50_000_000).nullable(),
}).strict();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const openWindow = z.object({ open: hhmm, close: hhmm, closesNextDay: z.boolean().default(false) }).strict();
/** [] = closed that weekday; two windows = a split shift. */
const openDay = z.array(openWindow).max(2);

/** Time-booked venues (rentable.rental_unit = 'hour'): weekly hours and the start/duration grid. */
export const hourlyBookingConfigSchema = z.object({
  model: z.literal('hourly'),
  timeZone: z.literal(BOOKING_POLICY.timeZone),
  weekendDays:z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  earlyArrivalMinutes:z.number().int().min(0).max(1440).optional(),
  autoOpen: z.boolean().optional(),
  pricingIncludedGuests:z.number().int().min(1).max(500).optional(),
  leadTimeMinutes: z.number().int().min(0).max(10_080),
  bookingHorizonDays: z.number().int().min(1).max(180),
  stepMinutes: z.union([z.literal(30), z.literal(60)]),
  minDurationMinutes: z.number().int().min(30).max(720),
  maxDurationMinutes: z.number().int().min(30).max(720),
  bufferBeforeMinutes: z.number().int().min(0).max(120),
  bufferAfterMinutes: z.number().int().min(0).max(120),
  weeklyHours: z.object({ mon: openDay, tue: openDay, wed: openDay, thu: openDay, fri: openDay, sat: openDay, sun: openDay }).strict(),
}).strict().superRefine(validateHourlyConfig);
