import { readCalendarFeed } from '../services/booking/owner-experience.js';
import { sql } from '../config/database.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Router } from 'express';
import healthRoutes from './health.route.js';
import authRoutes from './auth.route.js';
import adminAuthRoutes from './adminAuth.route.js';
import customerAuthRoutes from './customerAuth.route.js';
import partnerRoutes from './partner.route.js';
import discoveryRoutes from './discovery.route.js';
import bookingRoutes from './booking.route.js';
import customerRoutes from './customer.route.js';
import savedRoutes from './saved.route.js';
import adminRoutes from './admin.route.js';
import staffRoutes from './staff.route.js';

/**
 * The versioned API surface.
 *
 * Webhooks and the measurement beacon are deliberately NOT mounted here: both
 * need the raw body and therefore have to sit in front of the JSON parser, so
 * app.js mounts them directly. Everything else hangs off this one router under
 * API_PREFIX.
 */
const router = Router();

router.get(
  '/ical/:token.ics',
  asyncHandler(async (req, res) => {
    const data = await readCalendarFeed(sql, req.params.token);
    res.set('Cache-Control', 'private, no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!data) return res.status(404).end();
    return res.type('text/calendar').send(data);
  }),
);
router.use('/health', healthRoutes);

router.use('/auth', authRoutes);
router.use('/admin/auth', adminAuthRoutes);
router.use('/customer/auth', customerAuthRoutes);

router.use('/discovery', discoveryRoutes);
router.use('/bookings', bookingRoutes);
router.use('/saved', savedRoutes);

router.use('/partner', partnerRoutes);
router.use('/customer', customerRoutes);
router.use('/admin', adminRoutes);
router.use('/staff', staffRoutes);

export default router;
