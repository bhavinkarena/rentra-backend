import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { withListingInventory, expireInventoryHolds } from './inventory.js';
import { quoteDigest, revalidateBookingQuote } from './quotes.js';
import { requireNewPaymentConfiguration } from '../payments/gateway-settings.js';
import { requirePaymentCredentials } from '../payments/provider-credentials.js';
import { BOOKING_POLICY } from '../domain/booking-policy.js';

export class CheckoutError extends Error {
  constructor(code, message = code) { super(message); this.code = code; this.name = 'CheckoutError'; }
}
const inputSchema = z.object({ rentableId: z.string().uuid(), quoteId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/), version: z.number().int().positive(),
  idempotencyKey: z.string().uuid(), accepted: z.literal(true), purpose: z.string().trim().min(3).max(160).optional() }).strict();

export async function lifecycle(tx, orderId, kind, payload = {}) {
  await tx`INSERT INTO booking_lifecycle_event(order_id,kind,payload) VALUES(${orderId},${kind},${JSON.stringify(payload)}::jsonb)
    ON CONFLICT(order_id,kind) DO NOTHING`;
}
export async function checkoutStatus(tx, orderId) {
  const [row] = await tx`SELECT b.id,b.reference,b.state,b.hold_expires_at,p.id payment_order_id,p.state payment_state,
    p.provider_order_id,p.expected_minor,e.credential_key_id,e.state execution_state,
    EXISTS(SELECT 1 FROM booking_lifecycle_event WHERE order_id=b.id AND kind='refund_required') needs_resolution
    FROM booking_order b JOIN payment_order p ON p.booking_order_id=b.id
    JOIN payment_execution e ON e.payment_order_id=p.id WHERE b.id=${orderId}`;
  if (!row) throw new CheckoutError('CHECKOUT_NOT_FOUND');
  return { orderId: row.id, reference: row.reference, state: row.state, paymentOrderId: row.payment_order_id,
    paymentState: row.payment_state, executionState: row.execution_state, providerOrderId: row.provider_order_id,
    keyId: row.credential_key_id, expectedMinor: Number(row.expected_minor), currency: 'INR', environment: 'test',
    serverNow: new Date().toISOString(), actualCollectedMinor: 0, needsResolution: row.needs_resolution,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null };
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
    const quote = await revalidateBookingQuote(tx, listing, { ...value, customerId: customer.id }, env);
    await requireNewPaymentConfiguration(tx, { expectedVersion: quote.payment.version }, env);
    const credentials = requirePaymentCredentials(quote.payment.provider, quote.payment.environment, env);
    if (quote.payment.provider !== 'razorpay' || quote.payment.environment !== 'test' || quote.payment.expectedMinor < 100) throw new CheckoutError('INVALID_COLLECTION');
    const [{ now }] = await tx`SELECT clock_timestamp() AS now`;
    const nowDate = new Date(now);
    if (new Date(quote.expiresAt) <= nowDate) throw new CheckoutError('QUOTE_EXPIRED');
    const expires = new Date(Math.min(+nowDate + BOOKING_POLICY.holdMinutes * 60000, +new Date(quote.visits[0].startsAt)));
    if (expires <= nowDate) throw new CheckoutError('VISIT_ALREADY_STARTED');
    const orderId = randomUUID(), paymentId = randomUUID();
    const listingSnapshot = { title: listing.title, publicCode: listing.public_code, rentableId: listing.id, purpose: value.purpose ?? null, contact: { name: customer.name, phone: customer.phone } };
    await tx`INSERT INTO booking_order(id,reference,customer_id,rentable_id,state,currency,time_zone,quote_id,quote_version,quote_hash,
      quote_expires_at,pricing_version,policy_version,policy_snapshot,listing_snapshot,amount_rent_minor,amount_fee_minor,
      amount_deposit_minor,amount_advance_minor,payment_mode,visit_provenance,idempotency_key,request_hash,hold_expires_at)
      VALUES(${orderId},${'TEST_' + orderId},${customer.id},${listing.id},'held','INR',${quote.timeZone},${quote.id},${quote.version},${quote.hash},
      ${quote.expiresAt},${quote.pricingVersion},${quote.policy.version},${JSON.stringify(quote.policy)}::jsonb,${JSON.stringify(listingSnapshot)}::jsonb,
      ${quote.totals.rentMinor},${quote.totals.feeMinor},${quote.totals.depositMinor},${quote.totals.illustrativeAdvanceMinor},
      'real','test',${value.idempotencyKey},${requestHash},${expires.toISOString()})`;
    for (const [position, visit] of quote.visits.entries()) {
      const id = randomUUID();
      const legacy = [visit.rentMinor, visit.feeMinor, visit.depositMinor].map(v => Math.floor(v / 100));
      if (legacy.some(v => v > 2147483647)) throw new CheckoutError('ORDER_AMOUNT_UNSUPPORTED');
      await tx`INSERT INTO booking(id,reference,rentable_id,customer_id,order_id,item_position,day,local_day,slot,guests,
        starts_at,ends_at,blocked_start_at,blocked_end_at,hours_known,currency,time_zone,amount_rent,amount_fee,amount_deposit,
        amount_rent_minor,amount_fee_minor,amount_deposit_minor,amount_advance_minor,payment_mode,visit_provenance,
        policy_version,pricing_version,listing_snapshot,policy_snapshot,slot_snapshot,price_snapshot)
        VALUES(${id},${'T' + id.replaceAll('-','').slice(0,15)},${listing.id},${customer.id},${orderId},${position+1},${visit.date},${visit.date},${visit.slot},${quote.selection.guests},
        ${visit.startsAt},${visit.endsAt},${visit.blockedStartAt},${visit.blockedEndAt},true,'INR',${quote.timeZone},${legacy[0]},${legacy[1]},${legacy[2]},
        ${visit.rentMinor},${visit.feeMinor},${visit.depositMinor},${visit.illustrativeAdvanceMinor},'real','test',${quote.policy.version},${quote.pricingVersion},
        ${JSON.stringify(listingSnapshot)}::jsonb,${JSON.stringify(quote.policy)}::jsonb,${JSON.stringify(visit)}::jsonb,${JSON.stringify(visit)}::jsonb)`;
      await tx`INSERT INTO inventory_reservation(booking_id,rentable_id,source,blocked_start_at,blocked_end_at,state,hold_expires_at)
        VALUES(${id},${listing.id},'booking',${visit.blockedStartAt},${visit.blockedEndAt},'held',${expires.toISOString()})`;
    }
    await tx`INSERT INTO payment_order(id,booking_order_id,provider,environment,mode,currency,purpose,expected_minor,idempotency_key,request_hash,due_at)
      VALUES(${paymentId},${orderId},'razorpay','test','real','INR',${quote.payment.collectionPurpose},${quote.payment.expectedMinor},${value.idempotencyKey},${requestHash},${expires.toISOString()})`;
    await tx`INSERT INTO payment_execution(payment_order_id,config_version,credential_key_id,snapshot)
      VALUES(${paymentId},${quote.payment.version},${credentials.keyId},${JSON.stringify(quote.payment)}::jsonb)`;
    await lifecycle(tx, orderId, 'held', { environment: 'test', actualCollectedMinor: 0 });
    return checkoutStatus(tx, orderId);
  });
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
    await tx`UPDATE booking SET state='cancelled',cancelled_at=clock_timestamp(),cancellation_reason='Customer requested a new quote',
      lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp() WHERE order_id=${orderId} AND state='requested'`;
    await lifecycle(tx, orderId, 'expired', { environment:'test', reason:'quote_replacement' });
    return checkoutStatus(tx, orderId);
  }, env);
}
