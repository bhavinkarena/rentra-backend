import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { authorize } from './payout-modes.js';
import { withListingInventory } from '../booking/inventory.js';

// Story 2.17 (Test only): owner responsibility for guest rent refunds that completed after a
// succeeded payout fixture. Records the obligation; never moves money or touches refunds/fixtures.
const uuid = z.string().uuid();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function facts(tx, sourceId = null) {
  const rows = await tx`SELECT f.id fixture_id,f.source_id,f.owner_id,f.expected_minor::text paid,
    u.name owner_name,u.email owner_email,bo.reference booking_ref,
    coalesce(rf.refunded,0)::text refunded,coalesce(rf.reserved,0)::text reserved,
    o.id recovery_id,o.version,o.obligation_minor::text assigned,o.reserved_minor::text assigned_reserved,
    o.recovered_minor::text recovered,o.reason,o.updated_at
    FROM payout_transfer_fixture f
    JOIN payment_allocation pa ON pa.id=f.source_id JOIN booking b ON b.id=pa.booking_id
    JOIN booking_order bo ON bo.id=b.order_id JOIN "user" u ON u.id=f.owner_id
    LEFT JOIN owner_recovery o ON o.source_id=f.source_id
    -- Only refunds created after the fixture was reserved (f.created_at) count. The 0078 guard fixed
    -- expected_minor at reserve time net of refunds existing then; counting those again would double count.
    -- Refunds created between reserve and verified_at are the owner's (dispatch refuses them today anyway).
    LEFT JOIN LATERAL (SELECT sum(ra.actual_minor) FILTER (WHERE r.state='succeeded') refunded,
      sum(ra.expected_minor) FILTER (WHERE r.state IN ('requested','processing','unknown')) reserved
      FROM refund_allocation ra JOIN refund r ON r.id=ra.refund_id
      WHERE ra.payment_allocation_id=f.source_id AND ra.component='rent' AND ra.created_at>f.created_at) rf ON true
    WHERE f.state='succeeded' AND f.environment='test' AND (${sourceId}::uuid IS NULL OR f.source_id=${sourceId}::uuid)
    ORDER BY f.verified_at DESC LIMIT 200`;
  return rows.map((row) => {
    const paid = BigInt(row.paid), refunded = BigInt(row.refunded), recovered = BigInt(row.recovered ?? 0);
    const owed = (refunded < paid ? refunded : paid) - recovered;
    const view = {
      sourceId: row.source_id, fixtureId: row.fixture_id, ownerId: row.owner_id,
      ownerName: row.owner_name, ownerEmail: row.owner_email, bookingRef: row.booking_ref,
      environment: 'test', currency: 'INR', paidMinor: row.paid, refundedAfterMinor: row.refunded,
      recoveredMinor: recovered.toString(), obligationMinor: (owed > 0n ? owed : 0n).toString(),
      reservedMinor: row.reserved, version: row.version ?? 0, recoveryId: row.recovery_id,
      assignedMinor: row.assigned, assignedReservedMinor: row.assigned_reserved, reason: row.reason, updatedAt: row.updated_at,
    };
    return { ...view, hash: digest([view.sourceId, view.paidMinor, view.refundedAfterMinor, view.recoveredMinor, view.reservedMinor, view.version]) };
  });
}
const candidate = (row) => row.recoveryId || row.refundedAfterMinor !== '0' || row.reservedMinor !== '0';

export async function listRecoveryCandidates(database, actor) {
  return database.begin(async (tx) => {
    const canWrite = await authorize(tx, actor);
    return { canWrite, environment: 'test', items: (await facts(tx)).filter(candidate) };
  });
}

export async function previewOwnerRecovery(database, actor, sourceId) {
  return database.begin(async (tx) => {
    await authorize(tx, actor);
    if (!uuid.safeParse(sourceId).success) throw notFound();
    const [row] = await facts(tx, sourceId);
    if (!row || !candidate(row)) throw notFound();
    return row;
  });
}

const assignSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().min(0),
  requestKey: uuid, reason: z.string().trim().min(10).max(500) }).strict();
const snapshot = (row) => row && ({ recoveryId: row.id, version: row.version, obligationMinor: String(row.obligation_minor),
  reservedMinor: String(row.reserved_minor), recoveredMinor: String(row.recovered_minor) });

export async function assignOwnerRecovery(database, actor, sourceId, input) {
  if (!uuid.safeParse(sourceId).success) throw notFound();
  const parsed = assignSchema.safeParse(input);
  if (!parsed.success) throw unprocessable({ reason: 'Review the current figures and give a reason of 10-500 characters.' });
  const value = parsed.data, requestHash = digest({ sourceId, ...value });
  const replayed = async (tx) => {
    const [replay] = await tx`SELECT request_hash,"after" FROM owner_recovery_adjustment WHERE actor_id=${actor.id} AND request_key=${value.requestKey}`;
    if (!replay) return null;
    if (replay.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'This request key was used for a different assignment.');
    return { ...replay.after, replayed: true };
  };
  const [scope] = await database`SELECT b.rentable_id FROM payment_allocation pa JOIN booking b ON b.id=pa.booking_id WHERE pa.id=${sourceId}`;
  if (!scope) throw notFound();
  try {
    return await run(scope.rentable_id);
  } catch (error) {
    // A racing same-key insert that slipped past the lock becomes a replay or conflict, never a 500.
    if (error.code !== '23505' || error.constraint_name !== 'owner_recovery_adjustment_actor_id_request_key_key') throw error;
    const outcome = await replayed(database);
    if (!outcome) throw error;
    return outcome;
  }
  async function run(rentableId) {
    // The listing inventory mutex is the lock refund completion takes (services/payments/refunds.js),
    // so refund outcomes cannot change between the facts/hash check and the write below.
    return withListingInventory(database, rentableId, async (tx) => {
      await authorize(tx, actor, true);
      const replay = await replayed(tx);
      if (replay) return replay;
      const [row] = await facts(tx, sourceId);
      if (!row || !candidate(row)) throw notFound();
      if (row.hash !== value.hash || row.version !== value.expectedVersion)
        throw conflict('RECOVERY_CHANGED', 'Refund or recovery figures changed. Review the current figures again.');
      if (row.obligationMinor === '0' || (row.assignedMinor === row.obligationMinor && row.assignedReservedMinor === row.reservedMinor))
        throw conflict('NOTHING_TO_ASSIGN', 'There is no new verified obligation to assign.');
      const [previous] = await tx`SELECT * FROM owner_recovery WHERE source_id=${sourceId} FOR UPDATE`;
      const [saved] = previous
        ? await tx`UPDATE owner_recovery SET obligation_minor=${row.obligationMinor},reserved_minor=${row.reservedMinor},
            version=version+1,actor_id=${actor.id},reason=${value.reason},updated_at=now() WHERE id=${previous.id} RETURNING *`
        : await tx`INSERT INTO owner_recovery(owner_id,source_id,fixture_id,obligation_minor,reserved_minor,actor_id,reason)
            VALUES (${row.ownerId},${sourceId},${row.fixtureId},${row.obligationMinor},${row.reservedMinor},${actor.id},${value.reason}) RETURNING *`;
      const before = snapshot(previous), after = { ...snapshot(saved), sourceId, environment: 'test' };
      await tx`INSERT INTO owner_recovery_adjustment(recovery_id,version,"before","after",actor_id,reason,request_key,request_hash)
        VALUES (${saved.id},${saved.version},${before ? JSON.stringify(before) : null}::text::jsonb,${JSON.stringify(after)}::text::jsonb,
          ${actor.id},${value.reason},${value.requestKey},${requestHash})`;
      await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"before","after",reason)
        VALUES ('admin',${actor.id},'owner_recovery',${saved.id},'owner_recovery_assigned',${before ? JSON.stringify(before) : null}::text::jsonb,
          ${JSON.stringify(after)}::text::jsonb,${value.reason})`;
      return after;
    });
  }
}
