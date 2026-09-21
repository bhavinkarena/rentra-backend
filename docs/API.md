# API reference

Base URL: `http://localhost:4000/api/v1` (set by `API_PREFIX`).
Webhooks sit outside the prefix, at `/webhooks/*`.

All requests that need an actor send cookies — `credentials: 'include'` in the
browser, or a forwarded `Cookie` header from a Server Component.

## Response shape

```json
{ "statusCode": 200, "data": {}, "message": "Success", "success": true }
```

Failures set `success: false` and add `code`. A 422 also carries `errors`, the
`{ field: message }` map a form renders. Responses from ported actions may add
`redirect` (where to go next) and `revalidate` (paths that went stale).

Branch on `code`. Never on `message`.

### Responses that are not the envelope

Three kinds of route answer with something else, on purpose:

- `GET .../records/:id/summary` returns the printable summary as
  `text/plain`, or the calendar as `text/calendar` when `?calendar=1`. The
  browser saves it to a file, so wrapping it in `data` would produce a `.ics`
  no calendar app can read.
- `GET /admin/documents/:id/file` streams the document's bytes.
- `POST /webhooks/razorpay` answers in Razorpay's own shape, because the
  provider reads the status code and nothing else.

### Reads that redirect

A read may answer `200` with `data: null` and a `redirect`. That is the API
declining to serve the page to this actor — an unfinished customer profile
asking for `/customer/support`, for instance. Follow the redirect rather than
rendering the null.

## Status codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 400  | Malformed request — a bad path param, unparseable JSON                  |
| 401  | No valid session (`AUTH_REQUIRED`, `CLIENT_REQUIRED`, `ADMIN_REQUIRED`) |
| 403  | Signed in, but not allowed (`WRONG_ROLE`, `ACCOUNT_BLOCKED`)            |
| 404  | No such route or record                                                 |
| 409  | State conflict (`DATES_UNAVAILABLE`, `QUOTE_STALE`, `STALE_REQUEST`)    |
| 410  | `HOLD_EXPIRED` — the checkout hold lapsed                               |
| 413  | Body or file too large                                                  |
| 422  | Validation failed; `errors` names the fields                            |
| 423  | `CUSTOMER_ACCOUNT_LOCKED`                                               |
| 429  | `RATE_LIMITED`                                                          |
| 503  | Dependency unavailable — database, or payments not configured           |

## Rate limits

| Scope                             | Window | Limit |
| --------------------------------- | ------ | ----- |
| All routes (production only)      | 1 min  | 300   |
| OTP request and verify            | 10 min | 20    |
| Admin login                       | 15 min | 10    |
| Uploads                           | 10 min | 40    |
| Checkout holds and payment starts | 1 min  | 30    |

Keyed by client IP, which depends on `TRUST_PROXY_HOPS` being the real hop
count. The OTP limiter is the one that matters: without it the API is a free
SMS pump and an account-enumeration oracle.

## Routes

### Health — `live` never touches the database, so a Postgres blip does not restart the process

```
GET    /api/v1/health/live
GET    /api/v1/health/ready
GET    /health
```

### Client (property owner) authentication — email plus OTP

```
GET    /api/v1/auth/me
POST   /api/v1/auth/locked-cta
POST   /api/v1/auth/logout
POST   /api/v1/auth/otp/request
POST   /api/v1/auth/otp/verify
POST   /api/v1/auth/phone/confirm
POST   /api/v1/auth/phone/request
```

### Super Admin — a separate cookie and audience; a client session is never accepted

```
GET    /api/v1/admin/applications
GET    /api/v1/admin/applications/:id
GET    /api/v1/admin/applications/decisions
GET    /api/v1/admin/applications/stats
GET    /api/v1/admin/auth/me
GET    /api/v1/admin/notifications
GET    /api/v1/admin/operations
GET    /api/v1/admin/payments/configuration
GET    /api/v1/admin/privacy
GET    /api/v1/admin/records
GET    /api/v1/admin/records/:id
GET    /api/v1/admin/records/:id/summary
GET    /api/v1/admin/reviews
GET    /api/v1/admin/support
GET    /api/v1/admin/support/:id
GET    /api/v1/admin/support/:id/thread
GET    /api/v1/admin/documents/:id/file
GET    /api/v1/admin/users/:userId/documents
POST   /api/v1/admin/applications/approve
POST   /api/v1/admin/applications/more-info
POST   /api/v1/admin/applications/reject
POST   /api/v1/admin/auth/login
POST   /api/v1/admin/auth/logout
POST   /api/v1/admin/clients/suspend
POST   /api/v1/admin/documents/review
POST   /api/v1/admin/notifications/manage
POST   /api/v1/admin/payments/configuration
POST   /api/v1/admin/privacy/review
POST   /api/v1/admin/records/visit
POST   /api/v1/admin/reviews/moderate
POST   /api/v1/admin/reviews/reports/resolve
POST   /api/v1/admin/support/:id/reply
```

### Customer — account, bookings, reviews, support, notifications

```
GET    /api/v1/customer/account
GET    /api/v1/customer/account/onboarding
GET    /api/v1/customer/auth/selection/:rentableId
GET    /api/v1/customer/notifications
GET    /api/v1/customer/records
GET    /api/v1/customer/records/:id
GET    /api/v1/customer/records/:id/summary
GET    /api/v1/customer/reviews/:reviewId
GET    /api/v1/customer/reviews/order/:orderId
GET    /api/v1/customer/support
GET    /api/v1/customer/support/:id
GET    /api/v1/customer/support/:id/thread
POST   /api/v1/customer/account/phone/confirm
POST   /api/v1/customer/account/phone/request
POST   /api/v1/customer/account/privacy
POST   /api/v1/customer/account/profile
POST   /api/v1/customer/auth/begin
POST   /api/v1/customer/auth/logout
POST   /api/v1/customer/auth/otp/request
POST   /api/v1/customer/auth/otp/verify
POST   /api/v1/customer/auth/switch
POST   /api/v1/customer/notifications/read
POST   /api/v1/customer/records/cancellation
POST   /api/v1/customer/records/cancellation/preview
POST   /api/v1/customer/records/rebook
POST   /api/v1/customer/reviews
POST   /api/v1/customer/reviews/report
POST   /api/v1/customer/support
POST   /api/v1/customer/support/:id/reply
```

### Partner — onboarding, listings, calendar, bookings, reviews

```
DELETE /api/v1/partner/documents
DELETE /api/v1/partner/listings/:id/photos
GET    /api/v1/partner/application
GET    /api/v1/partner/catalogue/amenities
GET    /api/v1/partner/catalogue/categories
GET    /api/v1/partner/catalogue/places
GET    /api/v1/partner/documents
GET    /api/v1/partner/listings
GET    /api/v1/partner/listings/:id
GET    /api/v1/partner/listings/:id/calendar
GET    /api/v1/partner/listings/:id/calendar/state
GET    /api/v1/partner/listings/summary
GET    /api/v1/partner/records
GET    /api/v1/partner/records/:id
GET    /api/v1/partner/records/:id/summary
GET    /api/v1/partner/reviews
PATCH  /api/v1/partner/listings/:id/photos/order
POST   /api/v1/partner/application/consent
POST   /api/v1/partner/application/details
POST   /api/v1/partner/application/payout
POST   /api/v1/partner/application/submit
POST   /api/v1/partner/application/withdraw
POST   /api/v1/partner/documents
POST   /api/v1/partner/listings
POST   /api/v1/partner/listings/:id/amenities
POST   /api/v1/partner/listings/:id/basics
POST   /api/v1/partner/listings/:id/calendar/block
POST   /api/v1/partner/listings/:id/calendar/open-dates
POST   /api/v1/partner/listings/:id/calendar/price-override
POST   /api/v1/partner/listings/:id/calendar/schedule
POST   /api/v1/partner/listings/:id/calendar/unblock
POST   /api/v1/partner/listings/:id/capacity
POST   /api/v1/partner/listings/:id/location
POST   /api/v1/partner/listings/:id/ownership-document
POST   /api/v1/partner/listings/:id/pause
POST   /api/v1/partner/listings/:id/photos
POST   /api/v1/partner/listings/:id/pricing
POST   /api/v1/partner/listings/:id/rules
POST   /api/v1/partner/listings/:id/submit
POST   /api/v1/partner/listings/:id/terms
POST   /api/v1/partner/records/visit
POST   /api/v1/partner/reviews/reply
POST   /api/v1/partner/reviews/report
POST   /api/v1/partner/settings/account
POST   /api/v1/partner/settings/payout
```

### Public discovery — no session read, safe to cache (except availability)

```
GET    /api/v1/discovery/cities
GET    /api/v1/discovery/cities/:citySlug/areas
GET    /api/v1/discovery/cities/:citySlug/areas/:areaSlug/count
GET    /api/v1/discovery/listings
GET    /api/v1/discovery/listings/:code
GET    /api/v1/discovery/listings/:code/availability
GET    /api/v1/discovery/listings/:code/next-dates
GET    /api/v1/discovery/listings/:id/similar
GET    /api/v1/discovery/listings/nearby
GET    /api/v1/discovery/registry
GET    /api/v1/discovery/route-count
GET    /api/v1/discovery/search
GET    /api/v1/discovery/sitemap
```

### Quoting and checkout — quoting is public, everything after the hold is not

```
GET    /api/v1/bookings/checkout/:orderId
GET    /api/v1/bookings/checkout/:orderId/status
GET    /api/v1/bookings/checkout/quote/:quoteId
GET    /api/v1/bookings/checkout/recent
POST   /api/v1/bookings/checkout/:orderId/refresh
POST   /api/v1/bookings/checkout/:orderId/release
POST   /api/v1/bookings/checkout/:orderId/start
POST   /api/v1/bookings/checkout/hold
POST   /api/v1/bookings/checkout/verify
POST   /api/v1/bookings/quote
```

### Saved places — works signed out; the server decides guest versus account

```
GET    /api/v1/saved/
POST   /api/v1/saved/guest
POST   /api/v1/saved/merge
POST   /api/v1/saved/update
```

### Browser beacon — aggregate counters only, respects DNT and Sec-GPC

```
POST   /api/v1/measurement/
```

### External callers — raw body, no session, answers in the provider’s shape

```
POST   /webhooks/razorpay
```

142 routes. Regenerate this list with `npm run routes`.
