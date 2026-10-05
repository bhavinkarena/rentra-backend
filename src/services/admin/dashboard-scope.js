import { z } from 'zod';
import { addLocalDays, propertyToday, isLocalDate } from '../domain/booking-dates.js';

export const dashboardQuery = z.object({
  period: z.enum(['today', '7d', '30d', '90d']).default('30d'),
  environment: z.enum(['live', 'test', 'simulated']).default('live'),
});
export const dashboardDate = z.string().refine(isLocalDate, 'Choose a valid India date');

export function dashboardScope(input = {}, now = new Date()) {
  const filters = dashboardQuery.parse(input);
  const days = filters.period === 'today' ? 1 : Number(filters.period.slice(0, -1));
  const today = propertyToday(now);
  const from = addLocalDays(today, 1 - days);
  const to = today;
  return {
    ...filters,
    timeZone: 'Asia/Kolkata',
    from,
    to,
    today,
    startInclusive: new Date(`${from}T00:00:00+05:30`).toISOString(),
    endExclusive: new Date(`${addLocalDays(to, 1)}T00:00:00+05:30`).toISOString(),
    generatedAt: new Date(now).toISOString(),
    days: Array.from({ length: days }, (_, i) => addLocalDays(from, i)),
  };
}

// Orders without explicit provenance remain unknown, never silently Live.
export const orderEnvironmentSql = (tx) => tx`CASE WHEN o.payment_mode='simulated' THEN 'simulated'
  WHEN o.visit_provenance='test' THEN 'test' WHEN o.visit_provenance='real' THEN 'live' ELSE 'legacy_unknown' END`;
export const bookedRentSql = (
  tx,
) => tx`CASE WHEN o.state IN ('draft','held','expired','cancelled') THEN 0 ELSE
  coalesce((SELECT sum(v.amount_rent_minor) FROM booking v WHERE v.order_id=o.id AND v.state NOT IN ('requested','cancelled')),0) END`;
export const todayVisitSql = (
  tx,
  today,
) => tx`o.state NOT IN ('draft','held','expired','cancelled') AND v.state NOT IN ('requested','cancelled') AND
  ((v.hours_known AND ((v.starts_at AT TIME ZONE 'Asia/Kolkata')::date=${today}::date
    OR (v.ends_at AT TIME ZONE 'Asia/Kolkata')::date=${today}::date)) OR (NOT v.hours_known AND v.local_day=${today}::date))`;
