import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { badRequest, conflict, notFound, unavailable, unprocessable } from '@/utils/apiError.js';
import { authorize } from './payout-modes.js';
import { assertInitiationEnabled } from './initiation-switch.js';
import { facts } from './owner-recovery.js';
import { issueNotice, noticeView } from './owner-repayment-notice.js';
import { withListingInventory } from '../booking/inventory.js';
import {
  razorpayTestAdapter,
  verifyCheckoutSignature,
  assertPayment,
  ProviderError,
} from '../payments/razorpay-test.js';

// Story 2.18 (Test only): an owner repayment "link" is a Rentra record bound to a Razorpay Test
// order. Creating or replacing one collects nothing; only a verified capture on its own order with
// the exact amount raises owner_recovery.recovered_minor. No Live keys, no payout offset, no debit.
const uuid = z.string().uuid();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const provider = (opts = {}) => {
  const env = opts.env ?? process.env;
  try {
    return razorpayTestAdapter(env.RAZORPAY_KEY_ID?.trim() ?? '', { env, fetcher: opts.fetcher });
  } catch {
    throw unavailable('PAYMENTS_UNAVAILABLE', 'Razorpay Test is not configured.');
  }
};
const expected = (link) => ({ provider_order_id: link.provider_order_id, expected_minor: link.amount_minor });
const view = (l) => ({
  id: l.id, recoveryId: l.recovery_id, environment: 'test', currency: 'INR', state: l.state,
  amountMinor: String(l.amount_minor), excessMinor: String(l.excess_minor),
  providerOrderId: l.provider_order_id, providerPaymentId: l.provider_payment_id ?? null,
  reviewCode: l.review_code ?? null, createdAt: l.created_at, settledAt: l.settled_at ?? null,
});
const changed = () => conflict('RECOVERY_CHANGED', 'The recovery changed. Review the current figures again.');
const inFlight = () => conflict('REPAYMENT_IN_FLIGHT', 'A payment may be in progress on the current link.');
const scopeOf = async (tx, sourceId) =>
  (await tx`SELECT b.rentable_id FROM payment_allocation pa JOIN booking b ON b.id=pa.booking_id WHERE pa.id=${sourceId}`)[0];

/**
 * Classify a provider read: 'captured' settles; 'pending' (created/authorized/failed) leaves the
 * link open; any other string is a review code (amount mismatch, unknown provider state).
 */
async function classify(read) {
  try {
    const payment = await read();
    if (payment.status === 'captured') return 'captured';
    return ['created', 'authorized', 'failed'].includes(payment.status) ? 'pending' : 'PROVIDER_PAYMENT_UNKNOWN';
  } catch (error) {
    return error instanceof ProviderError ? error.code : 'PROVIDER_OUTCOME_UNKNOWN';
  }
}

/**
 * Lock order everywhere: owner "user" row FOR UPDATE, then owner_recovery, then owner_repayment.
 * Story 2.20: admission holds the owner row FOR SHARE while it reads owner_repayment_overdue.
 */
async function lockLink(tx, linkId) {
  await tx`SELECT 1 FROM "user" WHERE id=(SELECT owner_id FROM owner_repayment WHERE id=${linkId}) FOR UPDATE`;
  const [rec] = await tx`SELECT * FROM owner_recovery WHERE id=(SELECT recovery_id FROM owner_repayment WHERE id=${linkId}) FOR UPDATE`;
  const [link] = await tx`SELECT * FROM owner_repayment WHERE id=${linkId} FOR UPDATE`;
  return { rec, link };
}

/**
 * Provider view of a link's order: an exact verified capture, whether any payment is authorized
 * or captured (any amount), or unknown. One bad item never hides the others.
 */
async function orderState(rzp, link) {
  let items;
  try {
    items = await rzp.orderPayments(link.provider_order_id);
  } catch {
    return { unknown: true, busy: true, captured: null };
  }
  const exact = (p) => {
    try {
      return assertPayment(p, expected(link)).status === 'captured';
    } catch {
      return false;
    }
  };
  const captured = items.find(exact) ?? null;
  return { unknown: false, captured,
    authorized: items.some((p) => p.status === 'authorized'),
    // A capture whose amount is not the link's: held as excess for admin return, never recovered.
    wrongAmount: captured ? null : items.find((p) => p.status === 'captured' && Number.isSafeInteger(p.amount) && p.amount > 0) ?? null,
    busy: items.some((p) => p.status === 'authorized' || p.status === 'captured') };
}

/** An open replacement link with no provider payment, closed when a replaced link settles. */
async function cleanOpenLink(database, rzp, recoveryId, exceptId) {
  const [open] = await database`SELECT * FROM owner_repayment WHERE recovery_id=${recoveryId} AND state='open' AND id IS DISTINCT FROM ${exceptId}::uuid`;
  return open && !(await orderState(rzp, open)).busy ? open.id : null;
}

/** Inside the listing mutex with recovery then link locked. Settles at most once per link. */
async function settle(tx, rec, link, paymentId, outcome, actor, closeOpenId = null) {
  const before = { recoveredMinor: String(rec.recovered_minor), version: rec.version, link: view(link) };
  let saved;
  if (outcome === 'captured') {
    const amount = BigInt(link.amount_minor), outstanding = BigInt(rec.obligation_minor) - BigInt(rec.recovered_minor);
    const apply = outstanding <= 0n ? 0n : outstanding < amount ? outstanding : amount;
    // Excess is held for admin return; never revenue, never moved to another debt.
    await tx`UPDATE owner_recovery SET recovered_minor=recovered_minor+${apply.toString()}::bigint,
      version=version+1,updated_at=now() WHERE id=${rec.id}`;
    [saved] = await tx`UPDATE owner_repayment SET state='paid',provider_payment_id=${paymentId},review_code=NULL,
      excess_minor=${(amount - apply).toString()},settled_at=now() WHERE id=${link.id} RETURNING *`;
    // A capture on a replaced link pays the debt; close the unpaid replacement so it is not paid twice.
    if (link.state === 'replaced' && closeOpenId)
      await tx`UPDATE owner_repayment SET state='replaced',settled_at=now()
        WHERE id=${closeOpenId} AND recovery_id=${rec.id} AND state='open' AND provider_payment_id IS NULL`;
  } else {
    // No partial settlement: a mismatch or unknown provider state waits for an admin check.
    [saved] = await tx`UPDATE owner_repayment SET state='needs_review',provider_payment_id=${paymentId},
      review_code=${outcome},settled_at=now() WHERE id=${link.id} RETURNING *`;
  }
  const [after] = await tx`SELECT recovered_minor::text r,version FROM owner_recovery WHERE id=${rec.id}`;
  await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
    VALUES (${actor.type},${actor.id},'owner_repayment',${link.id},${outcome === 'captured' ? 'owner_repayment_paid' : 'owner_repayment_needs_review'},
      ${JSON.stringify(before)}::text::jsonb,${JSON.stringify({ recoveredMinor: after.r, version: after.version, link: view(saved) })}::text::jsonb,
      'Test repayment verified')`;
  return saved;
}

const createSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().min(1),
  requestKey: uuid }).strict();

export async function createRepaymentLink(database, actor, sourceId, input, opts = {}) {
  if (!uuid.safeParse(sourceId).success) throw notFound();
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ expectedVersion: 'Reload the recovery and try again.' });
  const value = parsed.data, requestHash = digest({ sourceId, ...value });
  const replayed = async (tx) => {
    const [replay] = await tx`SELECT * FROM owner_repayment WHERE actor_id=${actor.id} AND request_key=${value.requestKey}`;
    if (!replay) return null;
    if (replay.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'This request key was used for a different link.');
    return { ...view(replay), replayed: true };
  };
  // The admin's preview hash binds the figures; amount = assigned obligation - recovered.
  const current = async (tx) => {
    const [row] = await facts(tx, sourceId);
    if (!row?.recoveryId) throw notFound();
    if (row.hash !== value.hash || row.version !== value.expectedVersion) throw changed();
    if (row.outstandingMinor === '0') throw conflict('NOTHING_TO_COLLECT', 'Nothing is outstanding on this recovery.');
    const links = await tx`SELECT * FROM owner_repayment WHERE recovery_id=${row.recoveryId} AND state IN ('open','needs_review')`;
    if (links.some((l) => l.state === 'needs_review')) throw inFlight();
    return { row, open: links[0] ?? null };
  };
  const pre = await database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const replay = await replayed(tx);
    if (replay) return { replay };
    return { ...(await current(tx)), scope: await scopeOf(tx, sourceId) };
  });
  if (pre.replay) return pre.replay;
  assertInitiationEnabled(opts.env ?? process.env); // Story 2.21: replays still answer; no new order.
  const rzp = provider(opts);
  // Replacing: the old order must show no authorized or captured payment.
  if (pre.open) await assertNoPayment(rzp, pre.open);
  const id = randomUUID(), amount = pre.row.outstandingMinor;
  let order;
  try {
    order = await rzp.createOrder({ id, expected_minor: amount });
  } catch {
    throw unavailable('PROVIDER_OUTCOME_UNKNOWN', 'Razorpay Test did not confirm the order. Try again.');
  }
  // Re-check just before replacing. A capture that still lands on the old order after this is
  // settled by verify/check on the replaced link (capped, rest stored as excess).
  if (pre.open) await assertNoPayment(rzp, pre.open);
  // ponytail: an order created here but rejected below stays an unused Test order; nothing is collected.
  try {
    return await withListingInventory(database, pre.scope.rentable_id, async (tx) => {
      await authorize(tx, actor, true);
      const replay = await replayed(tx);
      if (replay) return replay;
      await tx`SELECT 1 FROM "user" WHERE id=(SELECT owner_id FROM owner_recovery WHERE id=${pre.row.recoveryId}) FOR UPDATE`;
      await tx`SELECT 1 FROM owner_recovery WHERE id=${pre.row.recoveryId} FOR UPDATE`;
      const now = await current(tx);
      if (now.row.outstandingMinor !== amount || (now.open?.id ?? null) !== (pre.open?.id ?? null)) throw changed();
      if (now.open) await tx`UPDATE owner_repayment SET state='replaced',settled_at=now() WHERE id=${now.open.id} AND state='open'`;
      const [link] = await tx`INSERT INTO owner_repayment(id,recovery_id,owner_id,amount_minor,provider_order_id,actor_id,request_key,request_hash)
        VALUES (${id},${now.row.recoveryId},${now.row.ownerId},${amount},${order.id},${actor.id},${value.requestKey},${requestHash}) RETURNING *`;
      // Story 2.19: the first link issues the notice; a replacement never touches it.
      await issueNotice(tx, now.row.recoveryId, now.row.ownerId);
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
        VALUES ('admin',${actor.id},'owner_repayment',${link.id},${now.open ? 'owner_repayment_replaced' : 'owner_repayment_created'},
          ${now.open ? JSON.stringify(view(now.open)) : null}::text::jsonb,${JSON.stringify(view(link))}::text::jsonb,'Test repayment link')`;
      return view(link);
    });
  } catch (error) {
    if (error.code !== '23505') throw error;
    const outcome = await replayed(database);
    if (outcome) return outcome;
    throw changed();
  }
}

async function assertNoPayment(rzp, link) {
  // Unknown provider state counts as in flight: never replace on doubt.
  if ((await orderState(rzp, link)).busy) throw inFlight();
}

/** Story 2.20: one owner-wide figure for both banners (earnings and listings dashboard). */
export async function ownerRepaymentStatus(database, ownerId) {
  const [row] = await database`SELECT owner_repayment_overdue(${ownerId}) overdue,
    (SELECT coalesce(sum(obligation_minor-recovered_minor),0)::text FROM owner_recovery
      WHERE owner_id=${ownerId} AND obligation_minor>recovered_minor) outstanding`;
  return { overdue: row.overdue, outstandingMinor: row.outstanding };
}

export async function listOwnerRepayments(database, ownerId, opts = {}) {
  const env = opts.env ?? process.env;
  const rows = await database`SELECT r.*,bo.reference booking_ref,
    n.id notice_id,n.issued_at notice_issued_at,n.received_at notice_received_at,
    n.received_via notice_received_via,n.reminder_at notice_reminder_at,n.due_at notice_due_at,n.version notice_version,
    (n.reminder_at IS NOT NULL AND now()>=n.reminder_at) notice_reminder_due,
    EXISTS(SELECT 1 FROM owner_repayment_notice_event e WHERE e.notice_id=n.id AND e.type='owner_ack') notice_acknowledged FROM owner_repayment r
    JOIN owner_recovery o ON o.id=r.recovery_id LEFT JOIN owner_repayment_notice n ON n.recovery_id=r.recovery_id JOIN payment_allocation pa ON pa.id=o.source_id
    JOIN booking b ON b.id=pa.booking_id JOIN booking_order bo ON bo.id=b.order_id
    WHERE r.owner_id=${ownerId} AND r.state<>'replaced' ORDER BY r.created_at DESC LIMIT 100`;
  // Checkout needs the public Test key id only; the secret never leaves the server.
  const keyId = /^rzp_test_[A-Za-z0-9]+$/.test(env.RAZORPAY_KEY_ID?.trim() ?? '') ? env.RAZORPAY_KEY_ID.trim() : null;
  const { overdue, outstandingMinor } = await ownerRepaymentStatus(database, ownerId);
  return { environment: 'test', keyId, overdue, outstandingMinor, items: rows.map((r) => ({ ...view(r), bookingRef: r.booking_ref, notice: noticeView(r) })) };
}

const verifySchema = z.object({ paymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  signature: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict();

export async function verifyOwnerRepayment(database, ownerId, id, input, opts = {}) {
  if (!uuid.safeParse(id).success) throw notFound();
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) throw badRequest('INVALID_PAYMENT', 'The payment response was not valid.');
  const value = parsed.data;
  const [link] = await database`SELECT r.*,b.rentable_id FROM owner_repayment r JOIN owner_recovery o ON o.id=r.recovery_id
    JOIN payment_allocation pa ON pa.id=o.source_id JOIN booking b ON b.id=pa.booking_id
    WHERE r.id=${id} AND r.owner_id=${ownerId}`;
  if (!link) throw notFound();
  if (link.provider_payment_id === value.paymentId) return { ...view(link), replayed: true };
  // A replaced link stays payable: a capture that raced the replacement must still settle.
  if (!['open', 'replaced'].includes(link.state)) throw conflict('LINK_CLOSED', 'This repayment link is no longer open.');
  const rzp = provider(opts);
  try {
    // The order id comes from the server record, never from Checkout.
    verifyCheckoutSignature(link.provider_order_id, value.paymentId, value.signature, rzp.credentials);
  } catch {
    throw badRequest('INVALID_SIGNATURE', 'The payment could not be verified.');
  }
  const outcome = await classify(() => rzp.payment(value.paymentId, expected(link)));
  if (outcome === 'pending') return { ...view(link), paymentStatus: 'pending' };
  // A replaced link only ever settles on a verified capture; never parked for review.
  if (link.state === 'replaced' && outcome !== 'captured') return { ...view(link), paymentStatus: 'pending' };
  const closeOpenId = link.state === 'replaced' ? await cleanOpenLink(database, rzp, link.recovery_id, link.id) : null;
  return withListingInventory(database, link.rentable_id, async (tx) => {
    const { rec, link: current } = await lockLink(tx, id);
    if (current.provider_payment_id === value.paymentId) return { ...view(current), replayed: true };
    if (!['open', 'replaced'].includes(current.state)) throw conflict('LINK_CLOSED', 'This repayment link is no longer open.');
    return view(await settle(tx, rec, current, value.paymentId, outcome, { type: 'client', id: ownerId }, closeOpenId));
  });
}

/**
 * Admin re-check (Story 2.18): re-reads provider payments for every unsettled link of the recovery
 * and settles an exact verified capture. Anything else keeps its state.
 */
export async function checkRepaymentLink(database, actor, sourceId, opts = {}) {
  if (!uuid.safeParse(sourceId).success) throw notFound();
  const pre = await database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const [rec] = await tx`SELECT id FROM owner_recovery WHERE source_id=${sourceId}`;
    if (!rec) throw notFound();
    return { rec, scope: await scopeOf(tx, sourceId),
      links: await tx`SELECT * FROM owner_repayment WHERE recovery_id=${rec.id} AND state IN ('open','needs_review','replaced')` };
  });
  const rzp = provider(opts);
  const found = [];
  for (const link of pre.links) {
    const { captured } = await orderState(rzp, link);
    if (captured) found.push({ link, paymentId: captured.id });
  }
  const closeOpenId = found.some((f) => f.link.state === 'replaced')
    ? await cleanOpenLink(database, rzp, pre.rec.id, null)
    : null;
  return withListingInventory(database, pre.scope.rentable_id, async (tx) => {
    await authorize(tx, actor, true);
    await tx`SELECT 1 FROM "user" WHERE id=(SELECT owner_id FROM owner_recovery WHERE id=${pre.rec.id}) FOR UPDATE`;
    await tx`SELECT 1 FROM owner_recovery WHERE id=${pre.rec.id} FOR UPDATE`;
    const settled = [];
    for (const { link, paymentId } of found) {
      const { rec, link: current } = await lockLink(tx, link.id);
      if (current.state === 'paid') continue;
      settled.push(view(await settle(tx, rec, current, paymentId, 'captured', { type: 'admin', id: actor.id }, closeOpenId)));
    }
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
      VALUES ('admin',${actor.id},'owner_recovery',${pre.rec.id},'owner_repayment_checked',NULL,
        ${JSON.stringify({ settled: settled.map((s) => s.id) })}::text::jsonb,'Test repayment provider check')`;
    const links = await tx`SELECT * FROM owner_repayment WHERE recovery_id=${pre.rec.id} ORDER BY created_at DESC`;
    return { environment: 'test', settled, links: links.map(view) };
  });
}

const resolveSchema = z.object({ linkId: uuid, reason: z.string().trim().min(10).max(500) }).strict();

/**
 * Admin close of a needs_review link (Story 2.18). Re-reads the provider: an exact capture settles;
 * an authorized or mismatched capture refuses; otherwise the link becomes `replaced` so a new link
 * can be created. What is due never changes here.
 */
export async function resolveRepaymentLink(database, actor, sourceId, input, opts = {}) {
  if (!uuid.safeParse(sourceId).success) throw notFound();
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ reason: 'Give a reason of 10-500 characters.' });
  const value = parsed.data;
  const pre = await database.begin(async (tx) => {
    await authorize(tx, actor, true);
    const [link] = await tx`SELECT r.* FROM owner_repayment r JOIN owner_recovery o ON o.id=r.recovery_id
      WHERE r.id=${value.linkId} AND o.source_id=${sourceId}`;
    if (!link) throw notFound();
    if (link.state !== 'needs_review') throw conflict('LINK_NOT_IN_REVIEW', 'Only a link under review can be closed.');
    return { link, scope: await scopeOf(tx, sourceId) };
  });
  const state = await orderState(provider(opts), pre.link);
  if (state.unknown) throw unavailable('PROVIDER_OUTCOME_UNKNOWN', 'Razorpay Test did not answer. Try again.');
  if (!state.captured && (state.authorized || (state.busy && !state.wrongAmount)))
    throw conflict('REPAYMENT_IN_FLIGHT', 'The provider shows a payment on this link.');
  return withListingInventory(database, pre.scope.rentable_id, async (tx) => {
    await authorize(tx, actor, true);
    const { rec, link } = await lockLink(tx, value.linkId);
    if (link.state !== 'needs_review') throw conflict('LINK_NOT_IN_REVIEW', 'Only a link under review can be closed.');
    if (state.captured)
      return { ...view(await settle(tx, rec, link, state.captured.id, 'captured', { type: 'admin', id: actor.id })), settled: true };
    const odd = state.wrongAmount;
    // Wrong-amount capture: the whole captured amount is excess for admin return; recovered unchanged.
    const [saved] = odd
      ? await tx`UPDATE owner_repayment SET state='replaced',provider_payment_id=${odd.id},excess_minor=${odd.amount},
          settled_at=now() WHERE id=${link.id} RETURNING *`
      : await tx`UPDATE owner_repayment SET state='replaced',settled_at=now() WHERE id=${link.id} RETURNING *`;
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
      VALUES ('admin',${actor.id},'owner_repayment',${link.id},'owner_repayment_closed',${JSON.stringify(view(link))}::text::jsonb,
        ${JSON.stringify(view(saved))}::text::jsonb,${value.reason})`;
    return view(saved);
  });
}
