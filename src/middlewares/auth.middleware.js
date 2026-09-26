import { getCurrentUser, getSession } from '@/services/auth/dal.js';
import { getCurrentAdmin } from '@/services/auth/admin.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { unauthorized, forbidden } from '@/utils/apiError.js';
import { routeCapability } from '@/services/auth/capabilities.js';

/** Mounted before all portal controllers, including private file/download routes. */
export const requirePortalCapability = (kind) =>
  asyncHandler(async (req, _res, next) => {
    const actor = kind === 'admin' ? await getCurrentAdmin() : await getCurrentUser();
    if (!actor)
      throw unauthorized(
        kind === 'admin' ? 'ADMIN_REQUIRED' : 'CLIENT_REQUIRED',
        'Your session has expired or was revoked. Sign in again.',
      );
    const capability = routeCapability(kind, req.method, req.path);
    if (!capability || !actor.capabilities?.includes(capability)) {
      throw forbidden(
        'CAPABILITY_REQUIRED',
        'Your account does not have permission for this action.',
      );
    }
    next();
  });

/**
 * Authorisation for HTTP.
 *
 * The service layer's own `requireClient()` / `requireAdmin()` guards are kept
 * and still run inside every action — they are the authoritative check and
 * they read the live user row, so an account suspended mid-session is caught
 * there. What they cannot do is answer an API correctly: they were written for
 * page navigation and respond by redirecting to a login screen.
 *
 * So these middlewares run the same `getCurrentUser` lookup first and turn a
 * missing or wrong-role actor into a 401/403. Defence in depth, not a
 * replacement: removing a guard from a service function would still be a bug.
 */

/** Attaches the actor when there is one. Never rejects. */
export const attachUser = asyncHandler(async (req, _res, next) => {
  req.session = await getSession();
  req.user = await getCurrentUser();
  next();
});

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  if (['blocked', 'suspended'].includes(user.accountStatus)) {
    throw forbidden('ACCOUNT_BLOCKED', 'This account is not available.');
  }
  req.user = user;
  req.session = await getSession();
  next();
});

/** `role` is 'client' or 'customer'. */
export const requireRole = (role) =>
  asyncHandler(async (req, _res, next) => {
    const user = await getCurrentUser();
    if (!user) throw unauthorized(role === 'client' ? 'CLIENT_REQUIRED' : 'CUSTOMER_REQUIRED');
    if (user.role !== role) throw forbidden('WRONG_ROLE', 'This account cannot do that.');
    if (['blocked', 'suspended'].includes(user.accountStatus)) {
      throw forbidden('ACCOUNT_BLOCKED', 'This account is not available.');
    }
    req.user = user;
    req.session = await getSession();
    next();
  });

/**
 * Gate 1: a Client approved to publish. The onboarding surface deliberately
 * uses `requireRole('client')` instead — a Client who is logged in but not yet
 * approved is still inside the product, working the stepper.
 */
export const requireActiveClient = asyncHandler(async (req, _res, next) => {
  const user = await getCurrentUser();
  if (!user || user.role !== 'client') throw unauthorized('CLIENT_REQUIRED');
  if (user.accountStatus !== 'active') {
    throw forbidden('CLIENT_NOT_APPROVED', 'Your account is still under review.');
  }
  req.user = user;
  next();
});

/** Super Admin — a separate cookie and audience, never the client session. */
export const requireAdmin = asyncHandler(async (req, _res, next) => {
  const admin = await getCurrentAdmin();
  if (!admin) throw unauthorized('ADMIN_REQUIRED', 'Admin sign-in required.');
  req.admin = admin;
  next();
});
