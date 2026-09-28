import { sql } from '@/config/database.js';
import { savePaymentGatewaySettings } from '@/services/payments/gateway-actions.js';
import { getPaymentConfiguration } from '@/services/payments/gateway-settings.js';
import { REGISTERED_PAYMENT_PROVIDERS } from '@/services/payments/provider-registry.js';
import { paymentCredentialStatus } from '@/services/payments/provider-credentials.js';
import { runAction } from '@/utils/runAction.js';
import {
  adminPaymentDetail,
  adminPaymentList,
  reconcileAdminPayment,
} from '@/services/payments/investigation-actions.js';
import {
  adminRefundDetail,
  adminRefundList,
  adminRefundableVisits,
  previewAdminRefund,
  reconcileAdminRefund,
  requestAdminRefund,
} from '@/services/payments/refund-actions.js';
import { notFound } from '@/utils/apiError.js';
import { asyncHandler } from '@/utils/asyncHandler.js';
import { ok } from '@/utils/respond.js';

/**
 * Gateway configuration is admin-only to read as well as write.
 *
 * It carries the provider, environment and collection purpose — enough for
 * someone probing the API to learn whether live money is switched on, which is
 * not a question an anonymous caller gets to ask.
 */
export const configuration = asyncHandler(async (_req, res) => {
  /**
   * The provider list ships with the configuration because whether a
   * gateway's credentials are present is read from this process's own
   * environment — the frontend has no way to answer it, and should not be
   * given the keys in order to try.
   *
   * Only the readiness verdict and its reason cross the wire. No key, no
   * secret, and no fragment of either.
   */
  const providers = REGISTERED_PAYMENT_PROVIDERS.map(({ id, label }) => ({
    id,
    label,
    ...paymentCredentialStatus(id, 'test'),
  }));

  const history =
    await sql`SELECT g.version,g.provider,g.environment,g.enabled,g.collection_purpose,
    g.created_at,a.name changed_by_name FROM payment_gateway_config g
    JOIN admin_user a ON a.id=g.changed_by ORDER BY g.version DESC LIMIT 20`;
  return ok(res, { configuration: await getPaymentConfiguration(sql), providers, history });
});

export const saveConfiguration = runAction(savePaymentGatewaySettings);

/** CP19: payment investigation, separate from gateway settings. */
export const orders = asyncHandler(async (req, res) => ok(res, await adminPaymentList(req.query)));
export const order = asyncHandler(async (req, res) => {
  const found = await adminPaymentDetail(req.params.id);
  if (!found) throw notFound('PAYMENT_NOT_FOUND', 'Not found.');
  return ok(res, found);
});
export const reconcile = runAction(reconcileAdminPayment);

/** CP20: refund operations queue, detail and guarded commands. */
export const refunds = asyncHandler(async (req, res) => ok(res, await adminRefundList(req.query)));
export const refundDetail = asyncHandler(async (req, res) => {
  const found = await adminRefundDetail(req.params.id);
  if (!found) throw notFound('REFUND_NOT_FOUND', 'Not found.');
  return ok(res, found);
});
export const refundableVisits = asyncHandler(async (req, res) => {
  const found = await adminRefundableVisits(req.params.id);
  if (!found) throw notFound('ORDER_NOT_FOUND', 'Not found.');
  return ok(res, found);
});
export const refundPreview = runAction(previewAdminRefund);
export const refundRequest = runAction(requestAdminRefund);
export const refundReconcile = runAction(reconcileAdminRefund);
