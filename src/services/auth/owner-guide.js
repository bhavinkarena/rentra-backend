import { z } from 'zod';
import { forbidden, unprocessable } from '../../utils/apiError.js';
import { getBookingAvailability } from '../booking/quotes.js';
import { getHourlyAvailability } from '../booking/time-slots.js';
import { addLocalDays, propertyToday } from '../domain/booking-dates.js';

export const guideInput = z.object({
  approvalSeenAt: z.literal(true).optional(),
  welcomeSeenAt: z.literal(true).optional(),
  tourStartedAt: z.literal(true).optional(),
  tourResumedAt: z.literal(true).optional(),
  tourCompletedAt: z.literal(true).optional(),
  tourSkippedAt: z.literal(true).optional(),
  checklistDismissedAt: z.boolean().optional(),
  intendedVertical: z.enum(['farmhouse', 'entertainment']).optional(),
}).strict();

export async function readGuide(database, ownerId) {
  const [owner] = await database`SELECT owner_guide FROM "user" WHERE id=${ownerId} AND role='client' AND account_status IN ('active','pending_application')`;
  if (!owner) throw forbidden('ACCOUNT_RESTRICTED', 'This owner account is restricted.');
  return owner.owner_guide;
}

export async function saveGuide(database, ownerId, input) {
  const parsed = guideInput.safeParse(input);
  if (!parsed.success) throw unprocessable(parsed.error.flatten().fieldErrors);
  const patch = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) =>
    [key, key === 'intendedVertical' ? value : value ? new Date().toISOString() : null]));
  if (patch.tourStartedAt) Object.assign(patch, { tourCompletedAt: null, tourSkippedAt: null, tourResumedAt: null });
  if (patch.checklistDismissedAt && !(await setupGuide(database, ownerId)).canDismiss)
    throw forbidden('SETUP_INCOMPLETE', 'Finish the required setup items before dismissing this guide.');
  const [row] = await database`UPDATE "user" SET owner_guide=owner_guide || ${JSON.stringify(patch)}::jsonb
    WHERE id=${ownerId} AND role='client' AND account_status IN ('active','pending_application') RETURNING owner_guide`;
  if (!row) throw forbidden('ACCOUNT_RESTRICTED', 'This owner account is restricted.');
  return row.owner_guide;
}

/** Reuse the guest inventory readers: hours, prices, closures and holds all count. */
async function hasBookableDate(database, properties) {
  const today = propertyToday();
  // ponytail: scan until the first bookable property; cache this read if large portfolios make it slow.
  for (const property of properties) {
    if (property.status !== 'live' || property.booking_config?.inventoryReady !== true) continue;
    const horizon = Math.min(366, property.booking_config.bookingHorizonDays ?? 60);
    try {
      if (property.rental_unit === 'hour') {
        const result = await getHourlyAvailability(database, {
          rentableId: property.id, from: today, days: horizon + 1, activity: property.activity,
          durationMinutes: property.booking_config.minDurationMinutes,
        });
        if (Object.values(result.days).some(day => day.freeStarts > 0)) return property;
      } else {
        for (let offset = 0; offset <= horizon; offset += 120) {
          const result = await getBookingAvailability(database, {
            rentableId: property.id, from: addLocalDays(today, offset),
            to: addLocalDays(today, Math.min(horizon, offset + 119)),
          });
          if (Object.values(result.days).some(day => day.day || day.night || day.full)) return property;
        }
      }
    } catch (error) {
      if (!['SCHEDULE_UNAVAILABLE','INVENTORY_NOT_READY','LISTING_UNAVAILABLE','ACTIVITY_UNAVAILABLE','PRICE_MISSING'].includes(error.code)) throw error;
    }
  }
  return null;
}

export async function setupGuide(database, ownerId) {
  const guide = await readGuide(database, ownerId);
  const [properties, [facts], visits] = await Promise.all([
    database`SELECT r.id,r.status,r.booking_config,r.rental_unit::text,c.slug AS activity FROM rentable r
      JOIN category c ON c.id=r.category_id WHERE r.client_id=${ownerId} ORDER BY r.created_at`,
    database`SELECT account_status,
      EXISTS (SELECT 1 FROM client_staff WHERE client_id=${ownerId} AND is_active AND accepted_at IS NOT NULL AND revoked_at IS NULL) AS caretaker,
      EXISTS (SELECT 1 FROM client_payout_current WHERE client_id=${ownerId}) AS payout
      FROM "user" WHERE id=${ownerId}`,
    database`SELECT v.rentable_id,v.scheduled_at FROM verification_visit v JOIN rentable r ON r.id=v.rentable_id
      JOIN listing_submission s ON s.id=v.submission_id
      WHERE r.client_id=${ownerId} AND r.status='pending_verification' AND v.cancelled_at IS NULL
        AND v.scheduled_at IS NOT NULL AND s.content_version=r.content_version ORDER BY v.scheduled_at LIMIT 1`,
  ]);
  const bookable = facts.account_status === 'active' ? await hasBookableDate(database, properties) : null;
  const first = properties[0];
  const submitted = properties.find(p => p.status !== 'draft');
  const verified = properties.find(p => p.status === 'live');
  const propertyHref = first ? `/partner/listings/${first.id}/setup` : '/partner/listings/new';
  const steps = [
    { id: 'verify', title: 'Verify your account', why: 'Rentra checks who owns or manages each property.', done: facts.account_status === 'active', href: '/partner/onboarding/details', action: 'Get verified' },
    { id: 'property', title: 'Add your first property', why: 'Tell guests what makes your place worth a visit.', done: Boolean(first), href: '/partner/listings/new', action: 'Add property' },
    { id: 'submit', title: 'Submit it for review', why: 'Every property is reviewed before guests can book.', done: Boolean(submitted), href: propertyHref, action: 'Continue setup' },
    { id: 'visit', title: 'Verification call or visit', why: 'Rentra checks the property with you.', done: Boolean(verified || visits.length), scheduledAt: visits[0]?.scheduled_at ?? null, href: first ? `/partner/listings/${verified?.id ?? visits[0]?.rentable_id ?? first.id}/overview` : '/partner/listings/new', action: 'View schedule' },
    { id: 'calendar', title: 'Open your calendar', why: 'Set hours, prices and dates guests can actually book.', done: Boolean(bookable), href: first ? `/partner/listings/${first.id}/calendar` : '/partner/listings/new', action: first ? 'Open calendar' : 'Add property' },
    { id: 'caretaker', title: 'Add a caretaker', why: 'Give someone access to manage visits on site.', optional: true, done: facts.caretaker, href: '/partner/team', action: 'Invite caretaker' },
    { id: 'payout', title: 'Add payout method', why: 'Save where earnings should go once payouts are available.', done: facts.payout, href: '/partner/earnings/payout', action: 'Add payout method' },
  ];
  return { steps, done: steps.filter(s => s.done).length, total: steps.length,
    canDismiss: steps.filter(s => !s.optional).every(s => s.done), dismissed: Boolean(guide.checklistDismissedAt) };
}
