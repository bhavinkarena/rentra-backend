import 'server-only';
import { z } from 'zod';
import { lockCustomerAccount, CustomerAccountError } from '../auth/customer-access.js';
import { guestSavedSchema, savedEntrySchema, SAVED_LIMIT, validSavedSelection, savedListingHref } from '../domain/saved-places.js';
import { listingPath } from '../domain/listing-url.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';

/** Public allowlist only. Unpublished/deleted records deliberately have no listing metadata. */
export async function savedPlaceCards(database, entries) {
  if (!entries.length) return [];
  const ids = entries.map(e => e.rentableId);
  const rows = await database`SELECT r.id,r.title,r.slug,r.public_code,r.photos,a.name AS area,c.name AS city
    FROM rentable r JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id
    WHERE r.id IN ${database(ids)} AND r.status='live'`;
  return entries.map(e => {
    const row = rows.find(r => r.id === e.rentableId);
    const selection = validSavedSelection(e.selection, e.rentableId);
    const normalizedPhoto = row ? normalizePublicPhotos(row.photos, {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    })[0] ?? null : null;
    const photo = normalizedPhoto
      ? { url: normalizedPhoto.url, alt: normalizedPhoto.alt } : null;
    return row ? { rentableId:e.rentableId, selection, available:true, title:row.title,
      area:`${row.area}, ${row.city}`, photo, href:savedListingHref(listingPath(row.slug,row.public_code),selection) }
      : { rentableId:e.rentableId, selection, available:false, title:'Unavailable place' };
  });
}
async function ownedEntries(tx, userId) {
  const rows = await tx`SELECT rentable_id,selection FROM customer_favourite WHERE customer_id=${userId} AND active=true ORDER BY saved_at DESC,rentable_id LIMIT ${SAVED_LIMIT}`;
  return rows.map(r => ({ rentableId:r.rentable_id,selection:r.selection }));
}
export async function readCustomerSaved(database, session, env=process.env) {
  return database.begin(async tx => {
    const user = await lockCustomerAccount(tx,session,env);
    return savedPlaceCards(tx,await ownedEntries(tx,user.id));
  });
}
// Parse selection independently so caller-supplied prices/identity are rejected, not stored.
export async function changeCustomerSaved(database, session, input, env=process.env) {
  const value = z.object({ rentableId:z.string().uuid(),saved:z.boolean(),selection:z.unknown().optional() }).strict().parse(input);
  if (value.selection != null) savedEntrySchema.parse({ rentableId:value.rentableId,entryId:value.rentableId,selection:value.selection });
  const selection = validSavedSelection(value.selection,value.rentableId);
  return database.begin(async tx => {
    const user = await lockCustomerAccount(tx,session,env);
    const [existing] = await tx`SELECT active,selection FROM customer_favourite WHERE customer_id=${user.id} AND rentable_id=${value.rentableId}`;
    if (value.saved) {
      if (!existing) {
        const [live] = await tx`SELECT id FROM rentable WHERE id=${value.rentableId} AND status='live' FOR SHARE`;
        if (!live) throw new CustomerAccountError('This place is no longer available to save.');
      }
      if (!existing?.active && (await ownedEntries(tx,user.id)).length >= SAVED_LIMIT) throw new CustomerAccountError(`You can save up to ${SAVED_LIMIT} places. Remove one first.`);
      await tx`INSERT INTO customer_favourite(customer_id,rentable_id,selection) VALUES (${user.id},${value.rentableId},${JSON.stringify(selection ?? existing?.selection ?? null)}::jsonb)
        ON CONFLICT(customer_id,rentable_id) DO UPDATE SET active=true,selection=excluded.selection,saved_at=now()`;
    } else {
      await tx`UPDATE customer_favourite SET active=false WHERE customer_id=${user.id} AND rentable_id=${value.rentableId}`;
    }
    return savedPlaceCards(tx,await ownedEntries(tx,user.id));
  });
}

/** Receipt per guest save prevents replay from resurrecting a later account removal. */
export async function mergeCustomerSaved(database, session, input, env=process.env) {
  const entries = guestSavedSchema.parse(input);
  return database.begin(async tx => {
    const user = await lockCustomerAccount(tx,session,env);
    if (entries.length) {
      const receipts = await tx`SELECT entry_id FROM customer_favourite_merge WHERE customer_id=${user.id} AND entry_id IN ${tx(entries.map(e=>e.entryId))}`;
      const seen = new Set(receipts.map(r=>r.entry_id));
      const fresh = entries.filter(e=>!seen.has(e.entryId));
      const active = await ownedEntries(tx,user.id);
      const activeIds = new Set(active.map(e=>e.rentableId));
      const additions = fresh.filter(e=>!activeIds.has(e.rentableId));
      if (active.length+additions.length>SAVED_LIMIT) throw new CustomerAccountError('Your saved list is full. Remove a place, then retry merging.');
      if (fresh.length) {
        const records=fresh.map(e=>({customer_id:user.id,entry_id:e.entryId}));
        await tx`INSERT INTO customer_favourite_merge ${tx(records,'customer_id','entry_id')} ON CONFLICT DO NOTHING`;
      }
      if (additions.length) {
        const records=additions.map(e=>({customer_id:user.id,rentable_id:e.rentableId,selection:validSavedSelection(e.selection,e.rentableId)}));
        await tx`INSERT INTO customer_favourite(customer_id,rentable_id,selection)
          SELECT customer_id,rentable_id,selection FROM jsonb_to_recordset(${JSON.stringify(records)}::text::jsonb) AS incoming(customer_id uuid,rentable_id uuid,selection jsonb)
          ON CONFLICT(customer_id,rentable_id) DO UPDATE SET active=true,selection=excluded.selection,saved_at=now()`;
      }
    }
    return savedPlaceCards(tx,await ownedEntries(tx,user.id));
  });
}
