import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { withListingInventory, expireInventoryHolds } from './inventory.js';
import { quoteDigest, revalidateBookingQuote } from './quotes.js';
import { requireNewPaymentConfiguration } from '../payments/gateway-settings.js';
import { requirePaymentCredentials } from '../payments/provider-credentials.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';
import { HOTEL_POLICY } from '../domain/hotel.js';
import { revalidateStayQuote, stayDetailsSchema } from './hotel-checkout.js';
import { holdHotelRooms } from './hotel-stays.js';

const MAX_LIVE_HOLDS = 3;

export class CheckoutError extends Error {
  constructor(code, message = code) { super(message); this.code = code; this.name = 'CheckoutError'; }
}
const inputSchema = z.object({ rentableId: z.string().uuid(), quoteId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/), version: z.number().int().positive(),
  idempotencyKey: z.string().uuid(), accepted: z.literal(true), purpose: z.string().trim().min(3).max(160).optional(),
  stay: stayDetailsSchema.optional(), petsConfirmed: z.boolean().optional() }).strict();

/** Story 3.9: declared pets need the guest's tick on the listing's own rule before anything is held. */
function confirmedPets(pets, value) {
  if (!pets) return null;
  if (value.petsConfirmed !== true) throw new CheckoutError('PETS_UNCONFIRMED', 'Confirm your pets meet this stay’s pet rules.');
  return { ...pets, confirmed: true };
}

export async function lifecycle(tx, orderId, kind, payload = {}) {
  await tx`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${orderId},${kind},${JSON.stringify(payload)}::text::jsonb)
    ON CONFLICT(order_id,kind) DO NOTHING`;
}
export async function checkoutStatus(tx, orderId) {
  const [row] = await tx`SELECT b.id,b.reference,b.state,b.hold_expires_at,p.id payment_order_id,p.state payment_state,
    p.provider_order_id,p.expected_minor,e.credential_key_id,e.state execution_state,
    EXISTS(SELECT 1 FROM booking_lifecycle_event WHERE order_id=b.id AND kind='refund_required') needs_resolution,
    (SELECT CASE WHEN bool_or(kind='owner_declined') THEN 'declined' WHEN bool_or(kind='owner_approved') THEN 'approved' ELSE 'pending' END
      FROM booking_lifecycle_event WHERE order_id=b.id AND kind IN ('approval_requested','owner_approved','owner_declined')
      HAVING bool_or(kind='approval_requested')) approval
    FROM booking_order b JOIN payment_order p ON p.booking_order_id=b.id
    JOIN payment_execution e ON e.payment_order_id=p.id WHERE b.id=${orderId}`;
  if (!row) throw new CheckoutError('CHECKOUT_NOT_FOUND');
  return { orderId: row.id, reference: row.reference, state: row.state, paymentOrderId: row.payment_order_id,
    paymentState: row.payment_state, executionState: row.execution_state, providerOrderId: row.provider_order_id,
    keyId: row.credential_key_id, expectedMinor: Number(row.expected_minor), currency: 'INR', environment: 'test',
    serverNow: new Date().toISOString(), actualCollectedMinor: 0, needsResolution: row.needs_resolution,
    // null: instant book; else the owner's answer to this request ('pending' | 'approved' | 'declined').
    approval: row.approval ?? null,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null };
}

/**
 * Request to book (rentable.instant_book = false): the dates are held while the owner decides, and no
 * payment can start until they approve. The owner hears about it on their updates feed.
 */
async function requestApproval(tx, listing, orderId, expires) {
  await lifecycle(tx, orderId, 'approval_requested', { respondBy: expires.toISOString() });
  await tx`SELECT client_update_insert(${listing.client_id},${'request:' + orderId},'booking','action','booking_requested',${listing.id},${orderId},
    ${JSON.stringify({ respondBy: expires.toISOString() })}::text::jsonb,now())`;
}
const requestMinutes = (listing, minutes) => (listing.instant_book === false ? BOOKING_POLICY.requestHours * 60 : minutes);

/** Shared deadline for either booking model; checkout can never reserve past arrival. */
export function checkoutHoldDeadline(now, startsAt, minutes = BOOKING_POLICY.holdMinutes) {
  const expires = new Date(Math.min(+new Date(now) + minutes * 60000, +new Date(startsAt)));
  if (expires <= new Date(now)) throw new CheckoutError('VISIT_ALREADY_STARTED');
  return expires;
}

/** Listing -> customer/session -> gateway mutex -> payment rows; no network. */
export async function createCheckoutHold(database, session, input, env = process.env) {
  const value = inputSchema.parse(input);
  const requestHash = quoteDigest(value);
  return withListingInventory(database, value.rentableId, async (tx, listing) => {
    const customer = await lockCustomerAccount(tx, session, env);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${customer.id + ':' + value.idempotencyKey}, 0))`;
    const [existing] = await tx`SELECT id,request_hash,rentable_id FROM booking_order WHERE customer_id=${customer.id} AND idempotency_key=${value.idempotencyKey}`;
    if (existing) {
      if (existing.request_hash !== requestHash || existing.rentable_id !== listing.id) throw new CheckoutError('IDEMPOTENCY_CONFLICT');
      await expireInventoryHolds(tx, listing.id);
      return checkoutStatus(tx, existing.id);
    }
    await tx`SELECT pg_advisory_xact_lock(73420, 1)`;
    // Holds cost nothing to create and court inventory is contested: cap live holds per customer.
    const [{ held }] = await tx`SELECT count(*)::int AS held FROM booking_order
      WHERE customer_id=${customer.id} AND state='held' AND hold_expires_at > clock_timestamp()`;
    if (held >= MAX_LIVE_HOLDS) throw new CheckoutError('TOO_MANY_HOLDS', 'Finish or release one of your open checkouts first.');
    const [savedQuote] = await tx`SELECT * FROM booking_quote WHERE id=${value.quoteId} AND rentable_id=${listing.id} AND customer_id=${customer.id}`;
    if (savedQuote?.selection?.kind === 'stay') return holdStay(tx, listing, customer, value, savedQuote, requestHash, env);
    const quote = await revalidateBookingQuote(tx, listing, { ...value, customerId: customer.id }, env);
    const pets = confirmedPets(quote.policy.pets, value);
    if (pets) quote.policy = { ...quote.policy, pets };
    // A time-booked visit gets its court now, under the listing mutex: the requested court, else the first free one.
    let court = null;
    if (quote.selection.kind === 'hourly') {
      court = quote.freeCourts?.[0] ?? null;
      if (!court) throw new CheckoutError('AVAILABILITY_CONFLICT', 'That time is no longer free.');
    }
    await requireNewPaymentConfiguration(tx, { expectedVersion: quote.payment.version }, env);
    const credentials = requirePaymentCredentials(quote.payment.provider, quote.payment.environment, env);
    if (quote.payment.provider !== 'razorpay' || quote.payment.environment !== 'test' || quote.payment.expectedMinor < 100) throw new CheckoutError('INVALID_COLLECTION');
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    const nowDate = new Date(now);
    if (new Date(quote.expiresAt) <= nowDate) throw new CheckoutError('QUOTE_EXPIRED');
    const expires = checkoutHoldDeadline(nowDate, quote.visits[0].startsAt, requestMinutes(listing, BOOKING_POLICY.holdMinutes));
    const orderId = randomUUID(), paymentId = randomUUID();
    const listingSnapshot = { ownerId: listing.client_id, photos: listing.photos ?? [], title: listing.title, publicCode: listing.public_code, rentableId: listing.id, purpose: value.purpose ?? null, contact: { name: customer.name, phone: customer.phone } };
    await tx`INSERT INTO booking_order(id,reference,customer_id,rentable_id,state,currency,time_zone,quote_id,quote_version,quote_hash,
      quote_expires_at,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,
      amount_deposit_minor,amount_advance_minor,payment_mode,visit_provenance,idempotency_key,request_hash,hold_expires_at)
      VALUES(${orderId},${'TEST_' + orderId},${customer.id},${listing.id},'held','INR',${quote.timeZone},${quote.id},${quote.version},${quote.hash},
      ${quote.expiresAt},${quote.pricingVersion},${quote.policy.version},${JSON.stringify(quote.policy)}::text::jsonb,${JSON.stringify(listingSnapshot)}::text::jsonb,
      ${quote.totals.rentMinor},${quote.totals.feeMinor},${quote.totals.depositMinor},${quote.totals.illustrativeAdvanceMinor},
      'real','test',${value.idempotencyKey},${requestHash},${expires.toISOString()})`;
    for (const [position, visit] of quote.visits.entries()) {
      const id = randomUUID();
      // Listing and policy snapshots, and the pricing/policy versions, live on the order.
      const snapshot = court ? { ...visit, resourceId: court.id, resourceName: court.name } : visit;
      await tx`INSERT INTO booking(id,reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,
        starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,
        amount_rent_minor,amount_fee_minor,amount_deposit_minor,amount_advance_minor,payment_mode,visit_provenance,slot_snapshot,resource_id)
        VALUES(${id},${'T' + id.replaceAll('-','').slice(0,15)},${listing.id},${customer.id},${orderId},${position+1},${visit.date},${visit.slot},${quote.selection.guests},
        ${visit.startsAt},${visit.endsAt},${visit.blockedStartAt},${visit.blockedEndAt},true,'INR',${quote.timeZone},
        ${visit.rentMinor},${visit.feeMinor},${visit.depositMinor},${visit.illustrativeAdvanceMinor},'real','test',
        ${JSON.stringify(snapshot)}::text::jsonb,${court?.id ?? null})`;
      await tx`INSERT INTO inventory_reservation(booking_id,rentable_id,resource_id,source,blocked_start_at,blocked_end_at,state,hold_expires_at)
        VALUES(${id},${listing.id},${court?.id ?? null},'booking',${visit.blockedStartAt},${visit.blockedEndAt},'held',${expires.toISOString()})`;
    }
    await tx`INSERT INTO payment_order(id,booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,due_at)
      VALUES(${paymentId},${orderId},'razorpay','test','real','INR',${quote.payment.collectionPurpose},${quote.payment.expectedMinor},${value.idempotencyKey},${requestHash},${expires.toISOString()})`;
    await tx`INSERT INTO payment_execution(payment_order_id,config_version,credential_key_id,snapshot)
      VALUES(${paymentId},${quote.payment.version},${credentials.keyId},${JSON.stringify(quote.payment)}::text::jsonb)`;
    await lifecycle(tx, orderId, 'held', { environment: 'test', actualCollectedMinor: 0, acceptedPublicPolicies: quote.policy.publications, accepted: true });
    if (listing.instant_book === false) await requestApproval(tx, listing, orderId, expires);
    return checkoutStatus(tx, orderId);
  });
}

/**
 * Hotel stay (hotel plan, Phase 7): one 'stay' booking whose rooms are held as
 * booking_room rows; the payment is the full total, allocated as room + tax.
 */
async function holdStay(tx, listing, customer, value, saved, requestHash, env) {
  if (!value.stay) throw new CheckoutError('GUEST_DETAILS_REQUIRED', 'Add the guest details for each room.');
  const quote = await revalidateStayQuote(tx, listing, saved, value);
  const pets = confirmedPets(quote.policy.pets, value);
  if (pets) quote.policy = { ...quote.policy, pets };
  if (value.stay.guestNames.length !== quote.stay.lines.length) throw new CheckoutError('GUEST_DETAILS_REQUIRED', 'Add a guest name for each room.');
  await requireNewPaymentConfiguration(tx, { expectedVersion: quote.payment.version }, env);
  const credentials = requirePaymentCredentials(quote.payment.provider, quote.payment.environment, env);
  if (quote.payment.provider !== 'razorpay' || quote.payment.environment !== 'test' || quote.payment.expectedMinor < 100) throw new CheckoutError('INVALID_COLLECTION');
  const nowDate = new Date(quote.now);
  const expires = checkoutHoldDeadline(nowDate, quote.visits[0].startsAt, requestMinutes(listing, HOTEL_POLICY.holdMinutes));
  const orderId = randomUUID(), paymentId = randomUUID(), bookingId = randomUUID();
  const visit = quote.visits[0];
  const guests = quote.stay.lines.reduce((sum, line) => sum + line.adults + line.childAges.length, 0);
  const listingSnapshot = { ownerId: listing.client_id, photos: listing.photos ?? [], title: listing.title, publicCode: listing.public_code,
    rentableId: listing.id, purpose: null, contact: { name: customer.name, phone: customer.phone } };
  const details = { ...value.stay, gstin: value.stay.gstin || null, businessName: value.stay.businessName || null,
    arrivalTime: value.stay.arrivalTime || null, requests: value.stay.requests || null,
    // Story 3.9: the declaration as accepted, with the pet policy version it was made under.
    ...(pets ? { pets: { count: pets.count, confirmation: pets.confirmation, confirmed: true, policyVersion: quote.policy.petPolicy.version } } : {}) };
  await tx`INSERT INTO booking_order(id,reference,customer_id,rentable_id,state,currency,time_zone,quote_id,quote_version,quote_hash,
    quote_expires_at,pricing_version,policy_version,policy_snapshot,listing_snapshot,guest_details,amount_rent_minor,amount_fee_minor,
    amount_deposit_minor,amount_advance_minor,payment_mode,visit_provenance,idempotency_key,request_hash,hold_expires_at)
    VALUES(${orderId},${'TEST_' + orderId},${customer.id},${listing.id},'held','INR','Asia/Kolkata',${quote.id},${quote.version},${quote.hash},
    ${quote.expiresAt},${HOTEL_POLICY.version},${HOTEL_POLICY.version},${JSON.stringify(quote.policy)}::text::jsonb,${JSON.stringify(listingSnapshot)}::text::jsonb,
    ${JSON.stringify(details)}::text::jsonb,${quote.totals.rentMinor},${quote.totals.feeMinor ?? 0},0,${quote.totals.totalMinor},'real','test',${value.idempotencyKey},${requestHash},${expires.toISOString()})`;
  await tx`INSERT INTO booking(id,reference,rentable_id,customer_id,order_id,item_position,local_day,slot,guests,
    starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,
    amount_rent_minor,amount_fee_minor,amount_deposit_minor,amount_advance_minor,payment_mode,visit_provenance,slot_snapshot)
    VALUES(${bookingId},${'T' + bookingId.replaceAll('-', '').slice(0, 15)},${listing.id},${customer.id},${orderId},1,${visit.date},'stay',${guests},
    ${visit.startsAt},${visit.endsAt},${visit.blockedStartAt},${visit.blockedEndAt},true,'INR','Asia/Kolkata',
    ${visit.rentMinor},${visit.feeMinor ?? 0},0,${visit.rentMinor + (visit.feeMinor ?? 0)},'real','test',${JSON.stringify(visit)}::text::jsonb)`;
  // The same rooms, plans and money as the quote, or QUOTE_CHANGED / SOLD_OUT (checked again under this lock).
  await holdHotelRooms(tx, listing, { bookingId, quote: quote.stay, guestNames: value.stay.guestNames, now: nowDate });
  await tx`INSERT INTO payment_order(id,booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,due_at)
    VALUES(${paymentId},${orderId},'razorpay','test','real','INR','full',${quote.payment.expectedMinor},${value.idempotencyKey},${requestHash},${expires.toISOString()})`;
  await tx`INSERT INTO payment_execution(payment_order_id,config_version,credential_key_id,snapshot)
    VALUES(${paymentId},${quote.payment.version},${credentials.keyId},${JSON.stringify(quote.payment)}::text::jsonb)`;
  await lifecycle(tx, orderId, 'held', { environment: 'test', actualCollectedMinor: 0, acceptedPublicPolicies: quote.policy.publications, accepted: true });
  if (listing.instant_book === false) await requestApproval(tx, listing, orderId, expires);
  return checkoutStatus(tx, orderId);
}

export async function ownedCheckout(database, session, orderId, run, env = process.env) {
  z.string().uuid().parse(orderId);
  const [scope] = await database`SELECT rentable_id FROM booking_order WHERE id=${orderId}`;
  if (!scope) throw new CheckoutError('CHECKOUT_NOT_FOUND');
  return withListingInventory(database, scope.rentable_id, async (tx, listing) => {
    await lockCustomerAccount(tx, session, env);
    const [order] = await tx`SELECT * FROM booking_order WHERE id=${orderId} AND customer_id=${session.userId}`;
    if (!order) throw new CheckoutError('CHECKOUT_NOT_FOUND');
    await expireInventoryHolds(tx, order.rentable_id);
    return run(tx, order, listing);
  });
}
export async function readCheckoutStatus(database, session, orderId, env = process.env) {
  return ownedCheckout(database, session, orderId, tx => checkoutStatus(tx, orderId), env);
}

/** Release only a never-dispatched hold. Unknown provider outcomes must reconcile instead. */
export async function releaseUnstartedCheckout(database, session, orderId, env = process.env) {
  return ownedCheckout(database, session, orderId, async tx => {
    const current = await checkoutStatus(tx, orderId);
    if (current.state === 'expired') return current;
    if (current.state !== 'held' || current.executionState !== 'ready') throw new CheckoutError('PAYMENT_ALREADY_STARTED');
    await tx`UPDATE booking_order SET state='expired',updated_at=clock_timestamp() WHERE id=${orderId} AND state='held'`;
    await tx`UPDATE inventory_reservation r SET state='expired',released_at=clock_timestamp()
      FROM booking b WHERE r.booking_id=b.id AND b.order_id=${orderId} AND r.state='held'`;
    await tx`UPDATE booking SET state='cancelled',cancelled_at=clock_timestamp(),cancelled_by_kind='customer',cancellation_reason='Customer requested a new quote',
      lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp() WHERE order_id=${orderId} AND state='requested'`;
    await lifecycle(tx, orderId, 'expired', { environment:'test', reason:'quote_replacement' });
    return checkoutStatus(tx, orderId);
  }, env);
}
