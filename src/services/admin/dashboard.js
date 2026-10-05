import 'server-only';
import { addLocalDays } from '../domain/booking-dates.js';
import { unauthorized } from '@/utils/apiError.js';
import { capabilitiesFor } from '../auth/capabilities.js';
import {
  dashboardScope,
  orderEnvironmentSql,
  bookedRentSql,
  todayVisitSql,
} from './dashboard-scope.js';
import { paymentLedger, paymentAttentionSql } from '../payments/investigation.js';

const href = (path, filters = {}) =>
  `${path}${Object.keys(filters).length ? `?${new URLSearchParams(filters)}` : ''}`;
export async function readDecisionHistory(db, { from, to, page = 1 }) {
  const filter = db`l.entity='client_application' AND l.action IN ('application_approved','application_more_info','application_rejected') AND l.at>=${from}::date AT TIME ZONE 'Asia/Kolkata' AND l.at<(${to}::date+1) AT TIME ZONE 'Asia/Kolkata'`;
  const [count] = await db`SELECT count(*)::int total FROM audit_log l WHERE ${filter}`;
  const pages = Math.max(1, Math.ceil(count.total / 20));
  page = Math.min(page, pages);
  const items =
    await db`SELECT l.id,l.action,l.at,a.id application_id,a.legal_name label FROM audit_log l LEFT JOIN client_application a ON a.id::text=l.entity_id WHERE ${filter} ORDER BY l.at DESC,l.id LIMIT 20 OFFSET ${(page - 1) * 20}`;
  return { from, to, page, pages, total: count.total, items };
}
const metric = (key, label, value, unit, dateBasis, path, filters, scope) => ({
  key,
  label,
  value: String(value),
  unit,
  dateBasis,
  environment: dateBasis === 'Waiting now' && !key.startsWith('refund') ? 'all' : scope.environment,
  startInclusive:
    dateBasis === 'Waiting now'
      ? null
      : key === 'visits'
        ? new Date(`${scope.today}T00:00:00+05:30`).toISOString()
        : scope.startInclusive,
  endExclusive:
    dateBasis === 'Waiting now'
      ? null
      : key === 'visits'
        ? new Date(`${addLocalDays(scope.today, 1)}T00:00:00+05:30`).toISOString()
        : scope.endExclusive,
  generatedAt: scope.generatedAt,
  filters,
  href: href(path, filters),
});

/** Independently authorized, full-dataset aggregates. Failure reveals no SQL/error payload. */
export async function readAdminDashboard(db, adminId, input = {}, { now = new Date() } = {}) {
  const [admin] = await db`SELECT is_active,permissions FROM admin_user WHERE id=${adminId}`;
  if (!admin?.is_active) throw unauthorized('ADMIN_REQUIRED');
  const capabilities = capabilitiesFor(
    { isActive: admin.is_active, permissions: admin.permissions },
    'admin',
  );
  const scope = dashboardScope(input, now);
  const modules = {};
  const load = async (key, capability, work) => {
    if (!capabilities.includes(capability)) return;
    try {
      modules[key] = {
        availability: 'available',
        ...(await db.begin('isolation level repeatable read read only', work)),
      };
    } catch {
      modules[key] = { availability: 'unavailable' };
    }
  };
  await Promise.all([
    load('applications', 'admin.applications.read', async (tx) => {
      const [counts] = await tx`SELECT count(*)::int waiting,
        count(*) FILTER (WHERE assigned_to IS NULL)::int unassigned,
        count(*) FILTER (WHERE submitted_at<${scope.generatedAt}::timestamptz-interval '48 hours')::int overdue
        FROM client_application WHERE status='submitted'`;
      const rows =
        await tx`SELECT id,legal_name label,submitted_at FROM client_application WHERE status='submitted'
        ORDER BY submitted_at ASC NULLS LAST,id LIMIT 8`;
      const decisions =
        await tx`SELECT l.id,l.action status,a.id application_id,a.legal_name label,l.at reviewed_at FROM audit_log l LEFT JOIN client_application a ON a.id::text=l.entity_id
        WHERE l.entity='client_application' AND l.action IN ('application_approved','application_more_info','application_rejected') AND l.at>=${scope.startInclusive}::timestamptz AND l.at<${scope.endExclusive}::timestamptz
        ORDER BY l.at DESC,l.id LIMIT 8`;
      const throughput =
        await tx`SELECT (at AT TIME ZONE 'Asia/Kolkata')::date::text date,count(*)::int decisions
        FROM audit_log WHERE entity='client_application' AND action IN ('application_approved','application_more_info','application_rejected')
        AND at>=${scope.startInclusive}::timestamptz AND at<${scope.endExclusive}::timestamptz GROUP BY 1 ORDER BY 1`;
      return {
        counts,
        metrics: [
          metric(
            'applications',
            'Waiting owner applications',
            counts.waiting,
            'count',
            'Waiting now',
            '/admin/applications',
            {},
            scope,
          ),
        ],
        attention: rows.map((r) => ({
          label: r.label || 'Owner application',
          state: 'Waiting for review',
          href: `/admin/applications/${r.id}`,
          urgent:
            r.submitted_at &&
            new Date(r.submitted_at).getTime() <
              new Date(scope.generatedAt).getTime() - 48 * 3600000,
        })),
        recentActivity: decisions.map((r) => ({
          label: r.label || 'Application decision',
          state: r.status.replace('application_', ''),
          at: r.reviewed_at,
          href: r.application_id
            ? `/admin/applications/${r.application_id}`
            : href('/admin/applications/history', { from: scope.from, to: scope.to }),
          id: r.id,
        })),
        throughput: scope.days.map((date) => ({
          date,
          decisions: throughput.find((r) => r.date === date)?.decisions ?? 0,
        })),
        href: '/admin/applications',
        historyHref: href('/admin/applications/history', { from: scope.from, to: scope.to }),
      };
    }),
    load('properties', 'admin.properties.read', async (tx) => {
      const [counts] =
        await tx`SELECT count(*)::int waiting FROM rentable r JOIN listing_submission s ON s.rentable_id=r.id AND s.pass_number=r.review_pass WHERE r.status='pending_review'`;
      const rows =
        await tx`SELECT r.id,r.title label FROM rentable r JOIN listing_submission s ON s.rentable_id=r.id AND s.pass_number=r.review_pass WHERE r.status='pending_review' ORDER BY s.submitted_at,r.id LIMIT 8`;
      return {
        metrics: [
          metric(
            'properties',
            'Properties awaiting review',
            counts.waiting,
            'count',
            'Waiting now',
            '/admin/properties',
            { status: 'pending_review', submitted: '1' },
            scope,
          ),
        ],
        attention: rows.map((r) => ({
          label: r.label,
          state: 'Property review',
          href: `/admin/properties/${r.id}`,
        })),
        href: '/admin/properties?status=pending_review&submitted=1',
      };
    }),
    load('bookings', 'admin.records.read', async (tx) => {
      const filter = tx`${orderEnvironmentSql(tx)}=${scope.environment} AND o.created_at>=${scope.startInclusive}::timestamptz AND o.created_at<${scope.endExclusive}::timestamptz`;
      const rows =
        await tx`SELECT (o.created_at AT TIME ZONE 'Asia/Kolkata')::date::text date,count(*)::int bookings,
        sum(${bookedRentSql(tx)})::text rent_minor FROM booking_order o WHERE ${filter} GROUP BY 1 ORDER BY 1`;
      const distributions =
        await tx`SELECT o.state::text state,count(*)::int count FROM booking_order o WHERE ${filter} GROUP BY 1 ORDER BY 1`;
      const dailySeries = scope.days.map((date) => {
        const row = rows.find((r) => r.date === date);
        return { date, bookings: row?.bookings ?? 0, rentMinor: row?.rent_minor ?? '0' };
      });
      const bookingFilters = {
        createdFrom: scope.from,
        createdTo: scope.to,
        environment: scope.environment,
      };
      const visitsFilter = tx`${todayVisitSql(tx, scope.today)} AND ${orderEnvironmentSql(tx)}=${scope.environment}`;
      const [visits] = await tx`SELECT count(*)::int total,
        count(*) FILTER (WHERE v.hours_known AND (v.starts_at AT TIME ZONE 'Asia/Kolkata')::date=${scope.today}::date)::int arrivals,
        count(*) FILTER (WHERE v.hours_known AND (v.ends_at AT TIME ZONE 'Asia/Kolkata')::date=${scope.today}::date)::int departures,
        count(*) FILTER (WHERE v.slot='hourly')::int hourly,
        count(*) FILTER (WHERE NOT v.hours_known)::int hours_unknown FROM booking v JOIN booking_order o ON o.id=v.order_id WHERE ${visitsFilter}`;
      const todayRows =
        await tx`SELECT v.id,v.reference,o.id order_id,o.reference order_reference,o.listing_snapshot->>'title' title,v.state::text state,v.starts_at,v.ends_at,v.hours_known
        FROM booking v JOIN booking_order o ON o.id=v.order_id WHERE ${visitsFilter} ORDER BY v.starts_at,v.id LIMIT 8`;
      const [cases] = await tx`SELECT count(*)::int total FROM booking_case WHERE state='open'`;
      const caseRows =
        await tx`SELECT id,reference,type FROM booking_case WHERE state='open' ORDER BY created_at,id LIMIT 8`;
      return {
        metrics: [
          metric(
            'bookings',
            'Bookings created',
            dailySeries.reduce((n, r) => n + r.bookings, 0),
            'count',
            'Order creation date; all states, once per order',
            '/admin/bookings',
            bookingFilters,
            scope,
          ),
          metric(
            'rent',
            'Booked rent',
            dailySeries.reduce((n, r) => n + BigInt(r.rentMinor), 0n),
            'minor',
            'Order creation date; non-cancelled visit rent, excluding fees/deposits/unpaid holds',
            '/admin/bookings',
            { ...bookingFilters, rentOnly: '1' },
            scope,
          ),
          metric(
            'visits',
            "Today's visits",
            visits.total,
            'count',
            "Today's IST arrivals/departures; each visit once",
            '/admin/bookings',
            { tab: 'today', unit: 'visits', environment: scope.environment },
            scope,
          ),
          metric(
            'cases',
            'Open booking cases',
            cases.total,
            'count',
            'Waiting now',
            '/admin/booking-cases',
            { state: 'open' },
            scope,
          ),
        ],
        dailySeries,
        distributions,
        visits,
        todayVisits: todayRows.map((r) => ({
          ...r,
          href: `/admin/bookings/${r.order_id}?tab=visits`,
        })),
        attention: caseRows.map((r) => ({
          label: r.reference,
          state: r.type,
          href: `/admin/booking-cases/${r.id}`,
        })),
        href: href('/admin/bookings', bookingFilters),
        todayHref: href('/admin/bookings', {
          tab: 'today',
          unit: 'visits',
          environment: scope.environment,
        }),
      };
    }),
    load('finance', 'admin.payments.read', async (tx) => {
      const [captures] =
        await tx`SELECT count(*)::int evidence,coalesce(sum(t.captured_minor),0)::text amount FROM payment_transaction t
        WHERE t.environment=${scope.environment} AND t.kind='capture' AND t.outcome='succeeded' AND t.verified_at>=${scope.startInclusive}::timestamptz AND t.verified_at<${scope.endExclusive}::timestamptz`;
      const [refunds] =
        await tx`SELECT coalesce(sum(actual_minor) FILTER (WHERE state='succeeded' AND verified_at>=${scope.startInclusive}::timestamptz AND verified_at<${scope.endExclusive}::timestamptz),0)::text succeeded,
        coalesce(sum(expected_minor) FILTER (WHERE state IN ('requested','processing','unknown')),0)::text pending,
        count(*) FILTER (WHERE state IN ('unknown','failed'))::int exceptions FROM refund WHERE environment=${scope.environment}`;
      const [payments] =
        await tx`WITH l AS (${paymentLedger(tx)}) SELECT count(*)::int exceptions FROM l WHERE l.environment=${scope.environment} AND ${paymentAttentionSql(tx)}`;
      return {
        metrics: [
          {
            ...metric(
              'captured',
              'Captured payments',
              captures.amount,
              'minor',
              'Provider capture evidence verified in selected IST period',
              '/admin/finance/payments',
              { environment: scope.environment, basis: 'capture', from: scope.from, to: scope.to },
              scope,
            ),
            availability: captures.evidence ? 'available' : 'unavailable',
          },
          metric(
            'refunded',
            'Successful refunds',
            refunds.succeeded,
            'minor',
            'Successful refund evidence verified in selected IST period',
            '/admin/finance/refunds',
            {
              environment: scope.environment,
              dashboard: 'success',
              from: scope.from,
              to: scope.to,
            },
            scope,
          ),
          metric(
            'refundPending',
            'Refunds pending',
            refunds.pending,
            'minor',
            'Waiting now',
            '/admin/finance/refunds',
            { environment: scope.environment, dashboard: 'pending' },
            scope,
          ),
        ],
        exceptions: payments.exceptions + refunds.exceptions,
        attention: [
          ...(payments.exceptions
            ? [
                {
                  label: `${payments.exceptions} payment exceptions`,
                  state: 'Needs review',
                  urgent: true,
                  href: href('/admin/finance/payments', {
                    environment: scope.environment,
                    attention: 'needs_review',
                  }),
                },
              ]
            : []),
          ...(refunds.exceptions
            ? [
                {
                  label: `${refunds.exceptions} refund exceptions`,
                  state: 'Outcome uncertain / failed',
                  urgent: true,
                  href: href('/admin/finance/refunds', {
                    environment: scope.environment,
                    dashboard: 'exceptions',
                  }),
                },
              ]
            : []),
        ],
        href: href('/admin/finance/payments', { environment: scope.environment }),
      };
    }),
    load('support', 'admin.support.read', async (tx) => {
      const [counts] =
        await tx`SELECT count(*)::int open,count(*) FILTER (WHERE priority='urgent')::int urgent FROM support_request WHERE state<>'resolved'`;
      const rows =
        await tx`SELECT id,subject,priority,state FROM support_request WHERE state<>'resolved' ORDER BY priority='urgent' DESC,created_at,id LIMIT 8`;
      return {
        counts,
        metrics: [
          metric(
            'support',
            'Open support requests',
            counts.open,
            'count',
            'Waiting now',
            '/admin/support',
            { state: 'unresolved' },
            scope,
          ),
        ],
        attention: rows.map((r) => ({
          label: r.subject,
          state: r.state,
          urgent: r.priority === 'urgent',
          href: `/admin/support/${r.id}`,
        })),
        href: '/admin/support?state=unresolved',
      };
    }),
    load('health', 'admin.operations.read', async (tx) => {
      const rows =
        await tx`SELECT service,healthy,checked_at,checked_at<${scope.generatedAt}::timestamptz-interval '2 minutes' stale FROM service_health ORDER BY service`;
      const incidents =
        await tx`SELECT code,status FROM operational_incident WHERE status<>'resolved' ORDER BY updated_at LIMIT 8`;
      return {
        services: rows,
        attention: incidents.map((r) => ({
          label: r.code,
          state: r.status,
          urgent: true,
          href: `/admin/operations/incidents/${r.code}`,
        })),
        href: '/admin/operations',
      };
    }),
  ]);
  return {
    scope,
    modules: Object.fromEntries(
      ['applications', 'properties', 'bookings', 'finance', 'support', 'health']
        .filter((key) => modules[key])
        .map((key) => [key, modules[key]]),
    ),
  };
}
