/**
 * Installed execution capabilities, separate from the admin's gateway selection.
 * Test server services and hosted customer checkout are implemented.
 * Actual enablement is controlled by the audited payment_gateway_config revision
 * and server credentials, not by these capability flags.
 * An absent/disabled gateway never selects dummy or live.
 */
export const PAYMENT_RUNTIME = Object.freeze({
  mode: null, provider: null, environment: null,
  realPaymentsEnabled: false,
  customerCheckoutEnabled: true,
  testServicesEnabled: true,
  savedMethodsEnabled: false,
  gatewayConfigurationEnabled: true,
});
