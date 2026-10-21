import 'server-only';
import { z } from 'zod';
import { currentPolicyReferences } from '../content/service.js';
import { getPaymentConfiguration } from '../payments/gateway-settings.js';
import { HOTEL_POLICY, HotelError } from '../domain/hotel.js';
import { BookingQuoteError, quoteDigest, requireBookableListing } from './quotes.js';
import { withListingSnapshot } from './inventory.js';
import { stayQuoteIn } from './hotel-stays.js';

/**
 * Hotel checkout (hotel plan, Phase 7). A stay quote is stored in booking_quote
 * like any other quote, so review, hold, payment, settlement, refunds and the
 * customer record reuse the existing checkout. Shape differences:
 *  - one booking row (slot 'stay') per order; its rooms are booking_room rows
 *    (held → booked on confirmation, released on cancel/expiry, by trigger);
 *  - always prepaid in full; captured money is allocated as rent (room) + tax;
 *  - booking amounts carry the room total including tax in `rent`; the tax
 *    split lives on booking_room and in the visit snapshot.
 */
const room = z.object({
  roomTypeId: z.string().uuid(),
  ratePlanId: z.string().uuid(),
  adults: z.number().int().min(1).max(12),
  childAges: z.array(z.number().int().min(0).max(17)).max(12).default([]),
}).strict();
export const staySelectionSchema = z.object({
  kind: z.literal('stay'),
  rentableId: z.string().uuid(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rooms: z.array(room).min(1).max(HOTEL_POLICY.maxRooms),
}).strict();

/** Guest details collected at checkout. GSTIN is optional; when given, the business name is required. */
export const stayDetailsSchema = z.object({
  guestNames: z.array(z.string().trim().min(2, 'Enter the guest name for each room').max(80)).min(1).max(HOTEL_POLICY.maxRooms),
  arrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().or(z.literal('')),
  requests: z.string().trim().max(300).optional().or(z.literal('')),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN').optional().or(z.literal('')),
  businessName: z.string().trim().max(120).optional().or(z.literal('')),
}).strict().superRefine((value, context) => {
  if (value.gstin && !value.businessName) context.addIssue({ code: 'custom', path: ['businessName'], message: 'Enter the business name for the GST invoice' });
});

/** Visit, payment and policy snapshots in the shapes the existing checkout reads. */
function stayTerms(stay, payment, publications, names = {}) {
  const roomMinor = stay.totals.roomMinor;
  const taxMinor = stay.totals.taxMinor;
  const totalMinor = stay.totals.totalMinor;
  const nights = stay.lines[0].nights.length;
  const visit = {
    date: stay.checkIn, slot: 'stay', checkIn: stay.checkIn, checkOut: stay.checkOut, nights,
    startsAt: stay.startsAt, endsAt: stay.endsAt, blockedStartAt: stay.startsAt, blockedEndAt: stay.endsAt,
    rooms: stay.lines.map((line) => ({ roomTypeId: line.roomTypeId, name: names[line.roomTypeId] ?? 'Room', ratePlanId: line.ratePlanId, adults: line.adults,
      childAges: line.childAges, plan: line.plan, roomMinor: line.roomMinor, taxMinor: line.taxMinor, totalMinor: line.totalMinor })),
    rentMinor: totalMinor, roomMinor, taxMinor, feeMinor: 0, depositMinor: 0, illustrativeAdvanceMinor: totalMinor,
  };
  const paymentSnapshot = {
    version: payment.version, provider: payment.provider, environment: payment.environment, mode: payment.mode,
    enabled: payment.enabled, collectionPurpose: 'full', expectedMinor: totalMinor, actualCollectedMinor: 0,
    collectionPolicyVersion: HOTEL_POLICY.version, remainingMinor: 0,
    allocations: [{ date: stay.checkIn, rentMinor: roomMinor, taxMinor, feeMinor: 0, depositMinor: 0 }],
  };
  const policy = { version: HOTEL_POLICY.version, kind: 'stay', publications, hold: { minutes: HOTEL_POLICY.holdMinutes } };
  return {
    visits: [visit], payment: paymentSnapshot, policy,
    totals: { rentMinor: totalMinor, feeMinor: 0, depositMinor: 0, totalMinor, roomMinor, taxMinor, illustrativeAdvanceMinor: totalMinor },
    // The stay's own hash covers rooms, plans, nights and money; payment and policy versions are added.
    hash: quoteDigest({ stay: stay.hash, paymentVersion: payment.version, provider: payment.provider, publications }),
  };
}

async function priceStay(tx, listing, selection, now) {
  await requireBookableListing(tx, listing);
  const stay = await stayQuoteIn(tx, listing, selection, now);
  const payment = await getPaymentConfiguration(tx);
  const publications = await currentPolicyReferences(tx);
  const types = await tx`SELECT id,name FROM room_type WHERE rentable_id=${listing.id}`;
  const [profile] = await tx`SELECT check_in_minute,check_out_minute FROM hotel_profile WHERE rentable_id=${listing.id}`;
  const terms = stayTerms(stay, payment, publications, Object.fromEntries(types.map((t) => [t.id, t.name])));
  // Hotel times for the guest's screens; the instants are already in startsAt/endsAt.
  terms.policy.hotel = { checkInMinute: profile?.check_in_minute ?? null, checkOutMinute: profile?.check_out_minute ?? null };
  return { stay, ...terms };
}

/** Stored, advisory stay quote for a signed-in customer; reserves nothing. */
export async function createStayQuote(database, input, { customerId }) {
  const selection = staySelectionSchema.parse({ kind: 'stay', ...input });
  const [customer] = await database`SELECT id FROM "user" WHERE id=${customerId} AND role='customer' AND account_status='active'`;
  if (!customer) throw new BookingQuoteError('CUSTOMER_REQUIRED', 'Log in to book.');
  const quote = await withListingSnapshot(database, selection.rentableId, async (tx, listing) => {
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    return { ...(await priceStay(tx, listing, selection, now)), now };
  });
  if (!quote.payment.enabled) throw new BookingQuoteError('PAYMENTS_DISABLED', 'Online payment is not available right now.');
  const expiresAt = new Date(new Date(quote.now).getTime() + HOTEL_POLICY.holdMinutes * 60_000).toISOString();
  const [saved] = await database`
    INSERT INTO booking_quote (customer_id,intent_hash,rentable_id,currency,time_zone,selection,visit_snapshots,
      policy_snapshot,payment_snapshot,pricing_version,policy_version,version,quote_hash,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,created_at,expires_at)
    VALUES (${customerId},${quoteDigest(selection)},${selection.rentableId},'INR','Asia/Kolkata',${JSON.stringify(selection)}::text::jsonb,
      ${JSON.stringify(quote.visits)}::text::jsonb,${JSON.stringify(quote.policy)}::text::jsonb,${JSON.stringify(quote.payment)}::text::jsonb,
      ${HOTEL_POLICY.version},${HOTEL_POLICY.version},1,${quote.hash},${quote.totals.rentMinor},0,0,${new Date(quote.now).toISOString()},${expiresAt}) RETURNING id`;
  return { id: saved.id, version: 1, hash: quote.hash, expiresAt, selection, visits: quote.visits, totals: quote.totals };
}

/**
 * Under the listing mutex at hold time: the saved quote must still be this
 * customer's, unexpired, and price to the same hash with rooms free.
 */
export async function revalidateStayQuote(tx, listing, saved, { hash, version }) {
  if (saved.quote_hash !== hash || saved.version !== version) throw new BookingQuoteError('QUOTE_NOT_FOUND', 'Request a new quote for this account.');
  const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
  if (new Date(saved.expires_at) <= new Date(now)) throw new BookingQuoteError('QUOTE_EXPIRED', 'This price expired. Check the rooms again.');
  let quote;
  try {
    quote = await priceStay(tx, listing, staySelectionSchema.parse(saved.selection), now);
  } catch (error) {
    if (error instanceof HotelError && ['SOLD_OUT', 'ROOM_UNAVAILABLE', 'CLOSED', 'MIN_NIGHTS'].includes(error.code)) {
      throw new BookingQuoteError('AVAILABILITY_CONFLICT', error.message);
    }
    throw error;
  }
  if (quote.hash !== saved.quote_hash) throw new BookingQuoteError('QUOTE_CHANGED', 'The price or rooms changed. Review the new price.');
  return { ...quote, id: saved.id, version: saved.version, now, expiresAt: new Date(saved.expires_at).toISOString() };
}

/**
 * Before the payment is dispatched: the held rooms are this order's, so only
 * the quote's life and the accepted payment/policy terms are rechecked here.
 * Prices were locked when the rooms were held.
 */
export async function revalidateHeldStayTerms(tx, order) {
  const [saved] = await tx`SELECT expires_at FROM booking_quote WHERE id=${order.quote_id} AND customer_id=${order.customer_id}`;
  if (!saved) throw new BookingQuoteError('QUOTE_NOT_FOUND', 'Request a fresh quote.');
  const [rooms] = await tx`SELECT count(*)::int AS held FROM booking_room br JOIN booking b ON b.id=br.booking_id
    WHERE b.order_id=${order.id} AND br.state='held'`;
  if (!rooms.held) throw new BookingQuoteError('HOLD_EXPIRED', 'These rooms are no longer held.');
}
