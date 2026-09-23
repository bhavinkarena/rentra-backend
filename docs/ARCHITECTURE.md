# AOG architecture alignment

## Reviewed references

AOG backend: package scripts/dependencies, Express route/controller layout,
response enhancer, async/service error handling, validation schemas, cron registry
and job modules, migration policy, ESLint and Prettier configuration.
AOG frontend: package dependencies, Redux store/slices, shared RTK Query base API,
injected feature services, shadcn utility setup, validation and formatting configuration.
The review focused on reusable architecture, not every AOG business feature.

## Mapping

| Area             | AOG pattern                                              | Rentra implementation                                                                                           |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HTTP             | Express routes → controllers → services                  | Existing `src/routes`, `controllers`, `services` retained                                                       |
| Responses        | `res.success` / `res.error` envelope                     | Existing enhancer retained, including Rentra error codes, fields, redirect and revalidation metadata            |
| Errors           | Operational AppError, hidden production failures         | Existing central error middleware and correlation IDs retained                                                  |
| Validation       | Joi backend, Zod frontend                                | Existing Joi environment validation and shared Zod request/domain schemas retained to preserve acceptance rules |
| Configuration    | Central config, environment validation                   | Existing `src/config` retained                                                                                  |
| Auth/uploads     | Auth middleware, rate limits, multipart parsing          | Existing cookie/Jose, role checks, Multer and Cloudinary retained                                               |
| Background work  | Central registry and isolated job functions              | `src/cron/jobs.js` registry and `runner.js`, separate worker process                                            |
| Migrations       | Ordered SQL, explicit deployment, schema synchronization | Drizzle journal plus SQL and schema source; `db:check` validates file registration/order without connecting     |
| Frontend routing | React Router/Vite                                        | Next App Router route groups, layouts and server/client boundaries retained                                     |
| State            | Redux Toolkit, React Redux, shared RTK Query API         | Per-render store; `lib/services` base API and injected customer/partner/admin services                          |
| UI               | Tailwind, shadcn/Radix, icons, toast                     | Existing compatible Rentra libraries retained                                                                   |
| Formatting       | Prettier integrated into ESLint                          | Both repos support `lint:fix`, `format`, `format:check` and editor save actions                                 |

## Compatibility choices

Rentra keeps ES modules, Postgres/Drizzle and Zod rather than copying AOG's
CommonJS/MySQL/Joi domain schemas. Changing these would change runtime behavior,
migration history or input acceptance. AOG-specific payment, casino, socket,
analytics and editor dependencies are not required by Rentra's existing features.
Existing response status codes, paths, raw webhook bytes, authentication, database
schema, public rendering, Server Actions and product UI remain intact.

The unused RTK Query sketch contained nonexistent accept/decline/payout endpoints.
Those placeholders were replaced with services for actual routes. Existing screens
have no imports of the removed hooks. Services preserve envelopes and cookies and
use role-specific cache tags. The base API is browser-safe and does not import
Next server cookie utilities. New client-side use must handle redirect metadata,
reset private cache on identity changes and retain confirmation flows.

## Adding backend features

1. Put request schemas in `src/validations`; keep domain validation in services.
2. Register routes in a feature `.route.js` and mount them in `routes/index.js`.
3. Apply authentication/rate limits/validation before the controller. Controllers
   use `asyncHandler`, response helpers and services; unexpected failures go to
   the central error handler. Preserve raw-body ordering for signed webhooks.
4. Keep database access in services/config and environment validation centralized.
5. Register background work in `cron/jobs.js`; `runner.js` owns timing eligibility,
   failure isolation and heartbeats. Run one worker process. Payment and notification
   jobs remain sequential every loop, followed by hourly retention. No node-cron
   dependency is needed for the existing interval behavior.
6. Add forward migrations through Drizzle; never edit applied SQL or reorder the
   journal. Update the schema source and any intentionally shared copies together.
   Review destructive changes separately and test against a disposable database.
   Do not place rollback SQL inside Drizzle's forward migration directory.
7. Run `db:check`, lint, formatting and tests. Apply `db:migrate` explicitly during
   deployment; app startup must not migrate. The runner now resolves its directory
   relative to the script and closes its connection even when migration fails.

No database migration is required by this architecture change. `db:check` checks
files only; it does not prove SQL applies to a live database. Existing ported backend
services remain excluded from automatic formatting to avoid changes to shared code.

## Verification for this change

- Backend: 57 tests pass, including response/error contracts, raw webhooks, validation and worker timing/failure isolation.
- Frontend: 2 tests pass, covering transport, cookies, response metadata, validation errors and independent store caches.
- Both repositories pass ESLint, Prettier checks and `git diff --check`.
- Migration file check passes for all 21 entries; no SQL was applied.
- Route inventory prints 145 routes. Route definitions and database schema were not modified.
- Frontend production build passes with `npm run build -- --webpack` (42 static pages generated). Default Turbopack verification was blocked by a build-worker port permission error in this environment; the default build script is unchanged.
- 184 existing frontend source files were verified to equal Prettier formatting of their previous contents, with no additional edits.

Authenticated browser journeys and live payment/database operations were not exercised.
