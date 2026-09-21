import { z } from 'zod';
import { BOOKING_POLICY } from '../../domain/booking-policy.js';
import { visitInterval } from '../../domain/booking-dates.js';
import { localDateSchema, slotEnum } from './booking.js';

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
  rentMinor: z.number().int().min(0).max(50_000_000).nullable(),
}).strict();
