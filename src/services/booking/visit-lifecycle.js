import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withListingInventory } from './inventory.js';
import { quoteDigest } from './quotes.js';
import { lifecycle, CheckoutError } from './checkout.js';

const inputSchema = z.object({ visitId: z.string().uuid(), phase: z.enum(['handover','return','complete']),
  occurredAt: z.string().datetime({ offset: true }), note: z.string().trim().min(20).max(1000),
  attested: z.literal(true), expectedVersion: z.number().int().nonnegative(), requestKey: z.string().uuid() }).strict();

export async function recordVisitTransition(database, actor, input) {
  const value = inputSchema.parse(input), hash = quoteDigest(value);
  if (!['owner','admin'].includes(actor?.kind) || !z.string().uuid().safeParse(actor.id).success) throw new CheckoutError('OPERATOR_REQUIRED');
  const [scope] = await database`SELECT rentable_id FROM booking WHERE id=${value.visitId}`;
  if (!scope) throw new CheckoutError('VISIT_NOT_FOUND');
  return withListingInventory(database, scope.rentable_id, async (tx, listing) => {
    const [active] = actor.kind === 'owner'
      ? await tx`SELECT id FROM "user" WHERE id=${actor.id} AND id=${listing.client_id} AND role='client' AND account_status='active' FOR SHARE`
      : await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (!active) throw new CheckoutError('OPERATOR_REQUIRED');
    const [visit] = await tx`SELECT * FROM booking WHERE id=${value.visitId}`;
    const [replay] = await tx`SELECT id,booking_id,kind,request_hash FROM visit_evidence WHERE actor_kind=${actor.kind} AND actor_id=${actor.id} AND request_key=${value.requestKey}`;
    if (replay) {
      if (replay.request_hash !== hash || replay.booking_id !== visit.id) throw new CheckoutError('IDEMPOTENCY_CONFLICT');
      return { id: replay.id, phase: replay.kind, visitId: visit.id, orderId: visit.order_id };
    }
    const states = { handover: ['confirmed','handed_over'], return: ['handed_over','returned'], complete: ['returned','completed'] };
    if (!visit.order_id || !visit.hours_known || visit.lifecycle_version !== value.expectedVersion || visit.state !== states[value.phase][0]) throw new CheckoutError('VISIT_CHANGED');
    const [{ now }] = await tx`SELECT clock_timestamp() now`;
    const at = new Date(value.occurredAt);
    if (at > new Date(now) || at < new Date(visit.starts_at)) throw new CheckoutError('INVALID_EVIDENCE_TIME');
    if (value.phase !== 'handover') {
      const previous = value.phase === 'return' ? 'handover' : 'return';
      const [proof] = await tx`SELECT occurred_at FROM visit_evidence WHERE booking_id=${visit.id} AND kind=${previous}`;
      if (!proof || at < new Date(proof.occurred_at)) throw new CheckoutError('PRIOR_EVIDENCE_REQUIRED');
    }
    const id = randomUUID(), nature = visit.visit_provenance === 'real' ? 'actual' : 'simulation';
    await tx`INSERT INTO visit_evidence(id,booking_id,kind,nature,actor_kind,actor_id,note,occurred_at,recorded_at,request_key,request_hash)
      VALUES(${id},${visit.id},${value.phase},${nature},${actor.kind},${actor.id},${value.note},${value.occurredAt},${now},${value.requestKey},${hash})`;
    await tx`UPDATE booking SET state=${states[value.phase][1]},lifecycle_version=lifecycle_version+1,updated_at=clock_timestamp() WHERE id=${visit.id}`;
    // Do not shorten paid inventory or relabel financial/visit provenance on completion.
    await lifecycle(tx, visit.order_id, 'visit_' + id.replaceAll('-',''), { visitId: visit.id, evidenceId: id, phase: value.phase, nature });
    return { id, phase: value.phase, visitId: visit.id, orderId: visit.order_id };
  });
}
