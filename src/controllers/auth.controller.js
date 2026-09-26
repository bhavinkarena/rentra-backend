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
  const user = req.user ?? null;
  if (!user) return ok(res, { user: null, sessionState: req.session ? 'ended' : 'signed_out' });

  if (user.role !== 'client') return ok(res, { user, completion: null });

  const application = await getOrCreateApplication(user.id);
  const documents = await listDocuments({ ownerType: 'user', ownerId: user.id });

  return ok(res, { user, completion: profileCompletion(user, application, documents) });
});

/** Funnel counter for a locked call to action; aggregate only, no identifiers. */
export const lockedCta = asyncHandler(async (req, res) =>
  ok(res, await recordLockedCtaClick(Number(req.body?.count ?? 1))),
);
