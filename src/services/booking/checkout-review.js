import 'server-only';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { ownedCheckout, checkoutStatus, CheckoutError } from './checkout.js';
import { savedListingHref } from '../domain/saved-places.js';
import { normalizePublicPhotos } from '../domain/listing-content.js';

function review(row) {
  return { id: row.id, version: row.version, hash: row.quote_hash, selection: row.selection,
    visits: row.visit_snapshots, policy: row.policy_snapshot, payment: row.payment_snapshot,
    timeZone: row.time_zone, expiresAt: new Date(row.expires_at).toISOString(),
    totals: { rentMinor: Number(row.amount_rent_minor), feeMinor: Number(row.amount_fee_minor),
      totalMinor: Number(row.amount_rent_minor) + Number(row.amount_fee_minor), depositMinor: Number(row.amount_deposit_minor) } };
}
// Public listing facts only (photo, locality, rating): the same allowlist a browsing guest sees.
async function details(tx, quote, customer, snapshot = null) {
  const [listing] = await tx`SELECT r.title,r.slug,r.public_code,r.photos,r.rating_avg,r.review_count,a.name area,c.name city
    FROM rentable r JOIN area a ON a.id=r.area_id JOIN city c ON c.id=r.city_id WHERE r.id=${quote.selection.rentableId}`;
  const [photo] = normalizePublicPhotos(snapshot?.photos ?? listing.photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME });
  return { quote, title: snapshot?.title ?? listing.title,
    photo: photo ? { url: photo.url, alt: photo.alt } : null, area: `${listing.area}, ${listing.city}`,
    rating: Number(listing.rating_avg) || 0, reviewCount: listing.review_count ?? 0,
    contact: { name: snapshot?.contact?.name ?? customer.name ?? '', phone: snapshot?.contact?.phone ?? customer.phone ?? '' }, purpose: snapshot?.purpose ?? '',
    listingHref: savedListingHref(`/listing/${listing.slug}-${listing.public_code}`, quote.selection),
    serverNow: new Date().toISOString() };
}
export async function readCheckoutReview(database, session, quoteId, env = process.env) {
  z.string().uuid().parse(quoteId);
  return database.begin(async tx => {
    const customer = await lockCustomerAccount(tx, session, env);
    const [row] = await tx`SELECT * FROM booking_quote WHERE id=${quoteId} AND customer_id=${customer.id}`;
    if (!row) throw new CheckoutError('CHECKOUT_NOT_FOUND');
    const [existing] = await tx`SELECT id FROM booking_order WHERE quote_id=${quoteId} AND customer_id=${customer.id} ORDER BY created_at DESC LIMIT 1`;
    return { ...await details(tx, review(row), customer), existingOrderId: existing?.id ?? null };
  });
}
export async function readOwnedCheckoutReview(database, session, orderId, env = process.env) {
  return ownedCheckout(database, session, orderId, async (tx, order) => {
    const visits = await tx`SELECT slot,guests,slot_snapshot FROM booking WHERE order_id=${orderId} ORDER BY item_position`;
    const [payment] = await tx`SELECT e.snapshot FROM payment_execution e JOIN payment_order p ON p.id=e.payment_order_id WHERE p.booking_order_id=${orderId}`;
    if (!visits.length || !payment) throw new CheckoutError('CHECKOUT_NOT_FOUND');
    // Accepted order/visit/payment snapshots are protected by database triggers.
    // Do not repaint an existing checkout from a later edited listing or advisory quote.
    const quote = { id:order.quote_id, version:order.quote_version, hash:order.quote_hash,
      selection:{rentableId:order.rentable_id,dates:visits.map(v=>v.slot_snapshot.date),slot:visits[0].slot,guests:visits[0].guests,currency:order.currency},
      visits:visits.map(v=>v.slot_snapshot), policy:order.policy_snapshot, payment:payment.snapshot,
      timeZone:order.time_zone, expiresAt:new Date(order.quote_expires_at).toISOString(),
      totals:{rentMinor:Number(order.amount_rent_minor),feeMinor:Number(order.amount_fee_minor),
        totalMinor:Number(order.amount_rent_minor)+Number(order.amount_fee_minor),depositMinor:Number(order.amount_deposit_minor)} };
    return { ...await details(tx, quote, {}, order.listing_snapshot), checkout: await checkoutStatus(tx, orderId) };
  }, env);
}

export async function recentCustomerCheckouts(database, session, env = process.env) {
  return database.begin(async tx => {
    const customer = await lockCustomerAccount(tx, session, env);
    const rows = await tx`SELECT b.id,b.reference,b.listing_snapshot->>'title' title FROM booking_order b
      WHERE b.customer_id=${customer.id} AND EXISTS(SELECT 1 FROM payment_order p JOIN payment_execution e ON e.payment_order_id=p.id WHERE p.booking_order_id=b.id)
      ORDER BY b.created_at DESC LIMIT 20`;
    return rows.map(row => ({ id: row.id, reference: row.reference, title: row.title }));
  });
}
