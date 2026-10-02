import { readOwnerPrivacy, requestOwnerPrivacy } from '@/services/customer/owner-privacy.js';
import { privacyDownload } from '@/services/customer/privacy-fulfillment.js';
import {
  ownerSecurityPage,
  signOutOtherOwnerSessions,
  requestOwnerContactChange,
  confirmOwnerContactChange,
} from '@/services/auth/owner-security.js';
import {
  encryptSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@/services/auth/session-crypto.js';
import {
  readOwnerNotificationPreferences,
  saveOwnerNotificationPreferences,
} from '@/services/notifications/owner-preferences.js';
import { sql } from '@/config/database.js';
import { requestPayoutStepUp, confirmPayoutStepUp } from '@/services/auth/payout-step-up.js';
import { saveAccountSettings } from '@/services/auth/settings.js';
import {
  changePayoutDestination,
  payoutDestinationPage,
  submitPayoutDraft,
} from '@/services/payouts/destination-actions.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Reachable by any signed-in Client, approved or not — deliberately.
 *
 * A Client sent back for a payout-name mismatch has to be able to fix exactly
 * that, and by definition they are not active yet. Gating this behind approval
 * would make the one problem it exists to solve unfixable.
 */
export const account = runAction(saveAccountSettings);
/** CP21: versioned payout destinations (preview → submit; a stale sign-in saves a draft). */
export const payoutPage = asyncHandler(async (_req, res) => ok(res, await payoutDestinationPage()));
export const payout = runAction(changePayoutDestination);
export const payoutDraft = runAction(submitPayoutDraft);

export const payoutStepUp = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const actor = { kind: 'owner', id: req.user.id, sessionId: req.session?.sessionId };
  ok(res, await requestPayoutStepUp(sql, actor));
});
export const confirmPayoutIdentity = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const actor = { kind: 'owner', id: req.user.id, sessionId: req.session?.sessionId };
  ok(res, await confirmPayoutStepUp(sql, actor, req.body));
});

export const notifications = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await readOwnerNotificationPreferences(sql, req.user.id));
});
export const saveNotifications = asyncHandler(async (req, res) =>
  ok(res, await saveOwnerNotificationPreferences(sql, req.user.id, req.body)),
);

const ownerActor = (req) => ({ id: req.user.id, sessionId: req.session?.sessionId });
export const security = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await ownerSecurityPage(sql, ownerActor(req)));
});
export const signOutOthers = asyncHandler(async (req, res) =>
  ok(res, await signOutOtherOwnerSessions(sql, ownerActor(req))),
);
export const requestContactChange = asyncHandler(async (req, res) =>
  ok(res, await requestOwnerContactChange(sql, ownerActor(req), req.body)),
);
export const confirmContactChange = asyncHandler(async (req, res) => {
  const result = await confirmOwnerContactChange(sql, ownerActor(req), req.body);
  if (result.sessionId) {
    const token = await encryptSession({
      userId: req.user.id,
      role: 'client',
      accountStatus: result.accountStatus,
      sessionId: result.sessionId,
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  }
  const { sessionId: _sessionId, accountStatus: _accountStatus, ...visible } = result;
  ok(res, visible);
});

export const privacy = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  ok(res, await readOwnerPrivacy(sql, ownerActor(req)));
});
export const requestPrivacy = asyncHandler(async (req, res) =>
  ok(res, await requestOwnerPrivacy(sql, ownerActor(req), req.body)),
);
export const privacyArtifact = asyncHandler(async (req, res) => {
  const receipt = req.params.artifact === 'receipt';
  const bytes = await privacyDownload(
    sql,
    { kind: 'owner', ...ownerActor(req) },
    req.params.id,
    receipt,
  );
  res
    .set('Cache-Control', 'private, no-store')
    .set('Referrer-Policy', 'no-referrer')
    .attachment(`rentra-owner-${receipt ? 'receipt' : 'data'}.json`)
    .type('application/json')
    .send(bytes);
});
