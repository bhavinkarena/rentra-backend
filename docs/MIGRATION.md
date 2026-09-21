# Migrating from the Next.js monolith

## What actually happened

The Next app's backend was not an API. It was **82 Server Actions** plus 55
server-rendered pages reading Drizzle directly, with only four HTTP routes in
the whole codebase.

So the honest description of this migration is: **the business logic moved
across unchanged, and an HTTP layer was built on top of it.** That was a
deliberate choice over a reimplementation. The alternative — rewriting eighty
functions that handle payments, inventory holds and KYC — is eighty
opportunities to introduce a subtle behavioural difference in code that was
already correct and already shipped through twenty delivery parts.

### The three things that made it possible

**1. A module loader, not a rewrite.** `loader/hooks.mjs` resolves the `@/`
alias and extensionless relative imports the way a bundler does, so the ported
files run under plain Node without being edited.

**2. Shims instead of edits.** The ported code imports `next/headers`,
`next/cache`, `next/navigation`, `react` and `server-only`. None of those are
installed. The loader redirects each to `src/runtime/`, backed by an
AsyncLocalStorage request context:

| Import             | Shim                 | Behaviour                                                                                                                                                       |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cookies()`        | `next-headers.js`    | Reads `req.cookies`, writes via `res.cookie`. Converts `maxAge` from **seconds to milliseconds** — get this wrong and a 30-day session becomes a 30-second one. |
| `headers()`        | `next-headers.js`    | A real `Headers`, so `.get()` stays case-insensitive.                                                                                                           |
| `redirect()`       | `next-navigation.js` | Throws, exactly as Next does. Nothing after it runs. The adapter turns it into `{ success: true, redirect }`.                                                   |
| `notFound()`       | `next-navigation.js` | Throws; becomes a 404.                                                                                                                                          |
| `revalidatePath()` | `next-cache.js`      | Collects paths per request, returned as `revalidate`.                                                                                                           |
| `cache()`          | `react.js`           | Memoises **per request**. Process-wide would leak one user's session into another's request.                                                                    |
| `server-only`      | `server-only.js`     | No-op. It was a bundler guard; there is no client bundle here.                                                                                                  |

**3. A FormData adapter.** The actions take `(previousState, formData)` and
read `formData.get()`. `src/utils/formData.js` builds a real `FormData` from
the Express request — JSON body, urlencoded body, or multer files — so all 82
run unmodified. A JSON client and a multipart form take the same code path,
because scalars are stringified the way a real multipart body would send them.

## What each Server Action became

| Was                                                    | Now                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `requestClientOtp` / `verifyClientOtp`                 | `POST /auth/otp/{request,verify}`                                                                   |
| `requestPhoneVerification` / `confirm…`                | `POST /auth/phone/{request,confirm}`                                                                |
| `adminLogin` / `adminLogout`                           | `POST /admin/auth/{login,logout}`                                                                   |
| `requestCustomerOtp` / `verifyCustomerOtp`             | `POST /customer/auth/otp/{request,verify}`                                                          |
| `saveDetails` / `savePayout` / `saveConsent`           | `POST /partner/application/{details,payout,consent}`                                                |
| `submitApplication` / `withdrawApplication`            | `POST /partner/application/{submit,withdraw}`                                                       |
| `uploadKycDocuments` / `deleteKycDocument`             | `POST` / `DELETE /partner/documents`                                                                |
| `saveBasics` … `saveTerms` (7 wizard steps)            | `POST /partner/listings/:id/{basics…terms}`                                                         |
| `uploadListingPhotos` / `remove` / `reorder`           | `POST`/`DELETE`/`PATCH /partner/listings/:id/photos`                                                |
| `submitListing` / `toggleListingPause`                 | `POST /partner/listings/:id/{submit,pause}`                                                         |
| `saveSchedule` / `saveOverride` / `blockDates` …       | `POST /partner/listings/:id/calendar/*`                                                             |
| `requestBookingQuote`                                  | `POST /bookings/quote`                                                                              |
| `holdCustomerCheckout` → `releaseCustomerCheckout`     | `POST /bookings/checkout/*`                                                                         |
| `previewCustomerCancellation` / `cancelCustomerVisits` | `POST /customer/records/cancellation{,/preview}`                                                    |
| `submitCustomerReview` / `moderate` / `reply` / …      | `POST /{customer,partner,admin}/reviews/*`                                                          |
| `openSupport` / `replyCustomerSupport` / `replyAdmin…` | `POST /{customer,admin}/support*`                                                                   |
| `readNotification` / `manageNotification`              | `POST /{customer,admin}/notifications/*`                                                            |
| `loadSavedPlaces` / `updateSavedPlace` / `merge…`      | `/saved/*`                                                                                          |
| `approveApplication` / `reject` / `requestMoreInfo`    | `POST /admin/applications/*`                                                                        |
| `savePaymentGatewaySettings`                           | `POST /admin/payments/configuration`                                                                |
| `startPrivacyReview`                                   | `POST /admin/privacy/review`                                                                        |
| 4 route handlers (`/api/*`)                            | `/discovery/listings/:code/availability`, `/admin/operations`, `/measurement`, `/webhooks/razorpay` |

Full table: `npm run routes` (142 routes).

## What changed in behaviour

These are the real differences. Everything else is the same code.

**Authorisation answers differently.** The service layer's `requireClient()`
and `requireAdmin()` still run inside every action and are still
authoritative — they read the live user row, so an account suspended
mid-session is caught there. But they were written for page navigation and
respond by redirecting to a login screen, which is not a useful API answer. So
`src/middlewares/auth.middleware.js` runs the same lookup first and returns
401/403. Defence in depth: removing a guard from a service function is still a
bug.

**Next's render cache is gone.** `revalidatePath` no longer invalidates
anything server-side; it reports the stale paths to the client, which decides
what to do. Any page that relied on automatic revalidation after a mutation
now needs an explicit `router.refresh()`.

**The Razorpay webhook URL changed** to `POST /webhooks/razorpay` on the API
host. Update it in the Razorpay TEST dashboard — the old Next route will stop
receiving events.

**Cookies are cross-origin.** With the frontend and API on different origins
the session cookie needs `SameSite=None; Secure` and an exact CORS origin
echo. The simpler option, and the recommended one, is to put both behind one
parent domain (`app.rentra.in` / `api.rentra.in`) so the cookie stays
first-party and `SameSite=Lax` keeps working. `COOKIE_SAME_SITE` and
`CORS_ORIGINS` control this.

## The shared schema

`src/services/db/schema/index.js` exists in both repositories and **must stay
byte-identical**. It is a copy, not a package, because extracting it would mean
publishing and versioning a private package to solve a problem two `cp`
commands solve — and a version skew between the two would be far harder to
notice than a diff.

The rule:

- **The backend owns migrations.** Generate and apply them here
  (`npm run db:generate`, `npm run db:migrate`). The frontend's
  `drizzle.config.js` should no longer be used to generate.
- **After changing the schema here**, copy it to
  `Rentra/lib/db/schema/index.js` in the same commit.

`src/services/` as a whole follows the same rule, and is excluded from lint and
Prettier here for exactly that reason: reformatting it would turn every future
sync into a diff full of noise.

## Cutting the frontend over

The frontend still runs its Server Actions and still works. Nothing was ripped
out, because a half-migrated app that cannot serve a booking is worse than a
slower migration.

`lib/api/client.js` and `lib/api/endpoints.js` are the bridge. Cut over one
surface at a time, in this order — it goes from least to most risk:

1. **Public discovery** (`discoveryApi`) — no session, easy to verify.
2. **Partner onboarding and the listing wizard** (`partnerApi`) — forms with
   field errors, exercises the 422 path.
3. **Customer account, saved places, notifications** — session-dependent reads.
4. **Support and reviews** — exercises the `redirect` field.
5. **Checkout** — last, and only after 1–4 are proven in staging. It is the
   only flow where a mistake costs someone money.

For each surface: replace the action import with the endpoint call, handle
`ApiError.fields` where the form rendered `errors`, and call `router.refresh()`
where `revalidatePath` used to run. Delete the action only once the screen is
verified.

The gate scripts in `Rentra/scripts/verify-*.mjs` still import the
service layer directly, so they keep passing throughout — they verify the
domain logic, which did not move.
