import { z } from 'zod';
import { bookingSelectionSchema } from '../schemas/zod/booking.js';
import { propertyToday } from './booking-dates.js';

export const SAVED_LIMIT = 100;
export const GUEST_SAVED_KEY = 'rentra_guest_saved_v1';
export const GUEST_MERGE_OWNER_KEY = 'rentra_guest_merge_owner';
export const SAVED_SIGNAL_KEY = 'rentra_saved_changed';
export const savedEntrySchema = z.object({
  rentableId: z.string().uuid(),
  entryId: z.string().uuid(),
  selection: bookingSelectionSchema.nullable().default(null),
}).strict().refine(v => !v.selection || v.selection.rentableId === v.rentableId);
export const guestSavedSchema = z.array(savedEntrySchema).max(SAVED_LIMIT)
  .refine(v => new Set(v.map(e => e.rentableId)).size === v.length && new Set(v.map(e => e.entryId)).size === v.length);
export function validSavedSelection(value, rentableId, today = propertyToday()) {
  const parsed = bookingSelectionSchema.safeParse(value);
  if (!parsed.success || parsed.data.rentableId !== rentableId) return null;
  // Time-booked venues save one date; farmhouses a list.
  const dates = parsed.data.kind === 'hourly' ? [parsed.data.date] : parsed.data.dates;
  return dates.every(d => d >= today) ? parsed.data : null;
}
export function parseGuestSaved(raw) {
  if (!raw) return [];
  try {
    const parsed = guestSavedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.map(e => ({ ...e, selection: validSavedSelection(e.selection, e.rentableId) })) : [];
  } catch { return []; }
}
export function savedListingHref(path, selection) {
  if (!selection) return path;
  // The same parameters a venue search card links with, so the time picker pre-fills.
  if (selection.kind === 'hourly') return `${path}?${new URLSearchParams({ activity: selection.activity, date: selection.date,
    duration: String(selection.durationMinutes), players: String(selection.guests), ...(selection.start ? { start: selection.start } : {}), ...(selection.resourceId ? { court: selection.resourceId } : {}) })}`;
  return `${path}?${new URLSearchParams({ dates: selection.dates.join(','), slot: selection.slot, guests: String(selection.guests) })}`;
}
export function selectionFromSavedUrl(search, rentableId) {
  const query = new URLSearchParams(search);
  if (!query.has('dates')) return null;
  return validSavedSelection({ rentableId, dates: query.get('dates').split(','), slot: query.get('slot'), guests: Number(query.get('guests')) }, rentableId);
}
