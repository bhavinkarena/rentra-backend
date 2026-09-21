import { sql } from '@/config/database.js';
import {
  updateCustomerProfile,
  submitPrivacyRequest,
  requestPhoneChange,
  confirmPhoneChange,
} from '@/services/customer/actions.js';
import { readCustomerAccount } from '@/services/customer/account.js';
import { customerPageAccount } from '@/services/customer/page.js';
import { getSession } from '@/services/auth/dal.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/** The customer's own account record. */
export const read = asyncHandler(async (_req, res) =>
  ok(res, await readCustomerAccount(sql, await getSession())),
);

/**
 * The onboarding-aware variant. It tolerates an account that has not finished
 * setup, which the plain read does not, and the frontend uses it on first
 * sign-in.
 */
export const onboarding = asyncHandler(async (_req, res) =>
  ok(res, await customerPageAccount({ onboarding: true })),
);

export const updateProfile = runAction(updateCustomerProfile);

/**
 * A phone change is two steps by design: the new number has to prove it can
 * receive a code before it replaces the old one. Doing it in one call would
 * let a typo lock the account out permanently.
 */
export const startPhoneChange = runAction(requestPhoneChange);
export const finishPhoneChange = runAction(confirmPhoneChange);

/** DPDP data requests — export or erasure. Queued for an admin, never instant. */
export const privacyRequest = runAction(submitPrivacyRequest);
