import { sql } from '@/config/database.js';
import { savePaymentGatewaySettings } from '@/services/payments/gateway-actions.js';
import { getPaymentConfiguration } from '@/services/payments/gateway-settings.js';
import { REGISTERED_PAYMENT_PROVIDERS } from '@/services/payments/provider-registry.js';
import { paymentCredentialStatus } from '@/services/payments/provider-credentials.js';
import { runAction } from '@/utils/runAction.js';
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

  return ok(res, { configuration: await getPaymentConfiguration(sql), providers });
});

export const saveConfiguration = runAction(savePaymentGatewaySettings);
