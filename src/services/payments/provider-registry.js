/** Code-owned allowlist. Admin input cannot register an executable provider. */
const providers = Object.freeze({
  razorpay: Object.freeze({
    id: 'razorpay',
    label: 'Razorpay',
    environments: Object.freeze(['test']),
    adapterVersion: 'razorpay-test-v1',
  }),
});

export class PaymentConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaymentConfigurationError';
    this.code = code;
  }
}

export function registeredPaymentProvider(provider, environment) {
  const adapter = Object.hasOwn(providers, provider) ? providers[provider] : null;
  if (!adapter || !adapter.environments.includes(environment)) {
    throw new PaymentConfigurationError('UNSUPPORTED_GATEWAY', 'Choose a registered gateway in test mode.');
  }
  return adapter;
}

export const REGISTERED_PAYMENT_PROVIDERS = Object.freeze(Object.values(providers));
