import 'server-only';
import { z } from 'zod';
import { lockCustomerAccount } from '../auth/customer-access.js';

export class BookingRecordError extends Error {
  constructor() { super('Booking not found or unavailable'); this.code = 'BOOKING_NOT_FOUND'; }
}
const uuid = z.string().uuid();
const instant = value => value ? new Date(value).toISOString() : null;
const amount = value => value == null ? null : Number(value);
const activeStates = ['confirmed', 'handed_over', 'returned', 'completed', 'disputed'];

export function historyFilters(input = {}) {
  const tab = ['all', 'upcoming', 'past', 'cancelled'].includes(input.tab) ? input.tab : 'all';
  const page = /^\d{1,6}$/.test(String(input.page ?? '')) ? Math.max(1, Number(input.page)) : 1;
  return { tab, page, q: typeof input.q === 'string' ? input.q.trim().slice(0, 100) : '' };
}

// Actor IDs come exclusively from authenticated server boundaries, never URL parameters.
async function scope(tx, actor, env) {
  if (actor?.kind === 'customer') {
    const user = await lockCustomerAccount(tx, actor.session, env);
    return { condition: tx`o.customer_id=${user.id}` };
  }
  if (!uuid.safeParse(actor?.id).success) throw new BookingRecordError();
  if (actor.kind === 'owner') {
    const [user] = await tx`SELECT id FROM "user" WHERE id=${actor.id} AND role='client' AND account_status='active' FOR SHARE`;
    if (user) return { condition: tx`r.client_id=${user.id}` };
  }
  if (actor.kind === 'admin') {
    const [admin] = await tx`SELECT id FROM admin_user WHERE id=${actor.id} AND is_active=true FOR SHARE`;
    if (admin) return { condition: tx`true` };
  }
  throw new BookingRecordError();
}

function orderDTO(row) {
  return { id: row.id, reference: row.reference, title: row.listing_snapshot?.title || 'Booked property',
    state: row.state === 'held' && row.hold_expired ? 'expired' : row.state,
    createdAt: instant(row.created_at), timeZone: row.time_zone || 'Asia/Kolkata',
    rentMinor: amount(row.amount_rent_minor), feeMinor: amount(row.amount_fee_minor), depositMinor: amount(row.amount_deposit_minor) };
}

export async function listBookingRecords(database, actor, input = {}, env = process.env) {
  const filters = historyFilters(input), size = 20;
  return database.begin(async tx => {
    const { condition: allowed } = await scope(tx, actor, env);
    const tab = filters.tab === 'upcoming' ? tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','disputed') AND v.ends_at>clock_timestamp())`
      : filters.tab === 'past' ? tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','completed','disputed') AND v.ends_at<=clock_timestamp())`
      : filters.tab === 'cancelled' ? tx`(o.state IN ('cancelled','expired') OR (o.state='held' AND o.hold_expires_at<=clock_timestamp()) OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state='cancelled'))` : tx`true`;
    // POSITION treats percent/underscore literally; customer search cannot widen its ownership scope.
    const match = tx`(${filters.q}='' OR position(lower(${filters.q}) in lower(o.reference))>0
      OR position(lower(${filters.q}) in lower(coalesce(o.listing_snapshot->>'title','')))>0
      OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND position(lower(${filters.q}) in lower(v.reference))>0))`;
    const [{ count }] = await tx`SELECT count(*)::int count FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${allowed} AND ${tab} AND ${match}`;
    const pages = Math.max(1, Math.ceil(count / size)), page = Math.min(filters.page, pages);
    const rows = await tx`SELECT o.*,o.hold_expires_at<=clock_timestamp() hold_expired,
      (SELECT count(*)::int FROM booking v WHERE v.order_id=o.id) visit_count,
      (SELECT jsonb_agg(DISTINCT v.state) FROM booking v WHERE v.order_id=o.id) visit_states,
      (SELECT jsonb_agg(jsonb_build_object('environment',p.environment,'state',p.state)) FROM payment_order p WHERE p.booking_order_id=o.id) payments
      FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${allowed} AND ${tab} AND ${match}
      ORDER BY o.created_at DESC,o.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`;
    return { ...filters, page, pages, total: count, items: rows.map(row => ({ ...orderDTO(row), visitCount: row.visit_count,
      visitStates: row.visit_states || [], payments: row.payments || [] })) };
  });
}

export async function readBookingRecord(database, actor, orderId, env = process.env) {
  if (!uuid.safeParse(orderId).success) throw new BookingRecordError();
  return database.begin(async tx => {
    const { condition: allowed } = await scope(tx, actor, env);
    const [order] = await tx`SELECT o.*,o.hold_expires_at<=clock_timestamp() hold_expired FROM booking_order o JOIN rentable r ON r.id=o.rentable_id
      WHERE o.id=${orderId} AND ${allowed}`;
    if (!order) throw new BookingRecordError();
    const rows = await tx`SELECT id,reference,state,local_day,day,slot,guests,starts_at,ends_at,hours_known,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,created_at,confirmed_at,cancelled_at,updated_at,lifecycle_version,visit_provenance
      FROM booking WHERE order_id=${order.id} ORDER BY item_position NULLS LAST,day,id`;
    const visits = rows.map(row => ({ id: row.id, reference: row.reference, state: row.state,
      date: (row.local_day || row.day) instanceof Date ? (row.local_day || row.day).toISOString().slice(0, 10) : String(row.local_day || row.day).slice(0, 10), slot: row.slot, guests: row.guests,
      startsAt: row.hours_known ? instant(row.starts_at) : null, endsAt: row.hours_known ? instant(row.ends_at) : null,
      rentMinor: amount(row.amount_rent_minor), feeMinor: amount(row.amount_fee_minor), depositMinor: amount(row.amount_deposit_minor),
      version: row.lifecycle_version, provenance: row.visit_provenance,
      timeline: [{ kind: 'created', at: instant(row.created_at) }, ...(row.confirmed_at ? [{ kind: 'confirmed', at: instant(row.confirmed_at) }] : []),
        ...(row.cancelled_at ? [{ kind: 'cancelled', at: instant(row.cancelled_at) }] : [])], updatedAt: instant(row.updated_at) }));
    const proofs = await tx`SELECT e.id,e.booking_id,e.kind,e.nature,e.occurred_at,e.recorded_at,e.note FROM visit_evidence e
      JOIN booking b ON b.id=e.booking_id WHERE b.order_id=${order.id} ORDER BY e.recorded_at,e.id`;
    for (const visit of visits) {
      visit.evidence = proofs.filter(p => p.booking_id === visit.id).map(p => ({ id: p.id, kind: p.kind, nature: p.nature,
        occurredAt: instant(p.occurred_at), recordedAt: instant(p.recorded_at), ...(actor.kind === 'customer' ? {} : { note: p.note }) }));
      visit.reviewEligible = visit.state === 'completed' && visit.provenance === 'real' && visit.evidence.some(p => p.kind === 'complete' && p.nature === 'actual');
    }
    const payments = await tx`SELECT p.id,p.provider,p.environment,p.mode,p.state,p.purpose,p.provider_order_id,p.expected_minor,
      coalesce((SELECT sum(t.captured_minor) FROM payment_transaction t JOIN payment_attempt a ON a.id=t.attempt_id
        WHERE a.payment_order_id=p.id AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at IS NOT NULL),0)::text captured_minor,
      coalesce((SELECT sum(f.actual_minor) FROM refund f JOIN payment_transaction t ON t.id=f.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id
        WHERE a.payment_order_id=p.id AND f.state='succeeded'),0)::text refunded_minor,
      (SELECT jsonb_agg(jsonb_build_object('state',f.state,'expectedMinor',f.expected_minor,'actualMinor',f.actual_minor,'providerRefundId',f.provider_refund_id,'needsReview',EXISTS(SELECT 1 FROM refund_execution e WHERE e.refund_id=f.id AND e.failure_code IS NOT NULL)))
        FROM refund f JOIN payment_transaction t ON t.id=f.transaction_id JOIN payment_attempt a ON a.id=t.attempt_id WHERE a.payment_order_id=p.id) refunds,
      EXISTS(SELECT 1 FROM payment_execution e WHERE e.payment_order_id=p.id) recoverable
      FROM payment_order p WHERE p.booking_order_id=${order.id} ORDER BY p.created_at,p.id`;
    const events = await tx`SELECT kind,created_at,payload->>'phase' phase FROM booking_lifecycle_event WHERE order_id=${order.id} ORDER BY created_at,id`;
    let arrival = null;
    // No private listing fields are even selected until ownership and confirmed visit status are established.
    if (visits.some(visit => activeStates.includes(visit.state))) {
      const [place] = await tx`SELECT r.exact_address,ST_X(r.location) longitude,ST_Y(r.location) latitude,u.name,u.phone
        FROM rentable r JOIN "user" u ON u.id=r.client_id WHERE r.id=${order.rentable_id}`;
      arrival = { address: place.exact_address || null, longitude: place.longitude, latitude: place.latitude,
        hostName: place.name || null, hostPhone: place.phone || null,
        visitIds: visits.filter(visit => activeStates.includes(visit.state)).map(visit => visit.id) };
    }
    return { ...orderDTO(order), visits, arrival,
      contact: { name: order.listing_snapshot?.contact?.name || null, phone: order.listing_snapshot?.contact?.phone || null },
      purpose: order.listing_snapshot?.purpose || null,
      policy: { version: order.policy_version, cancellationTier: order.policy_snapshot?.cancellationTier || null,
        houseRules: Array.isArray(order.policy_snapshot?.houseRules) ? order.policy_snapshot.houseRules.filter(x => typeof x === 'string') : [] },
      events: events.map(row => ({ kind: /^cancel_[a-f0-9]{32}$/.test(row.kind) ? 'visits_cancelled' : /^refund_[a-f0-9]{32}$/.test(row.kind) ? 'test_refund_processed'
        : /^visit_[a-f0-9]{32}$/.test(row.kind) ? (['handover','return','complete'].includes(row.phase) ? `visit_${row.phase}_recorded` : 'visit_evidence_recorded') : row.kind, at: instant(row.created_at) })),
      payments: payments.map(p => ({ id: p.id, provider: p.provider, environment: p.environment, state: p.state, purpose: p.purpose,
        providerOrderId: p.provider_order_id, expectedMinor: amount(p.expected_minor), capturedMinor: amount(p.captured_minor),
        refundedMinor: amount(p.refunded_minor), actualBankMinor: p.environment === 'live' && p.mode === 'real' ? amount(p.captured_minor) : 0,
        refunds: p.refunds || [], recoverable: p.recoverable })) };
  });
}
