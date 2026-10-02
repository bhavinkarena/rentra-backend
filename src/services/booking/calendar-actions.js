'use server';

import { revalidatePath } from 'next/cache';
import { requireClient, requireActiveClient } from '@/services/auth/dal';
import { sql } from '@/services/db';
import { saveBookingConfiguration, saveBookingPriceOverride, openBookingDates } from '@/services/booking/owner-settings';
import { createOwnerBlock, releaseOwnerBlock } from '@/services/booking/inventory';
import { propertyLocalInstant } from '@/services/domain/booking-dates';
import { calendarCommand } from './owner-calendar.js';
import { parseINRMinor } from '@/services/domain/booking-money';

function failure(error) {
  if (['CALENDAR_CHANGED', 'PREVIEW_REQUIRED', 'INVENTORY_CONFLICT', 'CONFIG_CHANGED', 'UNSUPPORTED_INVENTORY'].includes(error.code)) return { error: error.message, code: error.code, status: 409, conflicts: error.conflicts || [] };
  if (error.code === 'NOT_FOUND') return { error: error.message, code: error.code, status: 404 };
  if (error instanceof RangeError) return { error: error.message };
  if (error.name === 'ZodError') return { error: 'Check the hours, dates, prices and capacities.' };
  return { error: error.code && !/^[0-9A-Z]{5}$/.test(error.code) ? error.message : 'The calendar could not be updated. Please try again.' };
}
async function perform(form, run, command, draft = false) {
  const owner = await (draft ? requireClient() : requireActiveClient());
  const rentableId = String(form.get('rentableId'));
  let result;
  try {
    if (command) {
      const values = Object.fromEntries([...form.entries()].filter(([key]) => !['expectedCalendarVersion','previewToken','mode'].includes(key)).sort(([a],[b]) => a.localeCompare(b)));
      if (['open','block'].includes(command)) {
        const start = new Date(String(form.get('from')));
        const end = new Date(String(form.get('to')));
        if (!Number.isFinite(+start) || !Number.isFinite(+end) || end < start || end-start > 365*86400000) throw new RangeError('Choose at most 366 ordered dates.');
      }
      result = await calendarCommand(sql, owner.id, {
        rentableId, command, values, expectedCalendarVersion: form.get('expectedCalendarVersion'),
        preview: form.get('mode') === 'preview', previewToken: form.get('previewToken'),
      }, (database) => run(owner.id, rentableId, database));
      if (result.preview) return result;
    } else { result = await run(owner.id, rentableId, sql); }
  }
  catch (error) { return failure(error); }
  revalidatePath(`/partner/listings/${rentableId}/calendar`);
  revalidatePath('/listing/[handle]', 'page');
  revalidatePath('/partner/calendar');
  return { ok: true, result: result?.result ?? result, ...(result?.undoToken && { undoToken: result.undoToken, undoUntil: result.undoUntil }) };
}

export async function saveSchedule(_state, form) {
  return schedule(form, false);
}
export async function saveListingHours(_state, form) {
  return schedule(form, true);
}
async function schedule(form, draft) {
  return perform(form, async (ownerId, rentableId, database) => {
    if (form.get('model') === 'hourly') {
      // Time-booked venue: weekly hours and the booking grid arrive as one JSON field.
      let configuration;
      try { configuration = JSON.parse(String(form.get('configuration'))); } catch { throw new RangeError('Send the opening hours as JSON.'); }
      return saveBookingConfiguration(database, ownerId, { rentableId, expectedVersion: Number(form.get('expectedVersion')), configuration });
    }
    const slots = {};
    for (const slot of ['day', 'night', 'full_day']) {
      slots[slot] = form.get(`${slot}_enabled`) === 'on' ? {
        enabled: true, startTime: form.get(`${slot}_startTime`), endTime: form.get(`${slot}_endTime`),
        ...Object.fromEntries(['endDayOffset','bufferBeforeMinutes','bufferAfterMinutes','capacity','includedGuests'].map((key) => [key, Number(form.get(`${slot}_${key}`))])),
        extraGuestChargeMinor: parseINRMinor(form.get(`${slot}_extraGuestCharge`)),
      } : { enabled: false };
    }
    return saveBookingConfiguration(database, ownerId, {
      rentableId, expectedVersion: Number(form.get('expectedVersion')),
      configuration: { timeZone: 'Asia/Kolkata', autoOpen:form.get('autoOpen')==='on', earlyArrivalMinutes:Number(form.get('earlyArrivalMinutes')??120),weekendDays:String(form.get('weekendDays')||'6,0').split(',').map(Number), leadTimeMinutes: Number(form.get('leadTimeMinutes')), bookingHorizonDays: Number(form.get('bookingHorizonDays')), slots },
    });
  }, 'schedule', draft);
}
export async function saveOverride(_state, form) {
  return perform(form, (ownerId, rentableId, database) => saveBookingPriceOverride(database, ownerId, {
    rentableId, day: form.get('day'), slot: form.get('slot'),
    rentMinor: form.get('reset') === 'on' ? null : parseINRMinor(form.get('rent')),
  }), 'override');
}
export async function addOpenDates(_state, form) {
  return perform(form, (ownerId, rentableId, database) => openBookingDates(database, ownerId, { rentableId, from: form.get('from'), to: form.get('to') }), 'open');
}
export async function blockDates(_state, form) {
  return perform(form, async (ownerId, rentableId, database) => {
    // resourceId: one court of a venue; empty = the whole place.
    return createOwnerBlock(database, ownerId, { rentableId, resourceId: form.get('resourceId') || null, blockedStartAt: propertyLocalInstant(form.get('from'), form.get('startTime')), blockedEndAt: propertyLocalInstant(form.get('to'), form.get('endTime')), reason: form.get('reason') });
  }, 'block');
}
export async function unblockDates(_state, form) {
  return perform(form, (ownerId, rentableId, database) => releaseOwnerBlock(database, ownerId, { rentableId, blockId: String(form.get('blockId')) }), 'unblock');
}
