import 'server-only';
import { z } from 'zod';
import { badRequest } from '@/utils/apiError.js';
import { authorize, ledger } from './statements.js';
import { maskedDestination } from '../domain/payout-destinations.js';

const monthNow = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
export function earningsFilters(query = {}) {
  const parsed = z.object({
    month: z.string().regex(/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/).default(query.period || monthNow()),
    environment: z.enum(['live','test','simulated','legacy_unknown']).optional(),
    propertyId: z.string().uuid().or(z.literal('')).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  }).safeParse(query);
  if (!parsed.success) throw badRequest('INVALID_FILTER', 'Choose a valid month, booking type and property.');
  return parsed.data;
}
// Receipt-cohort statement: the IST month when rent was recorded, with today's
// refund and visit outcomes. A visit's quoted rent is counted once, even if
// several partial-payment allocations contribute to it.
function visits(tx, actor, filters) {
  const start = `${filters.month}-01`;
  return tx`WITH receipts AS (${ledger(tx)})
    SELECT b.id,b.order_id,b.reference,b.state,b.local_day::text visit_date,b.slot,
      max(l.title) title,max(l.rentable_id::text) property_id,
      max(l.quote_rent_minor::bigint)::text booked_rent_minor,
      sum(l.actual_minor::bigint)::text collected_minor,sum(l.simulated_minor::bigint)::text simulated_minor,
      sum(l.refunded_minor::bigint)::text refunded_minor,sum(l.refund_pending_minor::bigint)::text refund_pending_minor,
      min(l.created_at) recorded_at,
      jsonb_agg(l.id ORDER BY l.created_at,l.id) earning_line_ids,
      CASE WHEN max(r.client_id::text)=${actor.id} THEN true ELSE false END booking_link_available,
      split_part(trim(coalesce(max(u.name),'')),' ',1) guest_first_name
    FROM receipts l JOIN booking b ON b.id=l.booking_id JOIN booking_order bo ON bo.id=b.order_id
      JOIN rentable r ON r.id=b.rentable_id LEFT JOIN "user" u ON u.id=bo.customer_id
    WHERE l.owner_id=${actor.id} AND l.component='rent' AND l.environment=${filters.environment}
      AND (${filters.propertyId}='' OR l.rentable_id::text=${filters.propertyId})
      AND l.created_at>=(${start}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND l.created_at<(((${start}::date + interval '1 month')::timestamp) AT TIME ZONE 'Asia/Kolkata')
    GROUP BY b.id,b.order_id,b.reference,b.state,b.local_day,b.slot`;
}
export async function ownerPayoutStatus(tx, actor) {
  const rows = await tx`SELECT * FROM payout_destination WHERE client_id=${actor.id} ORDER BY version DESC`;
  const current = rows.find(r => ['submitted','verified'].includes(r.state));
  const failed = !current && rows.find(r => r.state==='failed');
  return {
    railAvailable: false,
    kind: failed ? 'failed' : current ? 'unavailable' : 'missing',
    masked: current ? maskedDestination(current) : null,
    failureReason: failed?.failure_reason || null,
    methodState: current?.state || null,
  };
}
export async function readOwnerEarnings(tx, actor, chosen, { all = false } = {}) {
  await authorize(tx, actor);
  if (actor.kind !== 'owner') throw badRequest('OWNER_REQUIRED','Open earnings from your owner account.');
  const [gateway] = await tx`SELECT environment::text FROM payment_gateway_config ORDER BY version DESC LIMIT 1`;
  const filters = { ...chosen, environment: chosen.environment || gateway?.environment || 'live' };
  const grouped = visits(tx, actor, filters);
  const [summary] = await tx`SELECT count(*)::int count,
    coalesce(sum(v.booked_rent_minor::bigint),0)::text booked_rent_minor,
    coalesce(sum(v.refunded_minor::bigint),0)::text refunded_minor,
    coalesce(sum(v.booked_rent_minor::bigint) FILTER (WHERE v.state='completed'),0)::text completed_rent_minor
    FROM (${grouped}) v`;
  const pages = Math.max(1,Math.ceil(summary.count/30));
  filters.page = Math.min(filters.page,pages);
  const [rows, environments, properties, payoutStatus] = await Promise.all([
    tx`SELECT v.* FROM (${grouped}) v ORDER BY v.recorded_at DESC,v.id ${all ? tx`` : tx`LIMIT 30 OFFSET ${(filters.page-1)*30}`}`,
    tx`SELECT DISTINCT l.environment FROM (${ledger(tx)}) l WHERE l.owner_id=${actor.id} AND l.component='rent' ORDER BY l.environment`,
    tx`SELECT DISTINCT l.rentable_id id,l.title FROM (${ledger(tx)}) l WHERE l.owner_id=${actor.id} AND l.component='rent' ORDER BY l.title,l.rentable_id`,
    ownerPayoutStatus(tx,actor),
  ]);
  return {
    filters, pages, count: summary.count, timeZone: 'Asia/Kolkata', currency: 'INR', asOf: new Date().toISOString(),
    basis: 'Rent recorded in this IST calendar month, with current visit and refund outcomes.',
    deductionsNotice: 'Commission and tax deductions are not applied yet. Booked rent is not a payout amount.',
    environments: [...new Set([filters.environment,...environments.map(r => r.environment)])], properties, payoutStatus,
    totals: { bookedRentMinor: summary.booked_rent_minor, refundedMinor: summary.refunded_minor, completedRentMinor: summary.completed_rent_minor },
    items: rows.map(r => ({
      id:r.id, orderId:r.order_id, reference:r.reference, title:r.title, propertyId:r.property_id,
      visitDate:r.visit_date, slot:r.slot, state:r.state, guestFirstName:r.guest_first_name || 'Guest',
      bookedRentMinor:r.booked_rent_minor, collectedMinor:r.collected_minor, simulatedMinor:r.simulated_minor,
      refundedMinor:r.refunded_minor, refundPendingMinor:r.refund_pending_minor,
      recordedAt:new Date(r.recorded_at).toISOString(), earningLineIds:r.earning_line_ids,
      bookingLinkAvailable:r.booking_link_available,
    })),
  };
}
export async function ownerEarnings(database, actor, query={}, options={}) {
  return database.begin('isolation level repeatable read read only', tx => readOwnerEarnings(tx,actor,earningsFilters(query),options));
}
const rupees = value => {
  const n=BigInt(value ?? 0), positive=n<0n?-n:n;
  return `${n<0n?'-':''}${positive/100n}.${String(positive%100n).padStart(2,'0')}`;
};
const csvCell = value => '"'+String(value ?? '').replace(/^(?:\s*[=+@-]|[\t\r\n])/,"'$&").replaceAll('"','""')+'"';
export async function ownerEarningsCsv(database, actor, query={}) {
  const filters=earningsFilters(query);
  return database.begin('isolation level repeatable read',async tx => {
    const s=await readOwnerEarnings(tx,actor,filters,{all:true});
    const rows=[
      ['Rentra statement',filters.month,'Asia/Kolkata',s.filters.environment],
      ['Basis',s.basis],['Deductions',s.deductionsNotice],
      ['Booked rent INR','Refunded INR','Completed visits rent INR'],
      [rupees(s.totals.bookedRentMinor),rupees(s.totals.refundedMinor),rupees(s.totals.completedRentMinor)],
      ['Property','Visit date','Guest first name','Booking reference','Visit status','Booked rent INR','Refunded INR','Collected rent INR'],
      ...s.items.map(r=>[r.title,r.visitDate,r.guestFirstName,r.reference,r.state.replaceAll('_',' '),rupees(r.bookedRentMinor),rupees(r.refundedMinor),rupees(r.collectedMinor)]),
    ];
    await tx`INSERT INTO audit_log(actor_type,actor_id,entity,entity_id,action,"after") VALUES ('client',${actor.id},'finance_statement',${filters.month},'finance_statement_downloaded',${JSON.stringify({filters:s.filters,count:s.count,timeZone:'Asia/Kolkata'})}::text::jsonb)`;
    return rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
  });
}
