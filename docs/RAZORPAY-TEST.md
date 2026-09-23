# Razorpay test bookings

The existing flow is: select available dates → review quote → customer login →
accept checkout terms → temporary inventory hold → Razorpay Test checkout → server
signature/provider verification → confirmed booking. Test mode does not charge
actual bank money. Live keys remain rejected.

## Local configuration

The backend needs these values in `.env` (never `NEXT_PUBLIC_` variables):

- `RAZORPAY_TEST_KEY_ID`
- `RAZORPAY_TEST_KEY_SECRET`
- `RAZORPAY_TEST_WEBHOOK_SECRET`

The configured test API credentials were accepted by Razorpay. A new webhook
secret was generated locally because it was missing; its value was not printed or
committed. The gateway was enabled using the existing audited admin service,
configuration revision 1, with full rent plus platform fee collection. The security
deposit stays separate. Stone Villa's calendar is already inventory-ready.

Restart the backend API and worker after environment changes. Run `npm run dev`
and `npm run worker` in separate backend terminals. Revisit the listing and choose
fresh dates to obtain a quote with the new payment configuration. Previously issued
quotes retain their original configuration and must be refreshed.

Future enablement can use `/admin/payments`, or the explicit operator command:

```bash
npm run payments:enable-test -- <active-admin-id>
```

The command preserves the configured collection purpose and creates an audited
revision only when needed. It will not enable live payments or create a payment.

## Finish Razorpay dashboard setup

In Razorpay Test mode, add a webhook for your publicly reachable backend:

```text
https://<backend-host>/webhooks/razorpay
```

Use the exact secret in the backend's `RAZORPAY_TEST_WEBHOOK_SECRET`. For local
work, use a public HTTPS tunnel to backend port 4000; Razorpay cannot send requests
to your localhost. Select `payment.authorized`, `payment.captured`, `payment.failed`,
`order.paid`, `refund.created`, `refund.processed`, and `refund.failed`. Run the
worker so persisted webhook events are processed. Configure automatic capture in
Razorpay; booking confirmation requires verified captured payment evidence.

The browser callback also verifies payment on the server. Webhooks and worker
reconciliation provide recovery when the browser closes or a request is lost.
Never bypass signatures or mark a booking paid from the browser response alone.

Dashboard setup and a completed hosted test payment have not been verified here.

Official references: [Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
and [webhook setup](https://razorpay.com/docs/webhooks/setup-edit-payments/).

## Verification

- Razorpay authenticated read-only API check returned HTTP 200.
- Database configuration read-back: Razorpay, test, enabled, credentials ready, revision 1.
- Read-only pricing check for Stone Villa, one guest/day visit on 2026-09-24: ₹5,940 including platform fee. This did not reserve inventory.
- 60 backend tests and 2 frontend tests passed, including signature and amount validation.
- Lint and formatting checks passed in both repositories.
- Isolated frontend production build passed with Webpack, generating 42 static pages.
