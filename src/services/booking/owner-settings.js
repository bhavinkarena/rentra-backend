import 'server-only';
import { z } from 'zod';
import { bookingConfigSchema, hourlyBookingConfigSchema, priceOverrideSchema } from '../schemas/zod/booking-config.js';
import { bookingModel } from '../domain/verticals.js';
import { operatingWindows } from '../domain/hourly.js';
import { localDateSchema } from '../schemas/zod/booking.js';
import { addLocalDays, parseLocalDate } from '../domain/booking-dates.js';
import { withListingInventory, auditInventoryReadiness, expireInventoryHolds, InventoryError } from './inventory.js';

async function ownerAccess(tx, listing, ownerId, draft = false) {
  const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND (account_status='active' OR (account_status='pending_application' AND ${draft} AND ${listing.status}='draft')) FOR SHARE`;
  if (!owner || listing.client_id !== ownerId) throw new InventoryError('FORBIDDEN', 'Property access unavailable.');
}

export async function saveBookingConfiguration(database, ownerId, { rentableId, expectedVersion, configuration }) {
  z.string().uuid().parse(rentableId);
  z.number().int().nonnegative().parse(expectedVersion);
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await ownerAccess(tx, listing, ownerId, true);
    // The listing's booking model picks the schema; a config in the other shape is refused.
    const hourly = bookingModel(listing) === 'hourly';
    const parsed = (hourly ? hourlyBookingConfigSchema : bookingConfigSchema).parse(configuration);
    if (listing.booking_config_version !== expectedVersion) throw new InventoryError('CONFIG_CHANGED', 'Booking settings changed. Reload before saving.');
    if (!hourly) for (const schedule of Object.values(parsed.slots)) {
      if(schedule.enabled){schedule.extraGuestChargeMinor=Number(listing.extra_guest_charge_minor);schedule.includedGuests=listing.booking_config?.pricingIncludedGuests || schedule.includedGuests;}
      if (schedule.enabled && schedule.capacity > listing.capacity) throw new InventoryError('INVALID_CAPACITY', 'Slot capacity cannot exceed the property capacity.');
    }
    // New hours never cancel anything: upcoming court bookings outside them are kept and listed.
    const outsideHours = hourly ? await bookingsOutsideHours(tx, listing.id, parsed) : [];
    await expireInventoryHolds(tx, rentableId);
    const candidate = { ...parsed, inventoryReady: true };
    await auditInventoryReadiness(tx, { ...listing, booking_config: candidate });
    await tx`UPDATE rentable SET booking_config=${JSON.stringify(candidate)}::text::jsonb, booking_config_version=booking_config_version+1, updated_at=now() WHERE id=${rentableId}`;
    if (!hourly && (candidate.autoOpen || !listing.booking_config?.inventoryReady)) await fillOpenDates(tx, rentableId, candidate.bookingHorizonDays);
    await tx`INSERT INTO audit_log (actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES ('client',${ownerId},'rentable',${rentableId},'booking_configuration_changed',${JSON.stringify(listing.booking_config)}::text::jsonb,${JSON.stringify({values:candidate,effectiveVersion:expectedVersion+1})}::text::jsonb)`;
    return { version: expectedVersion + 1, outsideHours };
  });
}

/** Upcoming held/confirmed court visits that would fall outside new weekly hours. */
async function bookingsOutsideHours(tx, rentableId, config) {
  const rows = await tx`SELECT b.reference, b.local_day::text AS day, b.starts_at, b.ends_at, b.slot_snapshot->>'startMinute' AS start_minute,
      b.slot_snapshot->>'durationMinutes' AS duration
    FROM booking b JOIN inventory_reservation r ON r.booking_id=b.id AND r.state IN ('held','committed')
    WHERE b.rentable_id=${rentableId} AND b.resource_id IS NOT NULL AND b.ends_at > clock_timestamp()
    ORDER BY b.starts_at`;
  return rows.filter((row) => {
    const start = Number(row.start_minute), end = start + Number(row.duration);
    return !operatingWindows(config, row.day).some((w) => start >= w.startMin && end <= w.endMin);
  }).map((row) => ({ reference: row.reference, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString() }));
}

export async function saveBookingPriceOverride(database, ownerId, input) {
  const value = priceOverrideSchema.parse(input);
  return withListingInventory(database, value.rentableId, async (tx, listing) => {
    await ownerAccess(tx, listing, ownerId);
    if (value.rentMinor === null) {
      await tx`DELETE FROM booking_price_override WHERE rentable_id=${listing.id} AND day=${value.day} AND slot=${value.slot}`;
    } else {
      await tx`INSERT INTO booking_price_override (rentable_id,day,slot,rent_minor)
        VALUES (${listing.id},${value.day},${value.slot},${value.rentMinor})
        ON CONFLICT (rentable_id,day,slot) DO UPDATE SET rent_minor=excluded.rent_minor,updated_at=now()`;
    }
    const [updated] = await tx`UPDATE rentable SET booking_config_version=booking_config_version+1,updated_at=now() WHERE id=${listing.id} RETURNING booking_config_version`;
    await tx`INSERT INTO audit_log (actor_type,actor_id,entity,entity_id,action,"after") VALUES
      ('client',${ownerId},'rentable',${listing.id},'booking_price_override_changed',${JSON.stringify({values:value,effectiveVersion:updated.booking_config_version})}::text::jsonb)`;
    return { ok: true, effectiveVersion:updated.booking_config_version };
  });
}

/** Explicit owner instruction to add inventory; never overwrite existing closes. */
export async function openBookingDates(database, ownerId, { rentableId, from, to }) {
  localDateSchema.parse(from); localDateSchema.parse(to);
  const count = (parseLocalDate(to) - parseLocalDate(from)) / 86400000 + 1;
  if (count < 1 || count > 366) throw new InventoryError('INVALID_RANGE', 'Choose an ordered range of at most 366 dates.');
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await ownerAccess(tx, listing, ownerId);
    if (bookingModel(listing) === 'hourly') throw new InventoryError('UNSUPPORTED_INVENTORY', 'Venues open by their weekly hours; close a day with a block instead.');
    const result = await tx`INSERT INTO availability (rentable_id,day,slot,units_available)
      SELECT ${listing.id}, d::date, s::availability_slot, 1
      FROM generate_series(${from}::date,${to}::date,interval '1 day') d CROSS JOIN unnest(ARRAY['day','night']) s
      ON CONFLICT (rentable_id,day,slot) DO NOTHING RETURNING day`;
    await tx`INSERT INTO audit_log (actor_type,actor_id,entity,entity_id,action,"after") VALUES
      ('client',${ownerId},'rentable',${listing.id},'calendar_dates_added',${JSON.stringify({ from, to, endExclusive: addLocalDays(to, 1), attempted: count * 2, added: result.length, skipped: count * 2 - result.length })}::text::jsonb)`;
    return { added: result.length };
  });
}

export async function fillOpenDates(tx, id, horizon) {
  return tx`INSERT INTO availability(rentable_id,day,slot,units_available)
    SELECT ${id},d::date,s::availability_slot,1 FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date,(now() AT TIME ZONE 'Asia/Kolkata')::date+${horizon}::int,interval '1 day') d CROSS JOIN unnest(ARRAY['day','night']) s ON CONFLICT(rentable_id,day,slot) DO NOTHING`;
}
export async function autoOpenDates(database) {
  const rows=await database`SELECT id FROM rentable WHERE booking_config->>'autoOpen'='true' AND rental_unit<>'hour' AND status IN ('draft','live','pending_review','pending_verification')`;
  for (const row of rows) await withListingInventory(database,row.id,async(tx,l)=> {if(l.booking_config?.autoOpen) await fillOpenDates(tx,l.id,l.booking_config.bookingHorizonDays);});
  return {properties:rows.length};
}
