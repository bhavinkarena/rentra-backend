# rentra-backend

The Rentra API: Express 4 over Postgres, with Drizzle for schema and queries.

Split out of the Next.js app, which keeps the pages and components. The
business logic was not rewritten — it was moved across intact. See
[docs/MIGRATION.md](docs/MIGRATION.md) for how, and why that was the safer
choice than a reimplementation.

```
src/
├── index.js            process entry — boot order, graceful shutdown
├── app.js              express app — middleware order is load-bearing, read it
├── config/             env validation, database handle, CORS, constants
├── routes/             *.route.js  — paths and their guards
├── controllers/        thin: HTTP in, service call, HTTP out
├── services/           the business logic, ported from the Next app
├── validations/        request-shape schemas for params and query strings
├── middlewares/        auth, validation, errors, rate limits, uploads, raw body
├── runtime/            AsyncLocalStorage context + the Next.js shims
├── cron/               the background worker
├── utils/              response envelope, error type, the action adapter
└── scripts/            migrate, seed, routes, smoke
```

## Quick start

```bash
npm install
cp .env.example .env          # then fill DATABASE_URL and SESSION_SECRET
npm run db:migrate
npm run dev                   # API on :4000
npm run worker                # payments, notifications, inventory expiry
```

Verify it:

```bash
npm test      # 52 unit and integration tests, no database needed for most
npm run smoke # boots the app against the real database and checks the contract
npm run routes # prints all 142 routes
```

## The response contract

Every response, success or failure, carries the same four fields:

```json
{ "statusCode": 200, "data": {}, "message": "Success", "success": true }
```

Failures add `code`, and validation failures add `errors`:

```json
{
  "statusCode": 422,
  "data": { "step": "email" },
  "message": "Check the highlighted fields.",
  "success": false,
  "code": "VALIDATION_FAILED",
  "errors": { "email": "That does not look like an email address" }
}
```

**Branch on `code`, never on `message`.** The code is stable; the message is
written for a person and will be reworded.

Two extra fields appear on responses from ported actions:

- `redirect` — where the action says to go next, e.g. `/support/42` after
  opening a ticket. Still a 200; it is advice for your router, not an HTTP 3xx.
- `revalidate` — the paths whose data just went stale.

The one exception is `POST /webhooks/razorpay`, which answers in Razorpay's
shape because the provider reads the status code and nothing else.

## Errors

`AppError` is the only error type whose message reaches a caller. Everything
else is logged against a correlation id and answered with a generic 500 — this
process talks to Postgres, Cloudinary and Razorpay, and their raw errors carry
connection strings and key fragments.

Coded domain errors from the service layer (`DATES_UNAVAILABLE`,
`HOLD_EXPIRED`, `INVENTORY_NOT_READY`, …) are mapped to statuses in
`src/middlewares/error.middleware.js`. An unmapped code is a gap in that table,
not something to hand to a caller.

## Environment

Validated at boot; the process refuses to start on an invalid value rather than
500ing on the first request. Two layers:

- `src/services/schemas/joi/env.js` — shared with the frontend, **not edited
  here**. Both codebases must agree about `DATABASE_URL`, `SESSION_SECRET` and
  the Razorpay keys.
- `src/config/env.js` — what only a standalone server needs: `PORT`,
  `CORS_ORIGINS`, `TRUST_PROXY_HOPS`, `API_PREFIX`, cookie policy.

Two values need care:

- **`SESSION_SECRET` must match the frontend's** for as long as either issues
  session cookies. A mismatch invalidates every session silently.
- **`TRUST_PROXY_HOPS` must be the real hop count.** Express uses it to pick
  the client IP; set it too high and a caller can spoof X-Forwarded-For and
  hand themselves a fresh rate-limit bucket, walking past the OTP limiter.

## Documentation

- [docs/API.md](docs/API.md) — the full route table.
- [docs/MIGRATION.md](docs/MIGRATION.md) — what moved, what each Server Action
  became, and what to watch for.

## AOG structure and formatting

See [architecture alignment](docs/ARCHITECTURE.md) for the reference comparison,
folder responsibilities, compatibility choices and feature workflow.

- `npm run lint:fix` runs ESLint autofixes and Prettier document formatting.
- `npm run format:check` checks formatting without writes.
- `npm run db:check` checks migration journal ordering and SQL registration without connecting to a database.
- `npm run ci` runs lint, formatting, migration file checks and tests.
- `.vscode/` enables format-on-save and recommends ESLint/Prettier extensions.
- `src/cron/jobs.js` registers jobs; `runner.js` handles isolated execution and heartbeats.
