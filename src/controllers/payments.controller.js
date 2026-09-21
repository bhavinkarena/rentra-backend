import { sql } from '@/config/database.js';
import { savePaymentGatewaySettings } from '@/services/payments/gateway-actions.js';
import { getPaymentConfiguration } from '@/services/payments/gateway-settings.js';
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
export const configuration = asyncHandler(async (_req, res) =>
  ok(res, await getPaymentConfiguration(sql)),
);

export const saveConfiguration = runAction(savePaymentGatewaySettings);
