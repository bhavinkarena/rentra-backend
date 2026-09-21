import 'server-only';
import { z } from 'zod';
import { bookingConfigSchema, priceOverrideSchema } from '../schemas/zod/booking-config.js';
import { localDateSchema } from '../schemas/zod/booking.js';
import { addLocalDays, parseLocalDate } from '../domain/booking-dates.js';
import { withListingInventory, auditInventoryReadiness, expireInventoryHolds, InventoryError } from './inventory.js';

async function ownerAccess(tx, listing, ownerId) {
  const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client' AND account_status='active' FOR SHARE`;
  if (!owner || listing.client_id !== ownerId) throw new InventoryError('FORBIDDEN', 'Property access unavailable.');
}

export async function saveBookingConfiguration(database, ownerId, { rentableId, expectedVersion, configuration }) {
  z.string().uuid().parse(rentableId);
  z.number().int().nonnegative().parse(expectedVersion);
  const parsed = bookingConfigSchema.parse(configuration);
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await ownerAccess(tx, listing, ownerId);
    if (listing.booking_config_version !== expectedVersion) throw new InventoryError('CONFIG_CHANGED', 'Booking settings changed. Reload before saving.');
    for (const schedule of Object.values(parsed.slots)) {
      if (schedule.enabled && schedule.capacity > listing.capacity) throw new InventoryError('INVALID_CAPACITY', 'Slot capacity cannot exceed the property capacity.');
    }
    await expireInventoryHolds(tx, rentableId);
    const candidate = { ...parsed, inventoryReady: true };
    await auditInventoryReadiness(tx, { ...listing, booking_config: candidate });
    await tx`UPDATE rentable SET booking_config=${JSON.stringify(candidate)}::jsonb, booking_config_version=booking_config_version+1, updated_at=now() WHERE id=${rentableId}`;
    await tx`INSERT INTO audit_log (actor_type,actor_id,entity,entity_id,action,"before","after")
      VALUES ('client',${ownerId},'rentable',${rentableId},'booking_configuration_changed',${JSON.stringify(listing.booking_config)}::jsonb,${JSON.stringify(candidate)}::jsonb)`;
    return { version: expectedVersion + 1 };
  });
}

export async function saveBookingPriceOverride(database, ownerId, input) {
  const value = priceOverrideSchema.parse(input);
  return withListingInventory(database, value.rentableId, async (tx, listing) => {
    await ownerAccess(tx, listing, ownerId);
    if (value.rentMinor === null) {
      await tx`DELETE FROM booking_price_override WHERE rentable_id=${listing.id} AND day=${value.day} AND slot=${value.slot}`;
      if (value.slot !== 'full_day') await tx`UPDATE availability SET price_override=NULL WHERE rentable_id=${listing.id} AND day=${value.day} AND slot=${value.slot}`;
    } else {
      await tx`INSERT INTO booking_price_override (rentable_id,day,slot,rent_minor)
        VALUES (${listing.id},${value.day},${value.slot},${value.rentMinor})
        ON CONFLICT (rentable_id,day,slot) DO UPDATE SET rent_minor=excluded.rent_minor,updated_at=now()`;
    }
    await tx`UPDATE rentable SET booking_config_version=booking_config_version+1,updated_at=now() WHERE id=${listing.id}`;
    await tx`INSERT INTO audit_log (actor_type,actor_id,entity,entity_id,action,"after") VALUES
      ('client',${ownerId},'rentable',${listing.id},'booking_price_override_changed',${JSON.stringify(value)}::jsonb)`;
    return { ok: true };
  });
}

/** Explicit owner instruction to add inventory; never overwrite existing closes. */
export async function openBookingDates(database, ownerId, { rentableId, from, to }) {
  localDateSchema.parse(from); localDateSchema.parse(to);
  const count = (parseLocalDate(to) - parseLocalDate(from)) / 86400000 + 1;
  if (count < 1 || count > 366) throw new InventoryError('INVALID_RANGE', 'Choose an ordered range of at most 366 dates.');
  return withListingInventory(database, rentableId, async (tx, listing) => {
    await ownerAccess(tx, listing, ownerId);
    const result = await tx`INSERT INTO availability (rentable_id,day,slot,units_available,blocked_by_client)
      SELECT ${listing.id}, d::date, s::availability_slot, 1, false
      FROM generate_series(${from}::date,${to}::date,interval '1 day') d CROSS JOIN unnest(ARRAY['day','night']) s
      ON CONFLICT (rentable_id,day,slot) DO NOTHING RETURNING day`;
    await tx`INSERT INTO audit_log (actor_type,actor_id,entity,entity_id,action,"after") VALUES
      ('client',${ownerId},'rentable',${listing.id},'calendar_dates_added',${JSON.stringify({ from, to, endExclusive: addLocalDays(to, 1) })}::jsonb)`;
    return { added: result.length };
  });
}
