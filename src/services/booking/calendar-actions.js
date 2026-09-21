'use server';

import { revalidatePath } from 'next/cache';
import { requireActiveClient } from '@/services/auth/dal';
import { sql } from '@/services/db';
import { saveBookingConfiguration, saveBookingPriceOverride, openBookingDates } from '@/services/booking/owner-settings';
import { createOwnerBlock, releaseOwnerBlock } from '@/services/booking/inventory';
import { propertyLocalInstant } from '@/services/domain/booking-dates';
import { parseINRMinor } from '@/services/domain/booking-money';

function failure(error) {
  if (error instanceof RangeError) return { error: error.message };
  if (error.name === 'ZodError') return { error: 'Check the hours, dates, prices and capacities.' };
  return { error: error.code && !/^[0-9A-Z]{5}$/.test(error.code) ? error.message : 'The calendar could not be updated. Please try again.' };
}
async function perform(form, run) {
  const owner = await requireActiveClient();
  const rentableId = String(form.get('rentableId'));
  try { await run(owner.id, rentableId); }
  catch (error) { return failure(error); }
  revalidatePath(`/partner/listings/${rentableId}/calendar`);
  revalidatePath('/listing/[handle]', 'page');
  return { ok: true };
}

export async function saveSchedule(_state, form) {
  return perform(form, async (ownerId, rentableId) => {
    const slots = {};
    for (const slot of ['day', 'night', 'full_day']) {
      slots[slot] = form.get(`${slot}_enabled`) === 'on' ? {
        enabled: true, startTime: form.get(`${slot}_startTime`), endTime: form.get(`${slot}_endTime`),
        ...Object.fromEntries(['endDayOffset','bufferBeforeMinutes','bufferAfterMinutes','capacity','includedGuests'].map((key) => [key, Number(form.get(`${slot}_${key}`))])),
        extraGuestChargeMinor: parseINRMinor(form.get(`${slot}_extraGuestCharge`)),
      } : { enabled: false };
    }
    await saveBookingConfiguration(sql, ownerId, {
      rentableId, expectedVersion: Number(form.get('expectedVersion')),
      configuration: { timeZone: 'Asia/Kolkata', leadTimeMinutes: Number(form.get('leadTimeMinutes')), bookingHorizonDays: Number(form.get('bookingHorizonDays')), slots },
    });
  });
}
export async function saveOverride(_state, form) {
  return perform(form, (ownerId, rentableId) => saveBookingPriceOverride(sql, ownerId, {
    rentableId, day: form.get('day'), slot: form.get('slot'),
    rentMinor: form.get('reset') === 'on' ? null : parseINRMinor(form.get('rent')),
  }));
}
export async function addOpenDates(_state, form) {
  return perform(form, (ownerId, rentableId) => openBookingDates(sql, ownerId, { rentableId, from: form.get('from'), to: form.get('to') }));
}
export async function blockDates(_state, form) {
  return perform(form, async (ownerId, rentableId) => {
    await createOwnerBlock(sql, ownerId, { rentableId, blockedStartAt: propertyLocalInstant(form.get('from'), form.get('startTime')), blockedEndAt: propertyLocalInstant(form.get('to'), form.get('endTime')), reason: form.get('reason') });
  });
}
export async function unblockDates(_state, form) {
  return perform(form, (ownerId, rentableId) => releaseOwnerBlock(sql, ownerId, { rentableId, blockId: String(form.get('blockId')) }));
}
