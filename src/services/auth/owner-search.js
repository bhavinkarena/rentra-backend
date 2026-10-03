import { z } from 'zod';
import { forbidden } from '../../utils/apiError.js';
export const ownerSearchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  type: z
    .enum(['all', 'property', 'booking', 'support', 'review', 'dispute', 'caretaker'])
    .default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
/** Literal search, paginated across owned records. No guest phone or private message bodies are returned. */
export async function ownerSearch(database, ownerId, input) {
  const filters = ownerSearchQuery.parse(input);
  return database.begin('isolation level repeatable read read only', async (tx) => {
    const [owner] =
      await tx`SELECT account_status FROM "user" WHERE id=${ownerId} AND role='client' AND account_status IN ('active','pending_application')`;
    if (!owner) throw forbidden();
    const active = owner.account_status === 'active';
    const records = tx`WITH records AS (
      SELECT r.id,'property'::text type,coalesce(r.title,'Untitled draft') title,coalesce(r.public_code,'') reference,r.status::text status,r.updated_at updated_at,
        '/partner/listings/'||r.id::text||CASE WHEN r.status='draft' THEN '/setup' ELSE '/overview' END href
        FROM rentable r WHERE r.client_id=${ownerId}
      UNION ALL SELECT o.id,'booking',coalesce(o.listing_snapshot->>'title',r.title),o.reference,o.state::text,o.created_at,
        '/partner/bookings?booking='||o.id::text FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${active} AND r.client_id=${ownerId} AND o.state NOT IN ('held','expired')
      UNION ALL SELECT s.id,'support',s.subject,s.reference,s.state,s.updated_at,'/partner/support/'||s.id::text FROM support_request s WHERE s.client_id=${ownerId}
      UNION ALL SELECT v.id,'review',r.title,'Guest review',CASE WHEN v.owner_reply IS NULL THEN 'needs_reply' ELSE 'replied' END,v.created_at,'/partner/reviews/'||v.id::text FROM public_customer_review v JOIN rentable r ON r.id=v.rentable_id WHERE ${active} AND r.client_id=${ownerId}
      UNION ALL SELECT d.id,'dispute',d.subject,o.reference,d.state,d.created_at,'/partner/disputes/'||d.id::text FROM dispute_case d JOIN booking_order o ON o.id=d.order_id WHERE ${active} AND d.owner_id=${ownerId}
      UNION ALL SELECT s.id,'caretaker',coalesce(s.name,'Caretaker'),s.phone,CASE WHEN s.is_active THEN 'active' ELSE 'removed' END,s.created_at,'/partner/team' FROM client_staff s WHERE ${active} AND s.client_id=${ownerId}
    )`;
    const match = tx`(${filters.type}='all' OR type=${filters.type}) AND (position(lower(${filters.q}) in lower(title))>0 OR position(lower(${filters.q}) in lower(reference))>0)`;
    const [count] = await tx`${records} SELECT count(*)::int total FROM records WHERE ${match}`;
    const items =
      await tx`${records} SELECT id,type,title,reference,status,href FROM records WHERE ${match} ORDER BY updated_at DESC,id,type LIMIT 20 OFFSET ${(filters.page - 1) * 20}`;
    return { ...filters, items, total: count.total, pages: Math.ceil(count.total / 20) };
  });
}
