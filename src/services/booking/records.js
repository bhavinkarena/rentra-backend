import { ledger } from '../finance/statements.js';
import { ownerDayVisits, ownerVisitDay } from './owner-visits.js';
import 'server-only';
import { orderEnvironmentSql, bookedRentSql, todayVisitSql } from '../admin/dashboard-scope.js';
import { houseRuleLines } from '../domain/venue-rules.js';
import { visitLabel } from '../domain/booking-record.js';
import { savedListingHref } from '../domain/saved-places.js';
import { listingPath } from '../domain/listing-url.js';
import { addLocalDays, propertyToday } from '../domain/booking-dates.js';
import { visitOperation } from '../domain/booking-operations.js';
import {isLocalDate} from '../domain/booking-dates.js';
import { z } from 'zod';
import { normalizePublicPhotos } from '../domain/listing-content.js';
import { lockCustomerAccount } from '../auth/customer-access.js';
import { visitEvidenceRecords } from './visit-evidence.js';
import { casesForOrder } from './booking-cases.js';

export class BookingRecordError extends Error {
  constructor() { super('Booking not found or unavailable'); this.code = 'BOOKING_NOT_FOUND'; }
}
const uuid = z.string().uuid();
const instant = value => value ? new Date(value).toISOString() : null;
const amount = value => value == null ? null : Number(value);
const activeStates = ['confirmed', 'handed_over', 'returned', 'completed', 'disputed'];

export function historyFilters(input = {}, operational = false) {
  const tab = ['all', 'upcoming', 'past', 'cancelled', ...(operational ? ['today','action_needed','with_rentra'] : [])].includes(input.tab) ? input.tab : 'all';
  const page = /^\d{1,6}$/.test(String(input.page ?? '')) ? Math.max(1, Number(input.page)) : 1;
  return { tab, page, ...(operational ? {property: uuid.safeParse(input.property).success ? input.property : '',
      // Entertainment plan, Phase 11: one court of a venue (only with a property).
      resource: uuid.safeParse(input.resource).success ? input.resource : ''} : {}),
    vertical: ['farmhouse', 'entertainment'].includes(input.vertical) ? input.vertical : '',
    from:isLocalDate(input.from)?input.from:'',to:isLocalDate(input.to)?input.to:'',event:['arriving','leaving'].includes(input.event)?input.event:'all',
    createdFrom:isLocalDate(input.createdFrom)?input.createdFrom:'',createdTo:isLocalDate(input.createdTo)?input.createdTo:'',
    environment:['live','test','simulated'].includes(input.environment)?input.environment:'',rentOnly:input.rentOnly==='1'?'1':'',unit:input.unit==='visits'?'visits':'',
    q: typeof input.q === 'string' ? input.q.trim().slice(0, 100) : '' };
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

// Admin lists retain the detail contract's active-fulfillment contact boundary.
function adminCard(row) {
  const active = row.active_fulfillment;
  return { owner: { id: row.owner_id, name: row.owner_name || null },
    guestName: active ? row.listing_snapshot?.contact?.name || null : null,
    guestWithheld: !active, lastVisit: row.last_visit || row.first_visit || null };
}

// BOOK-01: guest, visits with their next action, and contact inside the same window as the detail.
function ownerCard(row) {
  const visits = (row.visit_rows || []).map(v => ({ id: v.id, reference: v.reference, state: v.state, guests: v.guests,
    date: String(v.local_day).slice(0, 10), startsAt: v.hours_known ? instant(v.starts_at) : null, label: visitLabel(v),
    operation: visitOperation(v, row.as_of, row.booking_config?.earlyArrivalMinutes ?? 120) }));
  const open = visits.some(v => ['confirmed','handed_over','returned','disputed'].includes(v.state)) || row.recently_completed;
  const contact = row.listing_snapshot?.contact;
  return { visits, guests: Math.max(0, ...visits.map(v => v.guests || 0)),
    contact: { name: contact?.name?.trim().split(/\s+/)[0] || null, phone: open ? contact?.phone || null : null } };
}

export async function listBookingRecords(database, actor, input = {}, env = process.env) {
  const operational = actor.kind !== 'customer';
  const filters = historyFilters(input, operational), size = 20;
  return database.begin(async tx => {
    const { condition: scoped } = await scope(tx, actor, env);
    // An unpaid or abandoned checkout is not a booking the owner has to handle.
    const dashboardFilter = actor.kind === 'admin' ? tx`(${filters.environment}='' OR ${orderEnvironmentSql(tx)}=${filters.environment})
      AND (${filters.createdFrom}='' OR o.created_at>=NULLIF(${filters.createdFrom},'')::date AT TIME ZONE 'Asia/Kolkata')
      AND (${filters.createdTo}='' OR o.created_at<(NULLIF(${filters.createdTo},'')::date+1) AT TIME ZONE 'Asia/Kolkata')
      AND (${filters.rentOnly}='' OR ${bookedRentSql(tx)}>0)` : tx`true`;
    const allowed = actor.kind === 'owner' ? tx`${scoped} AND o.state NOT IN ('held','expired')` : tx`${scoped} AND ${dashboardFilter}`;
    if (actor.kind === 'admin' && filters.tab === 'today' && filters.unit === 'visits') {
      const visitFilter = tx`${allowed} AND ${todayVisitSql(tx, propertyToday())}
        AND ${filters.property ? tx`o.rentable_id=${filters.property}` : tx`true`}
        AND (${filters.q}='' OR position(lower(${filters.q}) in lower(o.reference))>0
          OR position(lower(${filters.q}) in lower(v.reference))>0
          OR position(lower(${filters.q}) in lower(coalesce(o.listing_snapshot->>'title','')))>0)`;
      const [count] = await tx`SELECT count(*)::int total FROM booking v JOIN booking_order o ON o.id=v.order_id JOIN rentable r ON r.id=o.rentable_id WHERE ${visitFilter}`;
      const pages = Math.max(1,Math.ceil(count.total/size)), page=Math.min(filters.page,pages);
      const rows = await tx`SELECT o.*,r.client_id owner_id,(SELECT u.name FROM "user" u WHERE u.id=r.client_id) owner_name,
        EXISTS(SELECT 1 FROM booking b WHERE b.order_id=o.id AND b.state IN ('confirmed','handed_over','returned','disputed')) active_fulfillment,v.id visit_id,v.reference visit_reference,v.local_day::text first_visit,v.state visit_state,v.starts_at,v.ends_at,v.slot,v.hours_known,(SELECT jsonb_agg(jsonb_build_object('environment',p.environment,'state',p.state)) FROM payment_order p WHERE p.booking_order_id=o.id) payments
        FROM booking v JOIN booking_order o ON o.id=v.order_id JOIN rentable r ON r.id=o.rentable_id WHERE ${visitFilter} ORDER BY v.starts_at,v.id LIMIT ${size} OFFSET ${(page-1)*size}`;
      return {...filters,page,pages,total:count.total,summary:{total:count.total,today:count.total},properties:[],verticals:[],resources:[],items:rows.map(r=>({...orderDTO(r),...adminCard(r),visitId:r.visit_id,visitCount:1,visitStates:[r.visit_state],payments:r.payments || [],firstVisitLabel:`${r.visit_reference} \u00b7 ${r.first_visit}`,firstVisitSlot:r.slot,firstVisitStartsAt:r.hours_known?instant(r.starts_at):null}))};
    }
    const upcoming = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','disputed') AND v.ends_at>clock_timestamp())`;
    const past = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','completed','disputed','no_show') AND v.ends_at<=clock_timestamp())`;
    const cancelled = tx`(o.state IN ('cancelled','expired') OR (o.state='held' AND o.hold_expires_at<=clock_timestamp()) OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state='cancelled'))`;
    const today = tx`EXISTS(SELECT 1 FROM booking b WHERE b.order_id=o.id AND ${ownerVisitDay(tx, propertyToday())})`;
    // CP13: an open incident needs Rentra follow-up, so it is admin work, not owner work.
    const openIncident = actor.kind === 'admin' ? tx`OR EXISTS(SELECT 1 FROM visit_incident i WHERE i.booking_id=v.id AND i.state='open')` : tx``;
    const actionNeeded = actor.kind === 'owner'
      ? tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.hours_known AND (v.state='returned' OR (v.state='confirmed' AND v.starts_at<=clock_timestamp()) OR (v.state='handed_over' AND v.ends_at<=clock_timestamp())))`
      : tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND (v.state IN ('returned','disputed') OR (v.state='confirmed' AND v.starts_at<=clock_timestamp()) OR (v.state='handed_over' AND v.ends_at<=clock_timestamp()) OR (v.state IN ('confirmed','handed_over') AND NOT v.hours_known) ${openIncident}))`;
    const withRentra = tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND (v.state='disputed' OR (v.state IN ('confirmed','handed_over','returned') AND NOT v.hours_known)))`;
    const property = tx`((${filters.from}='' AND ${filters.to}='') OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND (${filters.from}='' OR v.local_day>=NULLIF(${filters.from},'')::date) AND (${filters.to}='' OR v.local_day<=NULLIF(${filters.to},'')::date))) AND ${operational && filters.property ? tx`o.rentable_id=${filters.property}` : tx`true`}
      AND ${operational && filters.property && filters.resource ? tx`EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.resource_id=${filters.resource})` : tx`true`}
      AND ${filters.vertical ? tx`EXISTS(SELECT 1 FROM category c WHERE c.id=r.category_id AND c.vertical_code=${filters.vertical})` : tx`true`}`;
    const tab = filters.tab === 'with_rentra' ? withRentra : filters.tab === 'today' ? today : filters.tab === 'action_needed' ? actionNeeded : filters.tab === 'upcoming' ? upcoming
      : filters.tab === 'past' ? past
      : filters.tab === 'cancelled' ? cancelled : tx`true`;
    // POSITION treats percent/underscore literally; customer search cannot widen its ownership scope.
    const match = tx`(${filters.q}='' OR position(lower(${filters.q}) in lower(o.reference))>0
      OR position(lower(${filters.q}) in lower(coalesce(o.listing_snapshot->>'title','')))>0
      OR (${operational} AND (position(lower(${filters.q}) in lower(coalesce(o.listing_snapshot->'contact'->>'name','')))>0 OR position(${filters.q} in coalesce(o.listing_snapshot->'contact'->>'phone',''))>0))
      OR EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND position(lower(${filters.q}) in lower(v.reference))>0))`;
    const [summary] = await tx`SELECT count(*)::int total,
      count(*) FILTER (WHERE ${upcoming})::int upcoming,
      count(*) FILTER (WHERE ${past})::int past,
      count(*) FILTER (WHERE ${cancelled})::int cancelled,
      count(*) FILTER (WHERE ${today})::int today, count(*) FILTER (WHERE ${actionNeeded})::int action_needed, count(*) FILTER (WHERE ${withRentra})::int with_rentra
      FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${allowed} AND ${property} AND ${match}`;
    const properties=operational?await tx`SELECT r.id,r.title FROM rentable r WHERE ${actor.kind==='owner'?tx`r.client_id=${actor.id}`:tx`true`} ORDER BY r.title,r.id`:[];
    // Filter choices: the verticals this actor has bookings in, and the chosen property's courts.
    const verticals = (await tx`SELECT DISTINCT c.vertical_code AS code FROM booking_order o JOIN rentable r ON r.id=o.rentable_id
      JOIN category c ON c.id=r.category_id WHERE ${allowed} ORDER BY 1`).map(row => row.code);
    const resources = operational && filters.property ? await tx`SELECT rs.id,rs.name FROM rentable_resource rs JOIN rentable r ON r.id=rs.rentable_id
      WHERE rs.rentable_id=${filters.property} AND ${scoped} ORDER BY rs.sort_order,rs.name` : [];
    if (actor.kind === 'owner') {
      let visits = await ownerDayVisits(tx, actor.id, { filters, event:filters.event, limit: filters.tab === 'today' ? size : 0, offset: filters.tab === 'today' ? (filters.page-1)*size : 0 });
      summary.today = visits.total;
      if (filters.tab === 'today') {
        const pages = Math.max(1,Math.ceil(visits.total/size)), page = Math.min(filters.page,pages);
        if(page !== filters.page) visits = await ownerDayVisits(tx, actor.id, {filters,event:filters.event,limit:size,offset:(page-1)*size});
        return { ...filters,page,pages,total:visits.total,summary,items:visits.items,verticals,resources,properties };
      }
    }
    const count = filters.tab === 'all' ? summary.total : summary[filters.tab];
    // Work queues: the next active visit first. History: the most recent visit first.
    // "All": what is still ahead (soonest first), then the past (newest first).
    const nextStart = tx`(SELECT min(v.starts_at) FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','disputed'))`;
    const lastStart = tx`(SELECT max(v.starts_at) FROM booking v WHERE v.order_id=o.id)`;
    const order = !operational ? tx`o.created_at DESC,o.id DESC`
      : ['today', 'upcoming', 'action_needed'].includes(filters.tab) ? tx`${nextStart} ASC NULLS LAST,o.created_at DESC,o.id DESC`
      : filters.tab === 'all' ? tx`(${upcoming}) DESC,CASE WHEN ${upcoming} THEN ${nextStart} END ASC,${lastStart} DESC NULLS LAST,o.created_at DESC,o.id DESC`
      : tx`${lastStart} DESC NULLS LAST,o.created_at DESC,o.id DESC`;
    const pages = Math.max(1, Math.ceil(count / size)), page = Math.min(filters.page, pages);
    const rows = await tx`SELECT o.*,${actor.kind==='admin'?tx`r.client_id owner_id,(SELECT u.name FROM "user" u WHERE u.id=r.client_id) owner_name,
      (SELECT max(v.local_day)::text FROM booking v WHERE v.order_id=o.id) last_visit,
      EXISTS(SELECT 1 FROM booking v WHERE v.order_id=o.id AND v.state IN ('confirmed','handed_over','returned','disputed')) active_fulfillment,`:tx``}${actor.kind === 'admin' && filters.rentOnly ? bookedRentSql(tx) : tx`NULL`} dashboard_rent_minor,r.booking_config,r.photos current_photos,o.hold_expires_at<=clock_timestamp() hold_expired,
      (SELECT min(v.local_day)::text FROM booking v WHERE v.order_id=o.id) first_visit,
      (SELECT count(*)::int FROM booking v WHERE v.order_id=o.id) visit_count,
      (SELECT row_to_json(f) FROM (SELECT v.slot,v.local_day,v.starts_at,v.ends_at,v.hours_known,v.time_zone,v.slot_snapshot,rs.name AS resource_name
        FROM booking v LEFT JOIN rentable_resource rs ON rs.id=v.resource_id WHERE v.order_id=o.id
        ORDER BY v.item_position NULLS LAST,v.local_day,v.id LIMIT 1) f) first_row,
      (SELECT c.vertical_code FROM category c WHERE c.id=r.category_id) vertical,
      (SELECT jsonb_agg(DISTINCT v.state) FROM booking v WHERE v.order_id=o.id) visit_states,
      (SELECT jsonb_agg(f ORDER BY f.item_position NULLS LAST,f.local_day,f.id) FROM (SELECT v.id,v.reference,v.state,v.slot,v.local_day,v.starts_at,v.ends_at,v.hours_known,v.time_zone,v.slot_snapshot,v.guests,v.item_position,rs.name AS resource_name
        FROM booking v LEFT JOIN rentable_resource rs ON rs.id=v.resource_id WHERE v.order_id=o.id) f) visit_rows,
      clock_timestamp() as_of,
      EXISTS(SELECT 1 FROM visit_evidence e JOIN booking b ON b.id=e.booking_id WHERE b.order_id=o.id AND b.state='completed' AND e.kind='complete' AND e.occurred_at>now()-interval '7 days') recently_completed,
      (SELECT jsonb_agg(jsonb_build_object('environment',p.environment,'state',p.state)) FROM payment_order p WHERE p.booking_order_id=o.id) payments
      FROM booking_order o JOIN rentable r ON r.id=o.rentable_id WHERE ${allowed} AND ${property} AND ${tab} AND ${match}
      ORDER BY ${order} LIMIT ${size} OFFSET ${(page - 1) * size}`;
    return { ...filters, verticals, resources, properties,page, pages, total: count, summary, items: rows.map(row => ({ ...orderDTO(row), ...(actor.kind==='admin'?adminCard(row):{}), ...(actor.kind === 'admin' && filters.rentOnly ? {rentMinor:String(row.dashboard_rent_minor)} : {}), ...(operational ? {propertyId:row.rentable_id} : {}), visitCount: row.visit_count,
      visitStates: row.visit_states || [], payments: row.payments || [], vertical: row.vertical,
      // The first visit's own words and start, so a list says when and which court.
      firstVisitLabel: row.first_row ? visitLabel(row.first_row) : null, firstVisitSlot: row.first_row?.slot ?? null,
      firstVisitStartsAt: row.first_row?.hours_known ? instant(row.first_row.starts_at) : null,
      resourceName: row.first_row?.resource_name ?? null, ...(actor.kind === 'owner' ? ownerCard(row) : {}) })) };
  });
}

/**
 * "Book again" for a court booking: the venue page with the same activity,
 * duration and players on the same weekday, the next one from today. The guest
 * picks a fresh time there; old prices are never copied. Null for slot orders.
 */
export async function hourlyRebookHref(tx, orderId) {
  const [row] = await tx`SELECT r.slug,r.public_code,b.local_day::text AS day,b.guests,b.slot_snapshot
    FROM booking_order o JOIN rentable r ON r.id=o.rentable_id JOIN booking b ON b.order_id=o.id
    WHERE o.id=${orderId} AND r.rental_unit::text='hour' ORDER BY b.item_position NULLS LAST LIMIT 1`;
  if (!row) return null;
  const today = propertyToday();
  let date = addLocalDays(row.day, 7);
  while (date < today) date = addLocalDays(date, 7);
  const snapshot = row.slot_snapshot ?? {};
  return savedListingHref(listingPath(row.slug, row.public_code), snapshot.activity?.slug && snapshot.durationMinutes
    ? { kind: 'hourly', activity: snapshot.activity.slug, date, durationMinutes: snapshot.durationMinutes, guests: row.guests }
    : null);
}

export async function readBookingRecord(database, actor, orderId, env = process.env) {
  if (!uuid.safeParse(orderId).success) throw new BookingRecordError();
  return database.begin(async tx => {
    const { condition: allowed } = await scope(tx, actor, env);
    const [order] = await tx`SELECT o.*,r.booking_config,r.photos current_photos,o.hold_expires_at<=clock_timestamp() hold_expired FROM booking_order o JOIN rentable r ON r.id=o.rentable_id
      WHERE o.id=${orderId} AND ${allowed}`;
    if (!order) throw new BookingRecordError();
    const [{now}] = await tx`SELECT clock_timestamp() now`;
    const rows = await tx`SELECT b.id,b.reference,b.state,b.local_day,b.slot,b.guests,b.starts_at,b.ends_at,b.hours_known,
      b.amount_rent_minor,b.amount_fee_minor,b.amount_deposit_minor,b.created_at,b.confirmed_at,b.cancelled_at,b.updated_at,b.lifecycle_version,b.visit_provenance,
      b.slot_snapshot,b.resource_id,rs.name AS resource_name,b.slot_snapshot->'activity' AS activity
      FROM booking b LEFT JOIN rentable_resource rs ON rs.id=b.resource_id
      WHERE b.order_id=${order.id} ORDER BY b.item_position NULLS LAST,b.local_day,b.id`;
    const [{ vertical }] = await tx`SELECT c.vertical_code AS vertical FROM rentable r JOIN category c ON c.id=r.category_id WHERE r.id=${order.rentable_id}`;
    const visits = rows.map(row => ({ ...(actor.kind === 'customer' ? {} : {operation:visitOperation(row,now,order.booking_config?.earlyArrivalMinutes??120)}), id: row.id, reference: row.reference, state: row.state,
      date: row.local_day instanceof Date ? row.local_day.toISOString().slice(0, 10) : String(row.local_day).slice(0, 10), slot: row.slot, guests: row.guests,
      startsAt: row.hours_known ? instant(row.starts_at) : null, endsAt: row.hours_known ? instant(row.ends_at) : null,
      rentMinor: amount(row.amount_rent_minor), feeMinor: amount(row.amount_fee_minor), depositMinor: amount(row.amount_deposit_minor),
      includedGuests:row.slot_snapshot?.includedGuests??null,
      // BOOK-05/08: an arrival that started and was never checked in can be reported as a no-show.
      ...(actor.kind === 'owner' ? { noShowEligible: row.state === 'confirmed' && row.hours_known && new Date(row.starts_at) <= new Date(now) } : {}),
      version: row.lifecycle_version, provenance: row.visit_provenance,
      label: visitLabel({ ...row, slot_snapshot: { activity: row.activity }, time_zone: order.time_zone }),
      // Time-booked visits (courts): which court and activity. Null for slot visits.
      resource: row.resource_id ? { id: row.resource_id, name: row.resource_name } : null,
      activity: row.activity?.slug ? { slug: row.activity.slug, name: row.activity.name } : null,
      timeline: [{ kind: 'created', at: instant(row.created_at) }, ...(row.confirmed_at ? [{ kind: 'confirmed', at: instant(row.confirmed_at) }] : []),
        ...(row.cancelled_at ? [{ kind: 'cancelled', at: instant(row.cancelled_at) }] : [])], updatedAt: instant(row.updated_at) }));
    const records = await visitEvidenceRecords(tx, order.id, actor.kind);
    for (const visit of visits) {
      visit.evidence = records.evidence.get(visit.id) ?? [];
      if (actor.kind !== 'customer') visit.incidents = records.incidents.get(visit.id) ?? [];
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
    const operationalContact = visits.some(v=>arrivalStates.includes(v.state)) || (actor.kind==='owner' && (await tx`SELECT 1 FROM visit_evidence e JOIN booking b ON b.id=e.booking_id WHERE b.order_id=${order.id} AND b.state='completed' AND e.kind='complete' AND e.occurred_at>now()-interval '7 days' LIMIT 1`).length>0);
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
    const cases = await casesForOrder(tx, order.id, actor.kind);
    const rebookHref = actor.kind === 'customer' ? await hourlyRebookHref(tx, order.id) : null;
    const earningLines = actor.kind==='owner' ? await tx`SELECT l.id,l.booking_id FROM (${ledger(tx)}) l WHERE l.order_id=${order.id} AND l.owner_id=${actor.id} AND l.component='rent' ORDER BY l.created_at,l.id` : [];
    return { ...orderDTO(order), ...(actor.kind==='owner'?{ownerNote:order.owner_note,earningLines:earningLines.map(r=>({id:r.id,visitId:r.booking_id}))}:{}), vertical, ...(rebookHref ? { rebookHref } : {}), ...(relationships ? {relationships} : {}), visits, arrival, cases, ...(actor.kind==='owner'?{rentMinor:visits.filter(v=>v.state!=='cancelled').reduce((n,v)=>n+v.rentMinor,0),feeMinor:visits.filter(v=>v.state!=='cancelled').reduce((n,v)=>n+v.feeMinor,0)}:{}),
      contact: actor.kind==='customer' || operationalContact ? { name: order.listing_snapshot?.contact?.name || null, phone: order.listing_snapshot?.contact?.phone || null } : { name:null,phone:null,withheld:true },
      purpose: order.listing_snapshot?.purpose || null,
      policy: { publications: order.policy_snapshot?.publications || null, version: order.policy_version, cancellationTier: order.policy_snapshot?.cancellationTier || null,
        houseRules: houseRuleLines(order.policy_snapshot?.houseRules) },
      events: events.map(row => ({ kind: /^cancel_[a-f0-9]{32}$/.test(row.kind) ? 'visits_cancelled' : /^refund_[a-f0-9]{32}$/.test(row.kind) ? 'test_refund_processed'
        : /^visit_[a-f0-9]{32}$/.test(row.kind) ? (['handover','return','complete'].includes(row.phase) ? `visit_${row.phase}_recorded` : 'visit_evidence_recorded') : row.kind, at: instant(row.created_at) })),
      payments: payments.map(p => ({ id: p.id, provider: p.provider, environment: p.environment, state: p.state, purpose: p.purpose,
        providerOrderId: p.provider_order_id, expectedMinor: amount(p.expected_minor), capturedMinor: amount(p.captured_minor),
        refundedMinor: amount(p.refunded_minor), actualBankMinor: p.environment === 'live' && p.mode === 'real' ? amount(p.captured_minor) : 0,
        refunds: p.refunds || [], recoverable: p.recoverable })) };
  });
}
