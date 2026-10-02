import 'server-only';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { hourlyRatesSchema } from '../schemas/zod/listing.js';
import { bookingModel } from '../domain/verticals.js';
import { hhmmToMinute, minuteToHhmm, priceGaps } from '../domain/hourly.js';
import { AppError, conflict, notFound, unprocessable } from '../../utils/apiError.js';
import { withListingInventory } from './inventory.js';

const signature = (value) => createHmac('sha256', process.env.SESSION_SECRET).update(JSON.stringify(value)).digest('hex');

/**
 * Hourly rate bands of a time-booked venue (entertainment plan, Phase 4).
 * Preview, then apply with the preview token, like slot pricing
 * (property-policy.js). Replace-all inside the listing lock. Every offered
 * activity must be priced for every open minute (PRICE_GAP); bands for one
 * activity and day kind must not overlap.
 */
export async function changeHourlyRates(database, ownerId, id, input) {
  z.string().uuid().parse(id);
  const parsed = hourlyRatesSchema.safeParse({ rates: input.rates });
  if (!parsed.success) throw unprocessable(parsed.error.flatten().fieldErrors);
  const rows = parsed.data.rates.map((row) => ({
    ...row,
    startMinute: hhmmToMinute(row.from),
    endMinute: hhmmToMinute(row.to) + (row.toNextDay ? 1440 : 0),
  }));
  const shape = rows.map((row, index) => row.endMinute <= row.startMinute || row.endMinute > 1800 ? index : null).filter((index) => index != null);
  if (shape.length) throw unprocessable({ rates: [`Each price needs an end after its start, by 06:00 next day (rows ${shape.map((i) => i + 1).join(', ')}).`] });
  return withListingInventory(database, id, async (tx, listing) => {
    const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND (account_status='active' OR (account_status='pending_application' AND ${listing.status}='draft')) FOR SHARE`;
    if (!owner || listing.client_id !== ownerId) throw notFound();
    if (bookingModel(listing) !== 'hourly') throw conflict('UNSUPPORTED_INVENTORY', 'Hourly prices apply to time-booked venues only.');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== listing.content_version) {
      throw conflict('LISTING_CHANGED', 'The venue changed. Reload the latest version and preview again.');
    }
    const config = listing.booking_config?.model === 'hourly' ? listing.booking_config : null;
    if (!config) throw conflict('HOURS_REQUIRED', 'Set the opening hours before the prices.');
    const offered = await tx`SELECT DISTINCT c.id, c.slug, c.name FROM category c
      JOIN rentable_resource_activity a ON a.category_id=c.id JOIN rentable_resource r ON r.id=a.resource_id AND r.is_active
      WHERE a.rentable_id=${id}`;
    const bySlug = new Map(offered.map((row) => [row.slug, row]));
    const strangers = [...new Set(rows.map((row) => row.activity))].filter((slug) => !bySlug.has(slug));
    if (strangers.length) throw unprocessable({ rates: [`No active court offers: ${strangers.join(', ')}`] });
    const problems = [];
    for (const activity of offered) {
      const bands = rows.filter((row) => row.activity === activity.slug)
        .map((row) => ({ dayKind: row.dayKind, startMinute: row.startMinute, endMinute: row.endMinute, hourlyRateMinor: row.hourlyRate * 100 }));
      for (const kind of ['weekday', 'weekend']) {
        const own = bands.filter((band) => band.dayKind === kind).sort((a, b) => a.startMinute - b.startMinute);
        own.forEach((band, index) => {
          if (index && band.startMinute < own[index - 1].endMinute) problems.push(`${activity.name}, ${kind}: prices overlap at ${minuteToHhmm(band.startMinute)}`);
        });
      }
      for (const gap of priceGaps(config, bands)) {
        problems.push(`${activity.name}: no price for ${gap.day} ${minuteToHhmm(gap.fromMinute)}–${minuteToHhmm(gap.toMinute)}`);
      }
    }
    if (problems.length) {
      throw new AppError('Some open hours have no price, or prices overlap.', 422, { code: 'PRICE_GAP', fields: { rates: problems.slice(0, 20) } });
    }
    const before = await tx`SELECT c.slug AS activity, rr.day_kind AS "dayKind", rr.start_minute AS "startMinute", rr.end_minute AS "endMinute",
        (rr.hourly_rate_minor / 100)::int AS "hourlyRate"
      FROM rentable_rate rr JOIN category c ON c.id=rr.category_id WHERE rr.rentable_id=${id} ORDER BY 1,2,3`;
    const after = rows.map(({ activity, dayKind, from, to, toNextDay, hourlyRate }) => ({ activity, dayKind, from, to, toNextDay, hourlyRate }));
    const token = signature([ownerId, id, 'hourly-rates', listing.content_version, listing.booking_config_version, before, after]);
    if (input.preview) {
      return { preview: { token, before, after, effective: 'Immediately after confirmation, for new quotes only. Accepted bookings keep their original price.' } };
    }
    if (input.previewToken !== token) throw conflict('PREVIEW_REQUIRED', 'Preview these exact prices before saving.');
    await tx`DELETE FROM rentable_rate WHERE rentable_id=${id}`;
    for (const row of rows) {
      await tx`INSERT INTO rentable_rate(rentable_id,category_id,day_kind,start_minute,end_minute,hourly_rate_minor)
        VALUES (${id},${bySlug.get(row.activity).id},${row.dayKind},${row.startMinute},${row.endMinute},${row.hourlyRate * 100})`;
    }
    const [saved] = await tx`UPDATE rentable SET booking_config_version=booking_config_version+1,updated_at=now() WHERE id=${id}
      RETURNING content_version,booking_config_version`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES ('client',${ownerId},'rentable',${id},'property_hourly_rates_changed',${JSON.stringify(before)}::text::jsonb,
        ${JSON.stringify({ values: after, contentVersion: saved.content_version, effectiveVersion: saved.booking_config_version, effective: 'immediate' })}::text::jsonb)`;
    return { ok: true, contentVersion: saved.content_version, effectiveVersion: saved.booking_config_version };
  });
}
