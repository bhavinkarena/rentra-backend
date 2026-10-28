import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '@/utils/apiError.js';
import { lockPayoutPolicy, resolvePayoutMode } from './payout-modes.js';

const uuid = z.string().uuid();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => conflict('PAYOUT_FIXTURE_BLOCKED', message);
const providerName = 'local-fixture', account = 'local-fixture-account';

async function local(tx) {
  const [connection] = await tx`SELECT current_database() name,host(inet_server_addr()) address`;
  if (!/^rentra_test_[a-z0-9_]+$/.test(connection.name) || !['127.0.0.1','::1'].includes(connection.address))
    throw fail('Payout fixtures require an actual disposable localhost database.');
}
function adapter(provider) {
  if (provider?.kind !== 'local-payout-fixture' || provider.provider !== providerName || provider.account !== account
    || typeof provider.create !== 'function' || typeof provider.lookup !== 'function')
    throw fail('An explicitly supplied local fixture provider is required.');
  return provider;
}
async function fixtureCall(run) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('Local fixture response timed out.')), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function authorize(tx, actor, write = false) {
  if (!uuid.safeParse(actor?.id).success) throw forbidden();
  if (actor.kind === 'admin') {
    const [admin] = await tx`SELECT permissions FROM admin_user WHERE id=${actor.id} AND is_active ${write ? tx`FOR SHARE` : tx``}`;
    if (!admin || (admin.permissions != null && !admin.permissions.includes(`admin.payments.${write ? 'write' : 'read'}`))) throw forbidden();
  } else if (!write && actor.kind === 'owner') {
    const [owner] = await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active'`;
    if (!owner) throw forbidden();
  } else throw forbidden();
}
async function sourceScope(database, sourceId) {
  if (!uuid.safeParse(sourceId).success) throw notFound();
  const [row] = await database`SELECT b.rentable_id,b.order_id,b.id booking_id FROM payment_allocation pa JOIN booking b ON b.id=pa.booking_id WHERE pa.id=${sourceId}`;
  if (!row) throw notFound();
  return row;
}
// Policy -> listing -> sorted orders/visits -> booked owner -> payment order -> operation.
// Destination writers own the same owner row; refunds own the listing/payment rows.
async function locked(database, actor, sourceId, run) {
  return database.begin(async tx => {
    await local(tx);
    await authorize(tx, actor, true);
    const scope = await sourceScope(tx, sourceId);
    await lockPayoutPolicy(tx);
    await tx`UPDATE rentable SET updated_at=updated_at WHERE id=${scope.rentable_id}`;
    await tx`SELECT id FROM booking_order WHERE id=${scope.order_id} FOR UPDATE`;
    await tx`SELECT id FROM booking WHERE id=${scope.booking_id} FOR UPDATE`;
    const [source] = await tx`SELECT pa.*,bo.listing_snapshot->>'ownerId' owner_id,b.order_id,
      po.id payment_order_id,t.currency,t.environment::text,t.mode::text,t.kind::text,t.outcome::text,t.verified_at,
      rentra_payout_booking_supported(b.id) supported,rentra_payout_rent_capture_count(b.id,'test') captures
      FROM payment_allocation pa JOIN payment_transaction t ON t.id=pa.transaction_id
      JOIN payment_attempt a ON a.id=t.attempt_id JOIN payment_order po ON po.id=a.payment_order_id
      JOIN booking b ON b.id=pa.booking_id JOIN booking_order bo ON bo.id=b.order_id WHERE pa.id=${sourceId}`;
    if (!uuid.safeParse(source?.owner_id).success) throw fail('Immutable booked owner is unavailable.');
    const [owner] = await tx`SELECT id,account_status FROM "user" WHERE id=${source.owner_id} AND role='client' FOR SHARE`;
    await tx`UPDATE payment_order SET state=state WHERE id=${source.payment_order_id}`;
    // Re-read refund reservations only after the shared payment-order lock.
    const [refund] = await tx`SELECT coalesce(sum(ra.expected_minor),0)::text reserved FROM refund_allocation ra
      JOIN refund r ON r.id=ra.refund_id WHERE ra.payment_allocation_id=${sourceId} AND r.state<>'failed'`;
    const [destination] = await tx`SELECT id,version,state FROM payout_destination WHERE client_id=${source.owner_id}
      AND state IN ('submitted','verified') ORDER BY version DESC LIMIT 1 FOR SHARE`;
    const policy = await resolvePayoutMode(tx, source.owner_id);
    const remaining = BigInt(source.actual_minor) - BigInt(refund.reserved);
    const eligible = source.currency === 'INR' && source.component === 'rent' && source.environment === 'test' && source.mode === 'real'
      && source.kind === 'capture' && source.outcome === 'succeeded' && source.verified_at != null
      && source.supported && Number(source.captures) === 1 && owner?.account_status === 'active'
      && destination?.state === 'verified' && remaining > 0n;
    const terms = { sourceId, ownerId: source.owner_id, destinationId: destination?.id ?? null,
      destinationVersion: destination?.version ?? null, expectedMinor: remaining.toString(), currency: 'INR',
      environment: 'test', provider: providerName, providerAccount: account, policy };
    const previewHash = digest({ actorId: actor.id, ...terms, eligible });
    return run(tx, { terms, previewHash, eligible });
  });
}
function requireEligible(review) {
  if (!review.eligible) throw fail('Supported verified Test rent, active booked owner, current verified destination and remaining hypothetical capacity are required.');
}
function consent(review, input) {
  if (review.terms.policy.mode === 'manual') {
    if (input.previewHash !== review.previewHash) throw conflict('STALE_PREVIEW','Review current fixture terms again.');
    if (input.accepted !== true) throw unprocessable({ accepted: 'Explicit admin consent is required for Manual fixture dispatch.' });
  }
}
const previewSchema = z.object({ sourceId: uuid }).strict();
const dispatchSchema = z.object({ previewHash: z.string().length(64).optional(), accepted: z.boolean().optional() }).strict();
export async function previewPayoutTransfer(database, actor, input, provider) {
  adapter(provider);
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ fixture: 'Choose a source to review.' });
  return locked(database, actor, parsed.data.sourceId, async (tx, review) => ({ ...review, actualBankMinor: '0', fundingAuthority: 'unset' }));
}
const reserveSchema = z.object({ sourceId: uuid, requestKey: uuid, previewHash: z.string().length(64).optional(), accepted: z.boolean().optional() }).strict();
export async function reservePayoutTransfer(database, actor, input, provider) {
  adapter(provider);
  const parsed = reserveSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ fixture: 'Choose a source and a scoped request key.' });
  const value = parsed.data, hash = digest(value);
  return locked(database, actor, value.sourceId, async (tx, review) => {
    const [replay] = await tx`SELECT * FROM payout_transfer_fixture WHERE actor_id=${actor.id} AND request_key=${value.requestKey}`;
    if (replay) {
      if (replay.request_hash !== hash) throw conflict('IDEMPOTENCY_CONFLICT','Request key was used for different fixture terms.');
      return replay;
    }
    requireEligible(review);
    consent(review, value);
    const [existing] = await tx`SELECT id FROM payout_transfer_fixture WHERE source_id=${value.sourceId}`;
    if (existing) throw conflict('PAYOUT_FIXTURE_EXISTS','This source already has one fixture operation.');
    const t = review.terms;
    const [saved] = await tx`INSERT INTO payout_transfer_fixture(source_id,owner_id,destination_id,destination_version,mode,policy,
      expected_minor,provider,provider_account,actor_id,request_key,request_hash)
      VALUES (${t.sourceId},${t.ownerId},${t.destinationId},${t.destinationVersion},${t.policy.mode},${JSON.stringify(t.policy)}::text::jsonb,
        ${t.expectedMinor},${t.provider},${t.providerAccount},${actor.id},${value.requestKey},${hash}) RETURNING *`;
    return saved;
  });
}
function identity(row) {
  return { operationId: row.id, sourceId: row.source_id, ownerId: row.owner_id, destinationId: row.destination_id,
    destinationVersion: row.destination_version, expectedMinor: String(row.expected_minor), currency: row.currency,
    environment: row.environment, provider: row.provider, providerAccount: row.provider_account };
}
function verified(evidence, row) {
  const pinned = identity(row);
  return evidence?.status === 'succeeded' && Object.entries(pinned).every(([key,value]) => evidence[key] === value);
}
async function operation(database, actor, id) {
  if (!uuid.safeParse(id).success) throw notFound();
  // Never expose a source reference until actor permissions have been checked.
  return database.begin(async tx => {
    await local(tx);
    await authorize(tx, actor, true);
    const [row] = await tx`SELECT * FROM payout_transfer_fixture WHERE id=${id}`;
    if (!row) throw notFound();
    return row;
  });
}
export async function dispatchPayoutTransfer(database, actor, id, input = {}, provider) {
  const fixture = adapter(provider);
  const parsed = dispatchSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ fixture: 'Provide a valid fixture confirmation.' });
  const scope = await operation(database, actor, id);
  const claim = scope.dispatched_at ? { row: scope, send: false } : await locked(database, actor, scope.source_id, async (tx, review) => {
    const [row] = await tx`SELECT * FROM payout_transfer_fixture WHERE id=${id} FOR UPDATE`;
    if (row.dispatched_at) return { row, send: false };
    requireEligible(review);
    const t = review.terms;
    if (row.destination_id !== t.destinationId || row.destination_version !== t.destinationVersion || String(row.expected_minor) !== t.expectedMinor)
      throw conflict('STALE_PREVIEW','Reserved fixture terms changed; this operation is held.');
    consent(review, parsed.data);
    const [claimed] = await tx`UPDATE payout_transfer_fixture SET dispatched_at=clock_timestamp(),state='processing',
      dispatch_actor_id=${actor.id},dispatch_mode=${t.policy.mode},dispatch_policy=${JSON.stringify(t.policy)}::text::jsonb,
      consent_hash=${t.policy.mode === 'manual' ? review.previewHash : null},
      manual_consent=${t.policy.mode === 'manual' ? true : false} WHERE id=${id} AND dispatched_at IS NULL RETURNING *`;
    return { row: claimed, send: true };
  });
  if (claim.row.state === 'succeeded') return claim.row;
  // Claim is committed before any adapter call; every retry is lookup-only.
  let evidence;
  try {
    if (claim.send) await fixtureCall(() => fixture.create(identity(claim.row)));
    evidence = await fixtureCall(() => fixture.lookup(identity(claim.row)));
  } catch {
    evidence = null;
  }
  return database.begin(async tx => {
    await local(tx);
    await authorize(tx, actor, true);
    const [row] = await tx`SELECT * FROM payout_transfer_fixture WHERE id=${id} FOR UPDATE`;
    if (row.state === 'succeeded') return row;
    const matches = verified(evidence, row);
    const [saved] = await tx`UPDATE payout_transfer_fixture SET state=${matches ? 'succeeded' : 'unknown'},
      evidence=${matches ? JSON.stringify(evidence) : null}::text::jsonb,evidence_hash=${matches ? digest(evidence) : null},
      verified_at=${matches ? new Date().toISOString() : null} WHERE id=${id} RETURNING *`;
    return saved;
  });
}
export async function reconcilePayoutTransfer(database, actor, id, provider) {
  adapter(provider);
  const row = await operation(database, actor, id);
  if (!row.dispatched_at) throw fail('Only an already dispatched fixture can be reconciled.');
  return dispatchPayoutTransfer(database, actor, id, {}, provider);
}

// Used inside already authorized statement snapshots, with only their scoped allocation IDs.
export async function fixtureSummaries(tx, sourceIds) {
  if (!sourceIds.length) return [];
  const rows = await tx`SELECT f.*,coalesce((SELECT sum(ra.expected_minor) FROM refund_allocation ra
    JOIN refund r ON r.id=ra.refund_id WHERE ra.payment_allocation_id=f.source_id AND r.state<>'failed'),0)::text refund_reserved,
    pa.actual_minor::text captured FROM payout_transfer_fixture f JOIN payment_allocation pa ON pa.id=f.source_id
    WHERE f.source_id=ANY(${sourceIds}::uuid[])`;
  return rows.map(row => ({ id: row.id, sourceId: row.source_id, state: row.state, expectedMinor: String(row.expected_minor),
    actualBankMinor: '0', environment: 'test', destinationVersion: row.destination_version, fundingAuthority: 'unset',
    simulatedExposureMinor: row.dispatched_at ? (BigInt(row.expected_minor)+BigInt(row.refund_reserved)>BigInt(row.captured)
      ? BigInt(row.expected_minor)+BigInt(row.refund_reserved)-BigInt(row.captured) : 0n).toString() : '0' }));
}
export async function readPayoutTransfers(database, actor) {
  return database.begin('isolation level repeatable read read only', async tx => {
    await authorize(tx, actor);
    const sources = await tx`SELECT source_id FROM payout_transfer_fixture WHERE ${actor.kind === 'admin'} OR owner_id=${actor.id}`;
    return fixtureSummaries(tx, sources.map(row => row.source_id));
  });
}
