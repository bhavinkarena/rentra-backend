import {
  beginCustomerLogin,
  requestCustomerOtp,
  verifyCustomerOtp,
  switchToCustomer,
  restoreCustomerSelection,
} from '@/services/auth/customer-actions.js';
import { logoutCustomer } from '@/services/customer/actions.js';
import { runAction } from '@/utils/runAction.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Customer authentication — phone and OTP.
 *
 * `begin` records what the guest was trying to book before they were asked to
 * sign in, in a short-lived signed cookie, so the booking selection survives
 * the login round trip. It is a normal part of the flow, not an optimisation:
 * losing it drops the guest back on a listing page with their dates gone.
 */
export const begin = runAction(beginCustomerLogin, { style: 'input' });
export const requestOtp = runAction(requestCustomerOtp);
export const verifyOtp = runAction(verifyCustomerOtp);
export const switchRole = runAction(switchToCustomer, { style: 'none' });
export const signOut = runAction(logoutCustomer, { style: 'none' });

export const restoreSelection = asyncHandler(async (req, res) =>
  ok(res, await restoreCustomerSelection(req.params.rentableId)),
);
