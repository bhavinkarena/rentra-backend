import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../utils/apiError.js';
import { withListingInventory } from './inventory.js';
import { ownerEditEffect } from '../domain/listing-lifecycle.js';
import { apartmentProblem, clockOf, minuteOf, normalizeArrivalRules } from '../domain/apartment.js';

/**
 * Story 3.10: a whole apartment's own setup (unit, stay rules, price), saved part by part like
 * hotel-setup.js: owner and listing checked under the listing lock, the rendered content version
 * must match (409 otherwise), and every real change bumps apartment_profile.version and is audited.
 * Bookings (Story 3.11) are not taken yet; turnover nights are stored for it.
 */
const int = z.coerce.number().int();
const schemas = {
  unit: z.object({
    bedrooms: int, bathrooms: int, maxAdults: int, maxChildren: int, maxOccupants: int,
    beds: z.array(z.object({ type: z.string(), count: int }).strict()).max(8),
  }).strict(),
  stay: z.object({
    minNights: int, maxNights: int, turnoverNights: int, checkInTime: z.string(), checkOutTime: z.string(),
    arrivalRules: z.object({
      weekdays: z.record(z.string(), int).default({}),
      ranges: z.array(z.object({ from: z.string(), to: z.string(), minNights: int }).strict()).default([]),
    }).strict().default({ weekdays: {}, ranges: [] }),
  }).strict(),
  price: z.object({
    weekday: int, weekend: int, cleaningFee: int.default(0),
    weekendNights: z.array(int).max(7).default([5, 6]),
  }).strict(),
};

/** The columns each part writes, from validated values. */
const columns = {
  unit: (d) => ({ bedrooms: d.bedrooms, bathrooms: d.bathrooms, beds: d.beds, max_adults: d.maxAdults, max_children: d.maxChildren, max_occupants: d.maxOccupants }),
  stay: (d) => ({ min_nights: d.minNights, max_nights: d.maxNights, arrival_rules: normalizeArrivalRules(d.arrivalRules),
    check_in_minute: minuteOf(d.checkInTime), check_out_minute: minuteOf(d.checkOutTime), turnover_nights: d.turnoverNights }),
  price: (d) => ({ weekday_minor: d.weekday * 100, weekend_minor: d.weekend * 100, cleaning_fee_minor: d.cleaningFee * 100,
    weekend_nights: [...new Set(d.weekendNights)].sort() }),
};

const numeric = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' || (typeof v === 'string' && k.endsWith('_minor')) ? Number(v) : v]));

export async function saveApartment(database, ownerId, { rentableId, expectedVersion, part, values }) {
  z.string().uuid().parse(rentableId);
  return withListingInventory(database, rentableId, async (tx, listing) => {
    const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client'
      AND (account_status='active' OR (account_status='pending_application' AND ${listing.status}='draft')) FOR SHARE`;
    if (!owner || listing.client_id !== ownerId) throw notFound();
    if (listing.rental_unit !== 'unit_night') throw conflict('UNSUPPORTED_INVENTORY', 'This setup applies to whole apartments only.');
    if (!Number.isInteger(expectedVersion) || expectedVersion !== listing.content_version) {
      throw conflict('LISTING_CHANGED', 'This apartment changed after you opened it. Reload the latest version and try again.');
    }
    // Ownership and version first (404/409 before any payload problem), then the values.
    const schema = schemas[part];
    if (!schema) throw unprocessable({ _: ['Unknown apartment section.'] });
    const parsed = schema.safeParse(values ?? {});
    if (!parsed.success) throw unprocessable(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', [i.message]])));
    const problem = apartmentProblem(part, parsed.data);
    if (problem) throw unprocessable({ [part]: [problem] });
    const next = columns[part](parsed.data);
    // Inserted only when missing, so an unchanged save never moves the content version.
    let [stored] = await tx`SELECT * FROM apartment_profile WHERE rentable_id=${rentableId} FOR UPDATE`;
    if (!stored) [stored] = await tx`INSERT INTO apartment_profile(rentable_id) VALUES (${rentableId}) RETURNING *`;
    const before = numeric(Object.fromEntries(Object.keys(next).map((k) => [k, stored[k]])));
    const changed = !isDeepStrictEqual(JSON.parse(JSON.stringify(before)), JSON.parse(JSON.stringify(next)));
    if (changed) {
      const n = next;
      if (part === 'unit') {
        await tx`UPDATE apartment_profile SET bedrooms=${n.bedrooms}, bathrooms=${n.bathrooms}, beds=${JSON.stringify(n.beds)}::text::jsonb,
          max_adults=${n.max_adults}, max_children=${n.max_children}, max_occupants=${n.max_occupants} WHERE rentable_id=${rentableId}`;
      } else if (part === 'stay') {
        await tx`UPDATE apartment_profile SET min_nights=${n.min_nights}, max_nights=${n.max_nights}, arrival_rules=${JSON.stringify(n.arrival_rules)}::text::jsonb,
          check_in_minute=${n.check_in_minute}, check_out_minute=${n.check_out_minute}, turnover_nights=${n.turnover_nights} WHERE rentable_id=${rentableId}`;
      } else {
        await tx`UPDATE apartment_profile SET weekday_minor=${n.weekday_minor}, weekend_minor=${n.weekend_minor}, cleaning_fee_minor=${n.cleaning_fee_minor},
          weekend_nights=${n.weekend_nights}::smallint[] WHERE rentable_id=${rentableId}`;
      }
      await tx`UPDATE apartment_profile SET version=version+1, updated_at=now() WHERE rentable_id=${rentableId}`;
      // Denormalised like a hotel's capacity, so generic owner and admin views stay right.
      if (part === 'unit') await tx`UPDATE rentable SET capacity=${next.max_occupants}, bedrooms=${next.bedrooms}, updated_at=now() WHERE id=${rentableId}`;
      // The shared house-rules step and guest facts read the listing's check-in window.
      if (part === 'stay') await tx`UPDATE rentable SET check_in_from=${parsed.data.checkInTime}, check_out_by=${parsed.data.checkOutTime}, updated_at=now() WHERE id=${rentableId}`;
      // What the unit is (beds, rooms, occupants) is trust content; rules and prices are not.
      const effect = ownerEditEffect({ status: listing.status, priorStatus: listing.prior_status }, part === 'unit');
      if (effect.sentBack) {
        await tx`UPDATE rentable SET status=${effect.patch.status ?? listing.status}, prior_status=${effect.patch.priorStatus ?? listing.prior_status},
          updated_at=now() WHERE id=${rentableId}`;
      }
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after")
        VALUES ('client',${ownerId},'rentable',${rentableId},${`apartment_${part}_changed`},${JSON.stringify(before)}::text::jsonb,${JSON.stringify(next)}::text::jsonb)`;
    }
    const [after] = await tx`SELECT r.content_version, p.version FROM rentable r JOIN apartment_profile p ON p.rentable_id=r.id WHERE r.id=${rentableId}`;
    return { ok: true, contentVersion: after.content_version, apartmentVersion: after.version, changed };
  });
}

/** The owner's and admin's view of the apartment profile (null until a part is saved). */
export async function apartmentForEdit(database, rentableId) {
  const [row] = await database`SELECT * FROM apartment_profile WHERE rentable_id=${rentableId}`;
  if (!row) return { apartment: null };
  return {
    apartment: {
      bedrooms: row.bedrooms, bathrooms: row.bathrooms, beds: row.beds,
      maxAdults: row.max_adults, maxChildren: row.max_children, maxOccupants: row.max_occupants,
      minNights: row.min_nights, maxNights: row.max_nights, arrivalRules: row.arrival_rules,
      checkInTime: row.check_in_minute == null ? null : clockOf(row.check_in_minute),
      checkOutTime: row.check_out_minute == null ? null : clockOf(row.check_out_minute),
      turnoverNights: row.turnover_nights,
      weekday: row.weekday_minor == null ? null : Number(row.weekday_minor) / 100,
      weekend: row.weekend_minor == null ? null : Number(row.weekend_minor) / 100,
      cleaningFee: Number(row.cleaning_fee_minor) / 100,
      weekendNights: row.weekend_nights.map(Number),
      version: row.version,
    },
  };
}
