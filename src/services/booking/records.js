import 'server-only';
import { visitOperation } from '../domain/booking-operations.js';
import { z } from 'zod';
import { normalizePublicPhotos } from '../domain/listing-content.js';
import { lockCustomerAccount } from '../auth/customer-access.js';

export class BookingRecordError extends Error {
  constructor() { super('Booking not found or unavailable'); this.code = 'BOOKING_NOT_FOUND'; }
}
const uuid = z.string().uuid();
const instant = value => value ? new Date(value).toISOString() : null;
const amount = value => value == null ? null : Number(value);
const activeStates = ['confirmed', 'handed_over', 'returned', 'completed', 'disputed'];

export function historyFilters(input = {}, operational = false) {
  const tab = ['all', 'upcoming', 'past', 'cancelled', ...(operational ? ['today','action_needed'] : [])].includes(input.tab) ? input.tab : 'all';
  const page = /^\d{1,6}$/.test(String(input.page ?? '')) ? Math.max(1, Number(input.page)) : 1;
  return { tab, page, ...(operational ? {property: uuid.safeParse(input.property).success ? input.property : ''} : {}), q: typeof input.q === 'string' ? input.q.trim().slice(0, 100) : '' };
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
  return { photo: normalizePublicPhotos(row.listing_snapshot?.photos ?? row.current_photos, { cloudName: process.env.CLOUDINARY_CLOUD_NAME })[0] ?? null, firstVisit: row.first_visit ? String(row.first_visit).slice(0, 10) : null, id: row.id, reference: row.reference, title: row.listing_snapshot?.title || 'Booked property',
    state: row.state === 'held' && row.hold_expired ? 'expired' : row.state,
    createdAt: instant(row.created_at), timeZone: row.time_zone || 'Asia/Kolkata',
    rentMinor: amount(row.amount_rent_minor), feeMinor: amount(row.amount_fee_minor), depositMinor: amount(row.amount_deposit_minor) };
}

export async function listBookingRecords(database, actor, input = {}, env = process.env) {
  const operational = actor.kind !== 'customer';
  const filters = historyFilters(input, operational), size = 20;
  return database.begin(async tx => {
    const { condition: allowed } = await scope(tx, actor, env);
    const upcoming = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','disputed') AND v.ends_at>clock_timestamp())`;
    const past = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','completed','disputed') AND v.ends_at<=clock_timestamp())`;
    const cancelled = tx`(o.state IN ('cancelled','expired') OR (o.state='held' AND o.hold_expires_at<=clock_timestamp()) OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state='cancelled'))`;
    const today = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','disputed') AND v.starts_at < (date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata' AND v.ends_at > date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
    const actionNeeded = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND (v.state IN ('returned','disputed') OR (v.state='confirmed' AND v.starts_at<=clock_timestamp()) OR (v.state='handed_over' AND v.ends_at<=clock_timestamp()) OR (v.state IN ('confirmed','handed_over') AND NOT v.hours_known)))`;
    const property = operational && filters.property ? tx`o.rentable_id=${filters.property}` : tx`true`;
    const tab = filters.tab === 'today' ? today : filters.tab === 'action_needed' ? actionNeeded : filters.tab === 'upcoming' ? upcoming
      : filters.tab === 'past' ? past
      : filters.tab === 'cancelled' ? cancelled : tx`true`;
    // POSITION treats percent/underscore literally; customer search cannot widen its ownership scope.
    const match = tx`(${filters.q}='' OR position(lower(${filters.q}) in lower(o.reference))>0
      OR position(lower(${filters.q}) in lower(coalesce(o.listing_snapshot->>'title','')))>0
      OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND position(lower(${filters.q}) in lower(v.reference))>0))`;
    const [summary] = await tx`SELECT count(*)::int total,
      count(*) FILTER (WHERE ${upcoming})::int upcoming,
      count(*) FILTER (WHERE ${past})::int past,
      count(*) FILTER (WHERE ${cancelled})::int cancelled,
      count(*) FILTER (WHERE ${today})::int today, count(*) FILTER (WHERE ${actionNeeded})::int action_needed
      FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${allowed} AND ${property} AND ${match}`;
    const count = filters.tab === 'all' ? summary.total : summary[filters.tab];
    const pages = Math.max(1, Math.ceil(count / size)), page = Math.min(filters.page, pages);
    const rows = await tx`SELECT o.*,r.photos current_photos,o.hold_expires_at<=clock_timestamp() hold_expired,
      (SELECT min(v.day)::text FROM booking v WHERE v.order_id=o.id) first_visit,
      (SELECT count(*)::int FROM booking v WHERE v.order_id=o.id) visit_count,
      (SELECT jsonb_agg(DISTINCT v.state) FROM booking v WHERE v.order_id=o.id) visit_states,
      (SELECT jsonb_agg(jsonb_build_object('environment',p.environment,'state',p.state)) FROM payment_order p WHERE p.booking_order_id=o.id) payments
      FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${allowed} AND ${property} AND ${tab} AND ${match}
      ORDER BY CASE WHEN ${operational} THEN (SELECT min(v.starts_at) FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','disputed')) END ASC NULLS LAST,o.created_at DESC,o.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`;
    return { ...filters, page, pages, total: count, summary, items: rows.map(row => ({ ...orderDTO(row), ...(operational ? {propertyId:row.rentable_id} : {}), visitCount: row.visit_count,
      visitStates: row.visit_states || [], payments: row.payments || [] })) };
  });
}

export async function readBookingRecord(database, actor, orderId, env = process.env) {
  if (!uuid.safeParse(orderId).success) throw new BookingRecordError();
  return database.begin(async tx => {
    const { condition: allowed } = await scope(tx, actor, env);
    const [order] = await tx`SELECT o.*,r.photos current_photos,o.hold_expires_at<=clock_timestamp() hold_expired FROM booking_order o JOIN rentable r ON r.id=o.rentable_id
      WHERE o.id=${orderId} AND ${allowed}`;
    if (!order) throw new BookingRecordError();
    const [{now}] = await tx`SELECT clock_timestamp() now`;
    const rows = await tx`SELECT id,reference,state,local_day,day,slot,guests,starts_at,ends_at,hours_known,
      amount_rent_minor,amount_fee_minor,amount_deposit_minor,created_at,confirmed_at,cancelled_at,updated_at,lifecycle_version,visit_provenance
      FROM booking WHERE order_id=${order.id} ORDER BY item_position NULLS LAST,day,id`;
    const visits = rows.map(row => ({ ...(actor.kind === 'customer' ? {} : {operation:visitOperation(row,now)}), id: row.id, reference: row.reference, state: row.state,
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
    const arrivalStates = actor.kind === 'customer' ? activeStates : ['confirmed','handed_over','returned','disputed'];
    const operationalContact = visits.some(v=>arrivalStates.includes(v.state));
    // No private listing fields are even selected until ownership and confirmed visit status are established.
    if (visits.some(visit => arrivalStates.includes(visit.state))) {
      const [place] = await tx`SELECT r.exact_address,ST_X(r.location) longitude,ST_Y(r.location) latitude,u.name,u.phone
        FROM rentable r JOIN "user" u ON u.id=r.client_id WHERE r.id=${order.rentable_id}`;
      arrival = { address: place.exact_address || null, longitude: place.longitude, latitude: place.latitude,
        hostName: place.name || null, hostPhone: place.phone || null,
        visitIds: visits.filter(visit => arrivalStates.includes(visit.state)).map(visit => visit.id) };
    }
    let relationships;
    if(actor.kind !== 'customer') {
      const [property] = await tx`SELECT client_id FROM rentable WHERE id=${order.rentable_id}`;
      relationships={propertyId:order.rentable_id,...(actor.kind==='admin'?{customerId:order.customer_id,clientId:property.client_id}:{})};
    }
    return { ...orderDTO(order), ...(relationships ? {relationships} : {}), visits, arrival,
      contact: actor.kind==='customer' || operationalContact ? { name: order.listing_snapshot?.contact?.name || null, phone: order.listing_snapshot?.contact?.phone || null } : { name:null,phone:null,withheld:true },
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
