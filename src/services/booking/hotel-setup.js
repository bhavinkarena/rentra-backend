import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  hotelGstSchema, hotelPlansSchema, hotelRoomsSchema, hotelRulesSchema, hotelStaySchema,
} from '../schemas/zod/listing.js';
import { conflict, notFound, unprocessable } from '../../utils/apiError.js';
import { withListingInventory } from './inventory.js';
import { ownerEditEffect } from '../domain/listing-lifecycle.js';
import { capacityShortfall } from '../domain/hotel-rooms.js';
import { effectivePetPolicy } from '../domain/pet-policy.js';
import { CANCELLATION_PRESETS, freeCancelHoursOf, presetName } from '../domain/cancellation-policy.js';

/**
 * The hotel owner's setup (hotel plan, Phase 3): room types, rate plans and the
 * hotel's own facts. Same contract as the venue courts editor: the owner's
 * content version must match, saved rows are upserted by id, rows left out are
 * deactivated (never deleted — bookings reference them), and every save is audited.
 */
const flat = (error) => {
  const out = {};
  for (const issue of error.issues) (out[issue.path.join('.') || '_'] ??= []).push(issue.message);
  return out;
};
const minuteOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Locks the hotel, checks the owner and the version the form was rendered from. */
function ownedHotel(database, ownerId, rentableId, expectedVersion, run) {
  z.string().uuid().parse(rentableId);
  return withListingInventory(database, rentableId, async (tx, listing) => {
    const [owner] = await tx`SELECT id FROM "user" WHERE id=${ownerId} AND role='client'
      AND (account_status='active' OR (account_status='pending_application' AND ${listing.status}='draft')) FOR SHARE`;
    if (!owner || listing.client_id !== ownerId) throw notFound();
    if (listing.rental_unit !== 'night') throw conflict('UNSUPPORTED_INVENTORY', 'Rooms and rates apply to hotels only.');
    if (!Number.isInteger(expectedVersion) || expectedVersion !== listing.content_version) {
      throw conflict('LISTING_CHANGED', 'This hotel changed after you opened it. Reload the latest version and try again.');
    }
    const result = await run(tx, listing);
    const [after] = await tx`SELECT content_version FROM rentable WHERE id=${rentableId}`;
    return { ok: true, contentVersion: after.content_version, ...result };
  });
}

const audit = (tx, ownerId, rentableId, action, after) =>
  tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after")
    VALUES ('client',${ownerId},'rentable',${rentableId},${action},${JSON.stringify(after)}::text::jsonb)`;

/** Room types. A type with rooms booked ahead cannot be removed, and its count cannot drop below them. */
export async function saveHotelRooms(database, ownerId, { rentableId, expectedVersion, rooms }) {
  const parsed = hotelRoomsSchema.safeParse({ rooms });
  if (!parsed.success) throw unprocessable(flat(parsed.error));
  const input = parsed.data.rooms;
  return ownedHotel(database, ownerId, rentableId, expectedVersion, async (tx, listing) => {
    const existing = await tx`SELECT t.*, (SELECT count(*)::int FROM booking_room br WHERE br.room_type_id=t.id
        AND br.state IN ('held','booked') AND br.check_out > (now() AT TIME ZONE 'Asia/Kolkata')::date) AS upcoming
      FROM room_type t WHERE t.rentable_id=${rentableId}`;
    const known = new Map(existing.map((row) => [row.id, row]));
    for (const row of input) if (row.id && !known.has(row.id)) throw notFound('ROOM_TYPE_NOT_FOUND', 'That room type is not part of this hotel.');
    const stranded = existing.filter((row) => row.upcoming > 0 && !input.some((item) => item.id === row.id && item.isActive));
    if (stranded.length) {
      throw conflict('ROOM_HAS_BOOKINGS', `${stranded.map((row) => row.name).join(', ')}: guests have rooms booked ahead, so ${stranded.length === 1 ? 'this room type stays' : 'these room types stay'} on sale. Lower the rooms to sell instead.`);
    }
    if (!input.some((row) => row.isActive)) throw unprocessable({ rooms: ['Keep at least one room type on sale.'] });
    const saved = [];
    for (const row of input) {
      const values = [row.name, JSON.stringify(row.beds), row.sizeSqm, row.view, row.maxAdults, row.maxChildren, row.maxOccupancy,
        row.baseOccupancy, row.roomCount, row.extraAdult * 100, row.extraChild * 100, JSON.stringify(row.amenities), row.sortOrder, row.isActive, JSON.stringify(row.extraPlaces), row.extraAdultIncludesBedding, row.childPolicy && JSON.stringify(row.childPolicy), JSON.stringify(row.cots)];
      const [n, beds, size, view, adults, children, occupancy, base, count, extraAdult, extraChild, amenities, sort, active, extra, includesBedding, childPolicy, cots] = values;
      try {
        const [room] = row.id
          ? await tx`UPDATE room_type SET name=${n}, beds=${beds}::text::jsonb, size_sqm=${size}, view=${view}, max_adults=${adults},
              max_children=${children}, max_occupancy=${occupancy}, base_occupancy=${base}, room_count=${count},
              extra_adult_minor=${extraAdult}, extra_child_minor=${extraChild}, amenities=${amenities}::text::jsonb, extra_places=${extra}::text::jsonb,
              extra_adult_includes_bedding=${includesBedding}, child_policy=${childPolicy}::text::jsonb, cots=${cots}::text::jsonb,
              sort_order=${sort}, is_active=${active}, updated_at=now()
            WHERE id=${row.id} AND rentable_id=${rentableId} RETURNING id`
          : await tx`INSERT INTO room_type(rentable_id,name,beds,size_sqm,view,max_adults,max_children,max_occupancy,base_occupancy,
              room_count,extra_adult_minor,extra_child_minor,amenities,sort_order,is_active,extra_places,extra_adult_includes_bedding,child_policy,cots)
            VALUES (${rentableId},${n},${beds}::text::jsonb,${size},${view},${adults},${children},${occupancy},${base},${count},
              ${extraAdult},${extraChild},${amenities}::text::jsonb,${sort},${active},${extra}::text::jsonb,${includesBedding},${childPolicy}::text::jsonb,${cots}::text::jsonb) RETURNING id`;
        saved.push(room.id);
      } catch (error) {
        if (error.code === '23514' && error.constraint_name === 'room_night_capacity_chk') {
          throw conflict('ROOMS_BELOW_BOOKINGS', `${row.name}: more rooms are already booked on some nights than ${row.roomCount}. Keep at least as many rooms as are booked.`);
        }
        throw error;
      }
    }
    const missing = existing.filter((row) => !saved.includes(row.id) && row.is_active).map((row) => row.id);
    if (missing.length) await tx`UPDATE room_type SET is_active=false, updated_at=now() WHERE id IN ${tx(missing)}`;
    // Denormalised like a venue's capacity: generic guest filters keep working for hotels.
    await tx`UPDATE rentable SET capacity=(SELECT max(max_occupancy) FROM room_type WHERE rentable_id=${rentableId} AND is_active),
      updated_at=now() WHERE id=${rentableId}`;
    // What the rooms are is trust content; how many are sold on Rentra is not, and neither is the order.
    // Owner decision 29 Oct 2026: extra sleeping places are not review-triggering facts (audited only).
    const facts = (rows) => JSON.stringify(rows.filter((r) => r.isActive).map((r) => [r.name, r.beds, r.sizeSqm, r.view, r.maxAdults, r.maxChildren, r.maxOccupancy])
      .sort((a, b) => a[0].localeCompare(b[0])));
    const before = facts(existing.map((r) => ({ name: r.name, beds: r.beds, sizeSqm: r.size_sqm, view: r.view, maxAdults: r.max_adults,
      maxChildren: r.max_children, maxOccupancy: r.max_occupancy, isActive: r.is_active })));
    const effect = ownerEditEffect({ status: listing.status, priorStatus: listing.prior_status }, before !== facts(input));
    if (effect.sentBack) {
      await tx`UPDATE rentable SET status=${effect.patch.status ?? listing.status}, prior_status=${effect.patch.priorStatus ?? listing.prior_status},
        updated_at=now() WHERE id=${rentableId}`;
    }
    // Story 3.6: a new child policy version only when a room's effective child terms really change (audit only, no review).
    // Terms: own policy, else (with no property policy) the extra child price the fallback uses; plus cots.
    // Removed or inactive rooms are ignored; a new or reactivated room counts only once it has its own policy or cots.
    const [{ child_policy: propertyPolicy = null } = {}] = await tx`SELECT child_policy FROM hotel_profile WHERE rentable_id=${rentableId}`;
    const terms = (r) => r && r.active ? [r.childPolicy ?? null, r.childPolicy || propertyPolicy ? null : r.extraChildMinor,
      r.cots?.count ?? 0, r.cots?.count ? r.cots.amount ?? 0 : 0] : null;
    const was = new Map(existing.map((r) => [r.id, terms({ active: r.is_active, childPolicy: r.child_policy, extraChildMinor: Number(r.extra_child_minor), cots: r.cots })]));
    const next = new Map(input.map((r, i) => [saved[i], terms({ active: r.isActive, childPolicy: r.childPolicy, extraChildMinor: r.extraChild * 100, cots: r.cots })]));
    const plain = (t) => t[0] == null && t[2] === 0;
    const childChanged = [...next].some(([id, after]) => {
      const before = was.get(id) ?? null;
      if (after == null) return false; // removed rooms take no new quotes
      return before == null ? !plain(after) : !isDeepStrictEqual(before, after);
    });
    if (childChanged) {
      await tx`INSERT INTO hotel_profile(rentable_id) VALUES (${rentableId}) ON CONFLICT (rentable_id) DO NOTHING`;
      await tx`UPDATE hotel_profile SET child_policy_version=child_policy_version+1, updated_at=now() WHERE rentable_id=${rentableId}`;
    }
    await audit(tx, ownerId, rentableId, 'hotel_rooms_changed', { rooms: input, deactivated: missing });
    return { roomTypeIds: saved, sentBack: effect.sentBack };
  });
}

/** Rate plans for the hotel's room types. Prices are not trust content: no review on change. */
export async function saveHotelRates(database, ownerId, { rentableId, expectedVersion, plans, defaultPolicy: rawDefault }) {
  const parsed = hotelPlansSchema.safeParse({ plans, ...(rawDefault ? { defaultPolicy: rawDefault } : {}) });
  if (!parsed.success) throw unprocessable(flat(parsed.error));
  const input = parsed.data.plans;
  const { defaultPolicy } = parsed.data;
  return ownedHotel(database, ownerId, rentableId, expectedVersion, async (tx) => {
    const rooms = await tx`SELECT id, name FROM room_type WHERE rentable_id=${rentableId}`;
    const existing = await tx`SELECT id, room_type_id, derived_from, is_active FROM rate_plan WHERE rentable_id=${rentableId}`;
    const known = new Map(existing.map((row) => [row.id, row]));
    for (const row of input) {
      if (!rooms.some((room) => room.id === row.roomTypeId)) throw notFound('ROOM_TYPE_NOT_FOUND', 'That room type is not part of this hotel.');
      if (row.id && !known.has(row.id)) throw notFound('RATE_PLAN_NOT_FOUND', 'That rate is not part of this hotel.');
      if (row.id && (known.get(row.id).derived_from == null) !== (row.derivedFrom == null)) {
        throw unprocessable({ plans: [`${row.name}: add a new rate instead of switching between own prices and following another rate.`] });
      }
    }
    const ref = (row) => row.id ?? row.key;
    const byRef = new Map(input.map((row) => [ref(row), row]));
    for (const [index, row] of input.entries()) {
      if (row.derivedFrom == null) continue;
      const parent = byRef.get(row.derivedFrom);
      if (!parent || parent.derivedFrom != null || parent.roomTypeId !== row.roomTypeId || !parent.isActive) {
        throw unprocessable({ [`plans.${index}.derivedFrom`]: ['Choose an active base rate of the same room type to follow.'] });
      }
    }
    // Base rates first, so a new derived rate can point at a new base rate by its key.
    const ids = new Map();
    // Story 2.6: the hotel default first; a 'default' rate stores no policy of its own.
    const [hotelRow] = await tx`SELECT cancellation_policy FROM rentable WHERE id=${rentableId}`;
    const hotelDefault = defaultPolicy ?? hotelRow?.cancellation_policy ?? CANCELLATION_PRESETS.night.moderate;
    if (defaultPolicy) await tx`UPDATE rentable SET cancellation_policy=${JSON.stringify(defaultPolicy)}::text::jsonb, updated_at=now() WHERE id=${rentableId}`;
    const write = async (row) => {
      const own = row.cancellation === 'default' ? null
        : row.cancellation === 'custom' ? row.cancellationPolicy : CANCELLATION_PRESETS.night[row.cancellation];
      const effective = own ?? hotelDefault;
      // Older readers still see matching columns; the policy is what bookings snapshot.
      const free = freeCancelHoursOf(effective);
      const terms = { freeCancelHours: free == null ? null : Math.max(1, free), lateCharge: 'full_stay', noShow: 'full_stay' };
      const parent = row.derivedFrom == null ? null : (ids.get(row.derivedFrom) ?? row.derivedFrom);
      const values = {
        name: row.name, meal_plan: row.mealPlan, weekday_minor: row.derivedFrom == null ? row.weekday * 100 : null,
        weekend_minor: row.derivedFrom == null ? row.weekend * 100 : null, derived_from: parent,
        derived_pct_bps: row.derivedFrom == null ? 0 : row.adjustPct * 100, derived_per_guest_minor: row.derivedFrom == null ? 0 : row.perGuest * 100,
        free_cancel_hours: terms.freeCancelHours, late_charge: terms.lateCharge, no_show: terms.noShow,
        min_nights: row.minNights, sort_order: row.sortOrder, is_active: row.isActive,
        cancellation_policy: own ? tx.json(own) : null,
        inclusions: row.inclusions ? tx.json(row.inclusions) : null,
      };
      const [plan] = row.id
        ? await tx`UPDATE rate_plan SET ${tx(values)}, updated_at=now() WHERE id=${row.id} AND rentable_id=${rentableId} RETURNING id`
        : await tx`INSERT INTO rate_plan ${tx({ ...values, room_type_id: row.roomTypeId, rentable_id: rentableId })} RETURNING id`;
      ids.set(ref(row), plan.id);
    };
    for (const row of input.filter((r) => r.derivedFrom == null)) await write(row);
    for (const row of input.filter((r) => r.derivedFrom != null)) await write(row);
    const saved = [...ids.values()];
    const missing = existing.filter((row) => !saved.includes(row.id) && row.is_active).map((row) => row.id);
    if (missing.length) await tx`UPDATE rate_plan SET is_active=false, updated_at=now() WHERE id IN ${tx(missing)}`;
    await audit(tx, ownerId, rentableId, 'hotel_rates_changed', { plans: input, deactivated: missing });
    return { ratePlanIds: Object.fromEntries(ids) };
  });
}

/**
 * The hotel's own facts, one wizard step at a time: `stay` (check-in/out, child
 * age, weekend nights, stars), `rules` (couples, ID, pets…) and `gst`.
 * Each step records that it was answered, so completion never mistakes a default for a choice.
 */
export async function saveHotelProfile(database, ownerId, { rentableId, expectedVersion, part, values }) {
  const schema = { stay: hotelStaySchema, rules: hotelRulesSchema, gst: hotelGstSchema }[part];
  if (!schema) throw unprocessable({ _: ['Unknown hotel section.'] });
  const parsed = schema.safeParse(values);
  if (!parsed.success) throw unprocessable(flat(parsed.error));
  const d = parsed.data;
  return ownedHotel(database, ownerId, rentableId, expectedVersion, async (tx) => {
    await tx`INSERT INTO hotel_profile(rentable_id) VALUES (${rentableId}) ON CONFLICT (rentable_id) DO NOTHING`;
    const [profile] = await tx`SELECT policies, child_policy, child_free_age FROM hotel_profile WHERE rentable_id=${rentableId} FOR UPDATE`;
    const policies = { ...profile.policies };
    if (part === 'stay') {
      policies.stayAnswered = true;
      // Story 3.6: an omitted childPolicy keeps the saved one; null clears it (back to the legacy fallback).
      const childPolicy = d.childPolicy === undefined ? profile.child_policy : d.childPolicy;
      const childFreeAge = d.childFreeAge ?? profile.child_free_age;
      // The free age only prices quotes when no property policy is saved.
      const changed = !isDeepStrictEqual(childPolicy ?? null, profile.child_policy ?? null) || (!childPolicy && childFreeAge !== profile.child_free_age);
      await tx`UPDATE hotel_profile SET check_in_minute=${minuteOf(d.checkInTime)}, check_out_minute=${minuteOf(d.checkOutTime)},
        child_free_age=${childFreeAge}, child_policy=${childPolicy ? JSON.stringify(childPolicy) : null}::text::jsonb,
        child_policy_version=child_policy_version + ${changed ? 1 : 0}, weekend_nights=${[...new Set(d.weekendNights)].sort()}::smallint[],
        star_rating=${d.starRating === '' ? null : d.starRating}, policies=${JSON.stringify(policies)}::text::jsonb, updated_at=now()
        WHERE rentable_id=${rentableId}`;
    } else if (part === 'rules') {
      // Story 3.8: the pet policy lives on the listing; policies.pets mirrors it for older readers.
      const [listingRow] = await tx`SELECT pet_policy FROM rentable WHERE id=${rentableId}`;
      const petPolicy = d.petPolicy ?? listingRow.pet_policy ?? null;
      Object.assign(policies, {
        couples: d.couples === 'yes', localId: d.localId === 'yes', idTypes: d.idTypes, pets: petPolicy ? petPolicy.status === 'allowed' : d.pets === 'yes',
        smoking: d.smoking === 'yes', parties: d.parties === 'yes', notes: d.extraRules || null,
      });
      if (d.petPolicy) {
        const before = effectivePetPolicy(listingRow.pet_policy, profile.policies?.pets === true);
        const changed = !isDeepStrictEqual(before, d.petPolicy);
        await tx`UPDATE rentable SET pet_policy=${JSON.stringify(d.petPolicy)}::text::jsonb, pet_policy_version=pet_policy_version + ${changed ? 1 : 0}
          WHERE id=${rentableId}`;
        if (changed) await audit(tx, ownerId, rentableId, 'pet_policy_changed', { before, after: d.petPolicy });
      }
      await tx`UPDATE hotel_profile SET policies=${JSON.stringify(policies)}::text::jsonb, updated_at=now() WHERE rentable_id=${rentableId}`;
    } else {
      policies.gstAnswered = true;
      await tx`UPDATE hotel_profile SET gst_registered=${d.gstRegistered === 'yes'}, gstin=${d.gstRegistered === 'yes' ? d.gstin : null},
        policies=${JSON.stringify(policies)}::text::jsonb, updated_at=now() WHERE rentable_id=${rentableId}`;
    }
    await audit(tx, ownerId, rentableId, `hotel_${part}_changed`, d);
    return {};
  });
}

/** The owner's editor view: profile, every room type (with rooms booked ahead) and every plan. */
export async function hotelForEdit(database, rentableId) {
  const [[profile], roomTypes, ratePlans, [hotelPolicy]] = await Promise.all([
    database`SELECT star_rating AS "starRating", check_in_minute AS "checkInMinute", check_out_minute AS "checkOutMinute",
        child_free_age AS "childFreeAge", child_policy AS "childPolicy", child_policy_version AS "childPolicyVersion",
        weekend_nights AS "weekendNights", policies, gst_registered AS "gstRegistered", gstin
      FROM hotel_profile WHERE rentable_id=${rentableId}`,
    database`SELECT t.id, t.name, t.beds, t.size_sqm AS "sizeSqm", t.view, t.max_adults AS "maxAdults", t.max_children AS "maxChildren",
        t.max_occupancy AS "maxOccupancy", t.base_occupancy AS "baseOccupancy", t.room_count AS "roomCount",
        (t.extra_adult_minor/100)::int AS "extraAdult", (t.extra_child_minor/100)::int AS "extraChild", t.amenities, t.extra_places AS "extraPlaces",
        t.extra_adult_includes_bedding AS "extraAdultIncludesBedding", t.child_policy AS "childPolicy", t.cots,
        t.sort_order AS "sortOrder", t.is_active AS "isActive",
        (SELECT count(*)::int FROM booking_room br WHERE br.room_type_id=t.id AND br.state IN ('held','booked')
          AND br.check_out > (now() AT TIME ZONE 'Asia/Kolkata')::date) AS "upcomingRooms"
      FROM room_type t WHERE t.rentable_id=${rentableId} ORDER BY t.sort_order, t.name, t.id`,
    database`SELECT id, room_type_id, name, meal_plan, derived_from, weekday_minor, weekend_minor, derived_pct_bps,
        derived_per_guest_minor, free_cancel_hours, late_charge, no_show, min_nights, sort_order, is_active, cancellation_policy, inclusions
      FROM rate_plan WHERE rentable_id=${rentableId} ORDER BY sort_order, name, id`,
    database`SELECT cancellation_policy FROM rentable WHERE id=${rentableId}`,
  ]);
  return {
    hotel: {
      profile: profile ? { ...profile, weekendNights: profile.weekendNights.map(Number) } : null,
      roomTypes,
      ratePlans: ratePlans.map((row) => ({
        id: row.id, roomTypeId: row.room_type_id, name: row.name, mealPlan: row.meal_plan, derivedFrom: row.derived_from,
        weekday: row.weekday_minor == null ? null : Number(row.weekday_minor) / 100,
        weekend: row.weekend_minor == null ? null : Number(row.weekend_minor) / 100,
        adjustPct: row.derived_pct_bps / 100, perGuest: Number(row.derived_per_guest_minor) / 100,
        // Story 2.6: 'default' inherits the hotel default; otherwise the preset these windows equal, or 'custom'.
        cancellation: row.cancellation_policy == null ? 'default' : presetName(row.cancellation_policy, 'night'),
        cancellationPolicy: row.cancellation_policy,
        minNights: row.min_nights, sortOrder: row.sort_order, isActive: row.is_active, inclusions: row.inclusions,
      })),
      // Story 3.3: saved rooms that promise more adults than they sleep; still bookable, fixed on the next save.
      capacityWarnings: roomTypes.filter((room) => room.isActive).map((room) => ({ roomTypeId: room.id, message: capacityShortfall(room) }))
        .filter((warning) => warning.message),
      cancellationPolicy: hotelPolicy?.cancellation_policy ?? CANCELLATION_PRESETS.night.moderate,
    },
  };
}
