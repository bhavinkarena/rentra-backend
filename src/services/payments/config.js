/**
 * Installed execution capabilities, separate from the admin's gateway selection.
 * Test server services exist from Part 11; hosted customer UI follows in Part 12.
 * An absent/disabled gateway never selects dummy or live.
 */
export const PAYMENT_RUNTIME = Object.freeze({
  mode: null, provider: null, environment: null,
  realPaymentsEnabled: false,
  customerCheckoutEnabled: false,
  testServicesEnabled: true,
  savedMethodsEnabled: false,
  gatewayConfigurationEnabled: true,
});
