import { randomUUID } from 'node:crypto';
import { recordVisitTransition } from '../../src/services/booking/visit-lifecycle.js';
import { submitReview } from '../../src/services/reviews/service.js';
/** Disposable fixtures only: actual provenance tests the real-evidence eligibility contract. */
export async function seedReviewModeration(sql, f, booking) {
  const [visit] =
    await sql`UPDATE booking SET visit_provenance='real',hours_known=true,starts_at=now()-interval '4 hours',ends_at=now()-interval '1 hour',blocked_start_at=now()-interval '4 hours',blocked_end_at=now()-interval '1 hour' WHERE order_id=${booking.order} RETURNING id`;
  for (const [i, phase] of ['handover', 'return', 'complete'].entries()) {
    const [v] = await sql`SELECT lifecycle_version FROM booking WHERE id=${visit.id}`;
    await recordVisitTransition(
      sql,
      { kind: 'owner', id: f.owner },
      {
        visitId: visit.id,
        phase,
        occurredAt: new Date(Date.now() - (180 - i * 60) * 60000).toISOString(),
        note: `Observed the ${phase} at this disposable fixture visit.`,
        attested: true,
        expectedVersion: v.lifecycle_version,
        requestKey: randomUUID(),
      },
    );
  }
  const [session] =
    await sql`INSERT INTO auth_session(user_id,expires_at) VALUES(${booking.customer},now()+interval '1 day') RETURNING id`;
  const customer = { role: 'customer', userId: booking.customer, sessionId: session.id };
  const review = await submitReview(sql, customer, {
    visitId: visit.id,
    rating: 1,
    body: 'The visit did not meet my expectations. The garden was poorly maintained.',
  });
  return { reviewId: review.id, visitId: visit.id, customer };
}
