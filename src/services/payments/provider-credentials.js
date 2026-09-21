import 'server-only';
import { PaymentConfigurationError, registeredPaymentProvider } from './provider-registry.js';

/** Only these explicit TEST names are read. Generic/live credentials never fall back. */
function razorpayTestCredentials(environment) {
  return {
    keyId: environment.RAZORPAY_TEST_KEY_ID?.trim() ?? '',
    keySecret: environment.RAZORPAY_TEST_KEY_SECRET?.trim() ?? '',
    webhookSecret: environment.RAZORPAY_TEST_WEBHOOK_SECRET?.trim() ?? '',
  };
}

// Future adapters must add a reviewed credential loader and registry entry.
const credentialLoaders = Object.freeze({ razorpay: razorpayTestCredentials });

export function paymentCredentialStatus(provider, environment, variables = process.env) {
  registeredPaymentProvider(provider, environment);
  const credentials = credentialLoaders[provider](variables);
  if (!/^rzp_test_[A-Za-z0-9]+$/.test(credentials.keyId)) {
    return { ready: false, reason: 'A valid RAZORPAY_TEST_KEY_ID starting with rzp_test_ is required.' };
  }
  if (!credentials.keySecret || !credentials.webhookSecret) {
    return { ready: false, reason: 'RAZORPAY_TEST_KEY_SECRET and RAZORPAY_TEST_WEBHOOK_SECRET are required.' };
  }
  return { ready: true, reason: null };
}

/** Server-side adapter boundary for Part 11. Never return this to a page/action. */
export function requirePaymentCredentials(provider, environment, variables = process.env) {
  const status = paymentCredentialStatus(provider, environment, variables);
  if (!status.ready) throw new PaymentConfigurationError('GATEWAY_CREDENTIALS_MISSING', status.reason);
  return credentialLoaders[provider](variables);
}
