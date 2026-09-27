import { portalCacheScope } from '@/services/auth/cache-scope.js';
import {
  requestClientOtp,
  verifyClientOtp,
  requestPhoneVerification,
  confirmPhoneVerification,
  logout,
  recordLockedCtaClick,
} from '@/services/auth/actions.js';
import { profileCompletion } from '@/services/auth/profile.js';
import { getOrCreateApplication } from '@/services/auth/application.js';
import { listDocuments } from '@/services/auth/documents.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** Client (property owner) authentication. Email is the credential. */
export const requestOtp = runAction(requestClientOtp);
export const verifyOtp = runAction(verifyClientOtp);
export const requestPhoneOtp = runAction(requestPhoneVerification);
export const confirmPhoneOtp = runAction(confirmPhoneVerification);
export const signOut = runAction(logout, { style: 'none' });

/**
 * Who am I.
 *
 * The frontend used to get this from a Server Component reading the DAL. It
 * returns the same fields plus the onboarding completion state, because every
 * partner screen needs both and two round trips for one header is wasteful.
 */
export const me = asyncHandler(async (req, res) => {
  const actor = req.user ?? null;
  // Public cache generation, never an authentication credential. Includes live
  // capabilities so a reused layout cannot retain data across access changes.
  const user = actor ? { ...actor, cacheScope: portalCacheScope(actor, req.session) } : null;
  if (!user) return ok(res, { user: null, sessionState: req.session ? 'ended' : 'signed_out' });

  if (user.role !== 'client') return ok(res, { user, completion: null });

  const application = await getOrCreateApplication(user.id);
  // The application was just resolved; do not query its ID a second time.
  const documents = await listDocuments({
    ownerType: 'client_application',
    ownerId: application.id,
  });

  return ok(res, { user, completion: profileCompletion(user, application, documents) });
});

/** Funnel counter for a locked call to action; aggregate only, no identifiers. */
export const lockedCta = asyncHandler(async (req, res) =>
  ok(res, await recordLockedCtaClick(Number(req.body?.count ?? 1))),
);

/** Same live DAL checks as /me, without onboarding/document reads. */
export const identity = asyncHandler(async (req, res) => {
  const actor = req.user ?? null;
  return ok(res, {
    user: actor
      ? {
          role: actor.role,
          accountStatus: actor.accountStatus,
          cacheScope: portalCacheScope(actor, req.session),
        }
      : null,
  });
});
