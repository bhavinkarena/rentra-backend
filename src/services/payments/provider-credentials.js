import 'server-only';
import { PaymentConfigurationError, registeredPaymentProvider } from './provider-registry.js';

/** One credential namespace per deployment; development supplies sandbox values. */
function razorpayCredentials(environment) {
  return {
    keyId: environment.RAZORPAY_KEY_ID?.trim() ?? '',
    keySecret: environment.RAZORPAY_KEY_SECRET?.trim() ?? '',
    webhookSecret: environment.RAZORPAY_WEBHOOK_SECRET?.trim() ?? '',
  };
}

// Future adapters must add a reviewed credential loader and registry entry.
const credentialLoaders = Object.freeze({ razorpay: razorpayCredentials });

export function paymentCredentialStatus(provider, environment, variables = process.env) {
  registeredPaymentProvider(provider, environment);
  const credentials = credentialLoaders[provider](variables);
  if (!/^rzp_test_[A-Za-z0-9]+$/.test(credentials.keyId)) {
    return { ready: false, reason: 'A valid RAZORPAY_KEY_ID starting with rzp_test_ is required.' };
  }
  if (!credentials.keySecret || !credentials.webhookSecret) {
    return { ready: false, reason: 'RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required.' };
  }
  return { ready: true, reason: null };
}

/** Server-side adapter boundary for Part 11. Never return this to a page/action. */
export function requirePaymentCredentials(provider, environment, variables = process.env) {
  const status = paymentCredentialStatus(provider, environment, variables);
  if (!status.ready) throw new PaymentConfigurationError('GATEWAY_CREDENTIALS_MISSING', status.reason);
  return credentialLoaders[provider](variables);
}
