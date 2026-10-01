import { BOOKING_POLICY } from './booking-policy.js';
import { addLocalDays, isWeekendLocalDate, parseLocalDate, propertyToday } from './booking-dates.js';

/**
 * Time booking for courts, lanes and stations (entertainment plan, Phase 4).
 * Pure: no database, no clock except the `now` passed in. The quote, the public
 * time grid, search cards and the hold all use these functions, so what a guest
 * is shown is exactly what the hold accepts.
 *
 * Minutes are counted from local midnight of the OPERATING DAY: a venue open
 * 18:00–02:00 on Saturday has the window [1080, 1560). Starts must fall before
 * midnight of that day (V1); ends may run up to 06:00 next day (1800).
 */
const MINUTE_MS = 60_000;
const KOLKATA_OFFSET_MINUTES = 330;
export const HOURLY_LATEST_END_MINUTE = 1800;
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const BY_UTC_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Errors carry a stable code the quote layer passes through. */
export class HourlyError extends RangeError {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function hhmmToMinute(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new HourlyError('START_INVALID', 'Times must use HH:mm');
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/** 1500 → "01:00" (the clock time, whatever the day). */
export function minuteToHhmm(minute) {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const weekdayKey = (date) => BY_UTC_DAY[parseLocalDate(date).getUTCDay()];
export const dayKind = (date) => (isWeekendLocalDate(date) ? 'weekend' : 'weekday');

/** { open, close, closesNextDay } → { startMin, endMin } on the operating day. */
export function windowMinutes(window) {
  const startMin = hhmmToMinute(window.open);
  const endMin = hhmmToMinute(window.close) + (window.closesNextDay ? 1440 : 0);
  return { startMin, endMin };
}

export function operatingWindows(config, date) {
  return (config.weeklyHours?.[weekdayKey(date)] ?? []).map(windowMinutes).sort((a, b) => a.startMin - b.startMin);
}

/**
 * Zod superRefine for the hourly booking_config. Kept here so the frontend copy
 * can validate an owner's form with the same rules.
 */
export function validateHourlyConfig(config, ctx) {
  const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
  const step = config.stepMinutes;
  if (config.minDurationMinutes > config.maxDurationMinutes) issue(['minDurationMinutes'], 'Minimum duration exceeds the maximum');
  for (const key of ['minDurationMinutes', 'maxDurationMinutes']) {
    if (config[key] % step) issue([key], `Use multiples of ${step} minutes`);
  }
  let open = false;
  for (const [index, day] of WEEKDAYS.entries()) {
    let windows;
    try {
      windows = (config.weeklyHours?.[day] ?? []).map((window) => ({ ...windowMinutes(window), window }));
    } catch {
      issue(['weeklyHours', day], 'Times must use HH:mm');
      continue;
    }
    windows.sort((a, b) => a.startMin - b.startMin);
    for (const [position, { startMin, endMin, window }] of windows.entries()) {
      const path = ['weeklyHours', day, position];
      open = true;
      if (startMin % step) issue(path, `Opening time must be on a ${step}-minute step`);
      if (window.closesNextDay ? endMin > HOURLY_LATEST_END_MINUTE : endMin <= startMin) {
        issue(path, window.closesNextDay ? 'Closing after midnight must be by 06:00' : 'Closing time must be after opening time');
      }
      if (endMin - startMin < config.minDurationMinutes) issue(path, 'Open hours are shorter than the minimum booking');
      if (position > 0 && startMin < windows[position - 1].endMin) issue(path, 'Shifts on the same day overlap');
    }
    const last = windows.at(-1);
    if (last && last.endMin > 1440) {
      const next = WEEKDAYS[(index + 1) % 7];
      let nextOpen;
      try {
        nextOpen = (config.weeklyHours?.[next] ?? []).map((window) => windowMinutes(window).startMin);
      } catch {
        nextOpen = [];
      }
      if (nextOpen.some((startMin) => startMin + 1440 < last.endMin)) {
        issue(['weeklyHours', day], `Closing after midnight overlaps ${next}'s opening`);
      }
    }
  }
  if (!open) issue(['weeklyHours'], 'Open at least one day');
}

/** Start minutes offered on the grid for a duration (aligned to step from each window's opening). */
export function candidateStarts(config, date, durationMinutes) {
  const starts = [];
  for (const { startMin, endMin } of operatingWindows(config, date)) {
    for (let start = startMin; start < 1440 && start + durationMinutes <= endMin; start += config.stepMinutes) starts.push(start);
  }
  return starts;
}

function instantFor(date, minute) {
  return new Date(parseLocalDate(date).getTime() + (minute - KOLKATA_OFFSET_MINUTES) * MINUTE_MS);
}

/**
 * One time-booked visit, validated against the venue's rules. Throws
 * HourlyError with DURATION_INVALID, START_INVALID, OUTSIDE_OPENING_HOURS or
 * OUTSIDE_BOOKING_WINDOW.
 */
export function buildHourlyVisit({ date, start, durationMinutes, config, now = new Date() }) {
  if (config.timeZone !== BOOKING_POLICY.timeZone) throw new HourlyError('SCHEDULE_UNAVAILABLE', 'Unsupported property timezone');
  if (!Number.isSafeInteger(durationMinutes) || durationMinutes < config.minDurationMinutes
    || durationMinutes > config.maxDurationMinutes || durationMinutes % config.stepMinutes) {
    throw new HourlyError('DURATION_INVALID', 'Choose a duration this venue offers.');
  }
  const startMin = hhmmToMinute(start);
  const window = operatingWindows(config, date).find((w) => startMin >= w.startMin && startMin < w.endMin);
  if (!window || startMin + durationMinutes > window.endMin) {
    throw new HourlyError('OUTSIDE_OPENING_HOURS', 'The venue is closed then.');
  }
  if ((startMin - window.startMin) % config.stepMinutes) throw new HourlyError('START_INVALID', 'Choose a start time from the list.');
  const startsAt = instantFor(date, startMin);
  const endsAt = instantFor(date, startMin + durationMinutes);
  const today = propertyToday(now);
  if (date < today || date > addLocalDays(today, config.bookingHorizonDays)
    || startsAt.getTime() <= new Date(now).getTime() + config.leadTimeMinutes * MINUTE_MS) {
    throw new HourlyError('OUTSIDE_BOOKING_WINDOW', `${date} ${start} is outside the booking window`);
  }
  return {
    date,
    slot: 'hourly',
    timeZone: config.timeZone,
    start,
    startMinute: startMin,
    durationMinutes,
    endsNextDay: startMin + durationMinutes > 1440,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    blockedStartAt: new Date(startsAt.getTime() - config.bufferBeforeMinutes * MINUTE_MS).toISOString(),
    blockedEndAt: new Date(endsAt.getTime() + config.bufferAfterMinutes * MINUTE_MS).toISOString(),
  };
}

/**
 * Rent for [startMinute, startMinute + durationMinutes) from one activity's
 * bands: [{ dayKind, startMinute, endMinute, hourlyRateMinor }]. The operating
 * day's kind applies to the whole booking (Saturday 23:00–01:00 is all weekend).
 * Accumulates rate × minutes exactly and rounds half up once.
 */
export function priceHourlyVisit({ bands, date, startMinute, durationMinutes }) {
  const kind = dayKind(date);
  const own = bands.filter((band) => band.dayKind === kind);
  const end = startMinute + durationMinutes;
  const segments = [];
  let sum = 0n;
  for (let minute = startMinute; minute < end;) {
    const band = own.find((b) => b.startMinute <= minute && minute < b.endMinute);
    if (!band) throw new HourlyError('PRICE_MISSING', 'This time has no price yet.');
    const until = Math.min(band.endMinute, end);
    sum += BigInt(band.hourlyRateMinor) * BigInt(until - minute);
    segments.push({ fromMinute: minute, toMinute: until, hourlyRateMinor: Number(band.hourlyRateMinor) });
    minute = until;
  }
  const rentMinor = (sum + 30n) / 60n;
  if (rentMinor > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Amount exceeds safe integer range');
  return { rentMinor: Number(rentMinor), dayKind: kind, segments };
}

/** Open minutes that one activity's bands leave unpriced: [{ day, fromMinute, toMinute }]. */
export function priceGaps(config, activityBands) {
  const gaps = [];
  for (const [index, day] of WEEKDAYS.entries()) {
    const kind = index >= 5 ? 'weekend' : 'weekday';
    const own = activityBands.filter((band) => band.dayKind === kind).sort((a, b) => a.startMinute - b.startMinute);
    for (const window of (config.weeklyHours?.[day] ?? []).map(windowMinutes)) {
      let cursor = window.startMin;
      for (const band of own) {
        if (band.endMinute <= cursor || band.startMinute >= window.endMin) continue;
        if (band.startMinute > cursor) gaps.push({ day, fromMinute: cursor, toMinute: band.startMinute });
        cursor = Math.max(cursor, band.endMinute);
      }
      if (cursor < window.endMin) gaps.push({ day, fromMinute: cursor, toMinute: window.endMin });
    }
  }
  return gaps;
}
