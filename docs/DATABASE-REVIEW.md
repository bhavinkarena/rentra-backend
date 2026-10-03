# Rentra database review and redesign plan

Review date: 30 September 2026
Scope: the live `public` schema (76 tables, 2 views) described in `rentra-full-paste.txt`, checked against `src/services/db/schema/index.js`, all 41 migrations in `drizzle/`, and the service code that reads and writes each table.

---

## 0. How to read this document

1. Section 1 gives the verdict and the short list of changes.
2. Section 2 explains how the review was done and what it could not check.
3. Section 3 lists every table and what should happen to it.
4. Sections 4 to 13 give the findings, each with evidence, the change, and why the change is worth making.
5. Section 14 lists merges that look attractive but were rejected, and why.
6. Section 15 is the final schema: full DDL for every changed table, and the list of unchanged tables.
7. Section 16 is the relationship map.
8. Section 17 is the migration plan, phase by phase, with pre-checks, SQL, code changes, verification and rollback.
9. Section 18 lists open questions that only the owner can answer.
10. Section 19 audits every relationship (delete rules, role checks, redundant parent copies).
11. Appendix A has the pre-migration audit queries. Run them first.

Evidence is cited as `file:line`. Paths are relative to `rentra-backend/`. `M00NN` means `drizzle/00NN_*.sql`.

---

## 1. Executive summary

### Verdict

The schema is in better shape than its table count suggests. Most tables that look like duplicates exist for a real reason:

- Money tables are append-only. Triggers freeze them (`rentra_financial_immutable`, M0009:228). The small side tables (`payment_event_job`, `payment_execution`, `refund_execution`) hold the few fields that must keep changing, so the ledger rows can stay frozen.
- Case and ticket tables have different states, outcomes and participants. Each is guarded by its own scope and immutability triggers.
- `admin_user` is kept apart from `user` on purpose, so that one privilege bug cannot hand over payout controls (schema:530-534).

Merging those tables would make the design worse, not better. Section 14 explains each one.

The real problems are different. They come from features that were rebuilt without the old storage being removed:

| #   | Problem                                                                                                                                                                                                                                                                            | Impact                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Client payout details are stored in **three places**: `user.payout_*`, `client_application.payout_*`, `payout_destination`. Code dual-writes them (`payouts/destinations.js:83-90`).                                                                                               | Data can disagree; the approval gate reads the legacy copy.                   |
| 2   | KYC data is split across `person` (unused at runtime), `client_application.kyc_*` (two columns dead) and `user.kyc_status`.                                                                                                                                                        | Unclear source of truth.                                                      |
| 3   | `booking` carries a full legacy copy of itself: whole-rupee amounts next to paise amounts, `day` next to `local_day`, snapshots copied from `booking_order`, and dead backfill columns. `day`, `amount_rent` and `amount_fee` are `NOT NULL`, so every new booking must fill them. | Dual writes with no sync trigger; about 17 redundant columns.                 |
| 4   | Legacy bookings (`order_id IS NULL`) were **never backfilled** into orders. The backfill planner (`domain/booking-legacy.js`) is imported by nothing.                                                                                                                              | Every booking query needs a legacy branch.                                    |
| 5   | Prices have three sources (`booking_price_override`, `availability.price_override`, `rentable_price`). Owner blocks have two (`availability.blocked_by_client`, `inventory_reservation`).                                                                                          | Confusing precedence rules in `quotes.js:43-91` and `inventory.js:175-196`.   |
| 6   | Money units are mixed: paise in `*_minor` columns, whole rupees in `rentable_price`, `rentable.deposit_amount`, `rentable.extra_guest_charge`, `payout.*`, `availability.price_override`.                                                                                          | The schema comment itself warns about this (schema:57-64).                    |
| 7   | Dead tables and columns: `unit`, `person`, `booking.accept_deadline`, backfill columns, `user.payout_bank_ref` (write-only), `client_application.kyc_ref` / `kyc_verified_at`.                                                                                                     | Noise; misleads future work.                                                  |
| 8   | Customer sessions and partner sessions use two tables, although customers and clients share one cookie (`session-crypto.js:17`). Partner OTP and customer OTP use two tables; the partner one is weaker (plain-text IP, no browser binding).                                       | Two revocation paths, two retention problems.                                 |
| 9   | About 24 foreign-key columns have no index. A few hot queries cannot use their index (geography cast on `rentable.location`, JSON lookup on `payment_event`).                                                                                                                      | Fine at today's size (largest table is 28,632 rows); a problem as data grows. |
| 10  | No retention job for OTPs, rate rows, sessions, quotes or processed webhook jobs. The webhook claim query scans all historical jobs on every tick.                                                                                                                                 | Tables and worker cost grow without bound.                                    |
| 11  | `document` uses a polymorphic owner with no foreign key. A re-upload overwrites the reviewed row in place, so the `superseded` status is never used and review history is lost.                                                                                                    | Integrity and audit gap.                                                      |
| 12  | The live database is missing migration 0040 (`operational_incident`, `operational_incident_event` are in the schema file but not in the live schema).                                                                                                                              | Schema drift.                                                                 |

### What changes

- **Tables:** 76 live tables become 71 (70 after merges and drops, plus the new `role` lookup table), plus the 2 tables from pending migration 0040, so 73 in total.
  - Dropped: `person`, `unit`.
  - Merged into `user`: `customer_profile`, `client_update_preference`.
  - Merged into `auth_session`: `customer_session`.
  - Merged into one `otp_challenge`: `otp_token` and `customer_otp_challenge`.
  - Renamed: `portal_session` → `auth_session`, `customer_auth_rate` → `auth_rate_event`.
  - Added: `role`, a lookup table that replaces the `user_role` enum (§4.7).
- **Columns:** about 35 redundant columns are removed. About 12 whole-rupee columns become paise.
- **Integrity:** composite foreign key for `rentable(area_id, city_id)`, real foreign keys for `document` owners, role CHECKs on `user`, `booking.order_id NOT NULL`, missing CHECKs on OTP and rate tables.
- **Performance:** about 30 indexes added, 4 redundant or dead indexes dropped, one retention job, two worker query fixes.

The table count drops only a little. That is expected. The gain is one source of truth for each fact, not fewer tables.

### Order of work

| Phase | Content                                                  | Risk          |
| ----- | -------------------------------------------------------- | ------------- |
| 0     | Rehearsal branch, drift check, audit queries             | none          |
| 1     | Indexes, CHECKs, retention, worker fixes (additive only) | very low      |
| 2     | Remove dead tables, columns and indexes                  | low           |
| 3     | Identity consolidation: `user`, sessions, `person`       | medium        |
| 4     | Payout details: single source                            | low to medium |
| 5     | Inventory and pricing: single source                     | medium        |
| 6     | Booking legacy contraction                               | medium        |
| 7     | Money units to paise                                     | medium        |
| 8     | Document owner FKs, naming (optional)                    | low           |
| 9     | OTP unification (optional hardening)                     | low to medium |

---

## 2. Method and limits

What was checked:

- Every table and column in the paste, against the Drizzle schema, including its indexes, CHECKs and FKs.
- All triggers, functions, views and exclusion constraints in `drizzle/*.sql`. The schema file does not show these, so the paste alone hides most of the design.
- For each column that looked suspect: every reader and writer in `src/`, and in the frontend repo.
- Worker queries (`src/cron/jobs.js`) and hot request queries, against the existing indexes.

Important facts that bound the plan:

- **The frontend has no database access.** `Rentra/` has no Drizzle schema and no Postgres dependency; it calls the API (`Rentra/lib/actions/customer.js:4`). Only the fixture scripts in `Rentra/scripts/portal-gate/` touch Postgres. So schema changes only need backend changes. Note that `docs/MIGRATION.md` is out of date: its "shared schema" section still says the frontend keeps a byte-identical copy.
- **Triggers carry much of the business logic.** Many tables have `BEFORE UPDATE` triggers that compare `to_jsonb(NEW)` with `to_jsonb(OLD)`, for example `checkout_terms` (M0015:64-83) and `version_listing_content` (M0027:21). This matters for migration: a mass `UPDATE` on `rentable`, `rentable_price`, `rentable_amenity` or `document` bumps listing content versions. A mass `UPDATE` on frozen money rows raises an error. The plan avoids mass updates on those tables. It uses `ALTER TABLE` (which does not fire row triggers) and stored generated columns instead.

Limits:

- The hosted database was not queried. Row counts come from the paste. Appendix A lists the queries that must be run before each phase.
- Some legacy data may be seed data. The seeds insert bookings without orders (`scripts/seed.js:477`) and are the only writers of `payout` rows (`seed.js:492`). Whether the hosted data is real or seeded decides one important choice in Phase 6 (see section 18).

---

## 3. Table inventory and verdict

Legend: **Keep** = no structural change. **Tune** = keep the table and add indexes or constraints. **Slim** = remove columns. **Merge** = move into another table. **Drop** = remove. **Rename**.

### Identity and access (14 tables)

| Table                      | Rows | Verdict                              | Reason                                                                                                                                                   |
| -------------------------- | ---- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`                     | 22   | **Redesign**                         | Absorbs `customer_profile` and `client_update_preference`. Loses `person_id` and `payout_*`. Gains role CHECKs and case-insensitive email uniqueness. §4 |
| `admin_user`               | 1    | Keep                                 | Separate on purpose: password + TOTP + lockout, no self-signup. §14                                                                                      |
| `person`                   | 11   | **Drop**                             | No runtime reader or writer; seeds only. §4.3                                                                                                            |
| `customer_profile`         | 3    | **Merge → `user`**                   | 1:1, same lifecycle; attributes are not customer-specific. §4.4                                                                                          |
| `client_update_preference` | 0    | **Merge → `user`**                   | 1:1, one JSON column. §4.4                                                                                                                               |
| `client_application`       | 2    | **Slim**                             | Keep as the Gate 1 workflow record. Drop the dead KYC columns and the payout copy. §4.5, §5                                                              |
| `client_staff`             | 12   | Keep                                 | A delegated caretaker scoped to one owner, not a platform account. §14                                                                                   |
| `staff_invitation`         | 1    | Keep                                 |                                                                                                                                                          |
| `staff_property`           | 2    | Keep                                 |                                                                                                                                                          |
| `customer_session`         | 15   | **Merge → `auth_session`**           | Same shape as `portal_session`, same cookie. §9.1                                                                                                        |
| `portal_session`           | 17   | **Rename → `auth_session`**          | Now holds all sessions. §9.1                                                                                                                             |
| `otp_token`                | 37   | **Merge → `otp_challenge`**          | Optional (Phase 9). §9.2                                                                                                                                 |
| `customer_otp_challenge`   | 16   | **Merge → `otp_challenge`**          | Optional (Phase 9). §9.2                                                                                                                                 |
| `customer_auth_rate`       | 50   | **Rename → `auth_rate_event`**, Tune | Used for all principals after Phase 9; gets a CHECK.                                                                                                     |

### Catalogue and listings (13 tables)

| Table                | Rows | Verdict        | Reason                                                                                             |
| -------------------- | ---- | -------------- | -------------------------------------------------------------------------------------------------- |
| `city`               | 10   | Keep           |                                                                                                    |
| `area`               | 111  | Tune           | Add unique `(id, city_id)` as the target of the new composite FK. §7.3                             |
| `category`           | 1    | Keep           |                                                                                                    |
| `amenity`            | 43   | Keep           | Three fixed label columns are fine; an i18n table would be over-normalisation.                     |
| `rentable`           | 123  | **Slim**, Tune | Drop `amenities` jsonb and `approved_snapshot`. Money columns to paise. Composite FK to `area`. §7 |
| `rentable_amenity`   | 665  | Tune           | Index on `amenity_id`.                                                                             |
| `rentable_price`     | 366  | **Redesign**   | `weekday` / `weekend` rupees → `*_minor`. §8                                                       |
| `listing_submission` | 0    | Keep           | Immutable snapshot per review pass.                                                                |
| `listing_review`     | 0    | Keep           |                                                                                                    |
| `verification_visit` | 110  | Keep           |                                                                                                    |
| `document`           | 110  | **Redesign**   | Real FKs for the owner; keep history on re-upload. §11                                             |
| `redirect`           | 0    | Keep           | Read by `catalogues/service.js:82`, but nothing writes it. Add a writer when slugs change.         |
| `unit`               | 0    | **Drop**       | No reference outside the schema and the seed truncate list. §6                                     |

### Booking and inventory (13 tables)

| Table                                                       | Rows   | Verdict  | Reason                                                                                   |
| ----------------------------------------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------- |
| `booking_quote`                                             | 121    | Tune     | FK indexes; retention for expired quotes.                                                |
| `booking_order`                                             | 15     | Tune     | Index on `rentable_id`.                                                                  |
| `booking`                                                   | 49     | **Slim** | Remove the legacy copy; `order_id NOT NULL`. §6.2, §10                                   |
| `availability`                                              | 28,632 | **Slim** | Keep as the open-date calendar only. Move prices and blocks out. §8                      |
| `booking_price_override`                                    | 0      | Keep     | Becomes the only per-date price source.                                                  |
| `inventory_reservation`                                     | 20     | Keep     | Becomes the only block source. The GiST exclusion constraint is the double-booking lock. |
| `booking_cancellation`                                      | 2      | Keep     |                                                                                          |
| `booking_lifecycle_event`                                   | 32     | Keep     | Drives notifications and the client inbox through triggers.                              |
| `booking_case`, `booking_case_update`, `booking_case_visit` | 0      | Keep     | §14                                                                                      |
| `customer_favourite`, `customer_favourite_merge`            | 7, 1   | Keep     | The merge table is a replay receipt (`customer/saved.js:61-76`).                         |

### Payments and payouts (13 tables)

| Table                                                                           | Rows           | Verdict      | Reason                                                                   |
| ------------------------------------------------------------------------------- | -------------- | ------------ | ------------------------------------------------------------------------ |
| `payment_gateway_config`                                                        | 1              | Keep         | Immutable config revisions.                                              |
| `payment_order`, `payment_attempt`, `payment_transaction`, `payment_allocation` | 15, 14, 14, 38 | Keep, Tune   | Ledger chain. §12                                                        |
| `payment_execution`, `payment_event`, `payment_event_job`                       | 15, 39, 39     | Keep, Tune   | Mutable side tables for frozen parents. Fix the job claim scan. §12, §13 |
| `refund`, `refund_allocation`, `refund_execution`                               | 1, 1, 1        | Keep, Tune   | Partial index for the `requested` scan.                                  |
| `customer_payment_method`                                                       | 0              | Tune         | Index on `customer_id`.                                                  |
| `payout`                                                                        | 29             | **Redesign** | Rupee columns → paise. §8.4                                              |
| `payout_destination`                                                            | 1              | Keep         | Becomes the only store of payout details. §5                             |

### Support, disputes, evidence, reviews (14 tables)

All kept, with FK indexes added. Section 14 explains why these tables should stay separate. A unified admin inbox should be a view.

`support_request`, `support_message`, `support_attachment`, `dispute_case`, `dispute_message`, `dispute_attachment`, `visit_evidence`, `visit_evidence_correction`, `visit_incident`, `visit_attachment`, `review`, `review_report`, `notification_outbox`, `client_update`.

### Platform and operations (9 tables)

All kept: `audit_log` (Tune, §13.3), `admin_export_job` (Tune), `privacy_job` (Tune), `customer_privacy_request`, `content_draft`, `content_publication`, `customer_measurement`, `service_health`. The ninth, `operational_incident` with its `_event` table, is in migration 0040 but not yet in the live database.

---

## 4. Identity: the user tables

### 4.1 What exists today

There are 14 identity-related tables. Only one of them, `user`, is actually a "users" table. The rest fall into four groups:

| Kind                             | Tables                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Principals (who can log in)      | `user` (customers and clients), `admin_user`, `client_staff`                                                          |
| Role extensions, 1:1 with `user` | `customer_profile`, `client_update_preference`, `client_application`                                                  |
| Auth artefacts                   | `customer_session`, `portal_session`, `otp_token`, `customer_otp_challenge`, `customer_auth_rate`, `staff_invitation` |
| Unused                           | `person`                                                                                                              |

So the request to have "a single well-designed users table" is already half true: customers and clients share `user`. The work is to decide what belongs on that row.

### 4.2 One row per role, not one row per human

`user` is unique on `(phone, role)` and `(email, role)`. One human can have a customer row and a client row (schema:241-248). This is deliberate, and the code depends on it:

- Customers log in with phone OTP. Clients log in with email OTP. Clients are created as `pending_application`, customers as `active` (`customer-identity.js:97`, `auth/actions.js:128-138`).
- The session JWT carries a role audience, `rentra:customer` or `rentra:client` (`session-crypto.js:28`). `switchToCustomer` destroys the current session first (`customer-actions.js:71-76`).
- About 47 service files and several triggers filter on `role`. Examples: `payout_destination_scope` (M0033:50-73), the case scope triggers (M0029:86-130).

**Recommendation: keep one row per role.** A "one row per human with many roles" model would change the meaning of every FK to `user` (`booking.customer_id`, `rentable.client_id` and about 40 more), plus every role filter and trigger. The only gain would be a shared profile for people who are both a customer and a client. That gain does not justify the risk now. If it is ever needed, add a small `account_link(customer_id, client_id)` table. `person` was meant to be that link and was never wired in.

### 4.3 `person`: drop

- Written only by seeds (`seed.js:113`, `seed-gujarat-partners.js:2229`).
- `user.person_id` is selected in `dal.js:49` but never used, and set to NULL by privacy erasure (`privacy-fulfillment.js:466`).
- Its purpose was "verify KYC once for a person who is both customer and client" (schema:186-191). Customers are never KYC-verified, so that case does not happen.

Drop `person`, `user.person_id` and `user_person_idx`.

### 4.4 Merge `customer_profile` and `client_update_preference` into `user`

`customer_profile` (3 rows) has `user_id` as its primary key and holds `photo_public_id`, `marketing_consent`, `consent_updated_at`, `completed_at`, `version` and `updated_at`.

Why merging improves the design, and not only the table count:

1. It is strictly 1:1 with the same lifecycle. It is created at onboarding and erased with the account.
2. Photo and marketing consent describe the person, not the customer role. A client could have both.
3. Today the _existence_ of the row, plus a name, is the "onboarding done" flag (`customer-actions.js:62-64`). An explicit `profile_completed_at` column is clearer.
4. Every account page, the privacy export and the admin customer view currently join two tables for one entity.

`client_update_preference` (0 rows) holds one `muted` JSON array and a `version`. Its only readers are `auth/client-inbox.js:84-116` and the SQL function `client_update_insert()` (M0030:34-39). It is part of the account.

Both tables carry their own `version` token for optimistic concurrency. After the merge, one `profile_version` column serves both, because each role only edits one of the two sets of fields. This is safe: a coarser token can only cause extra conflicts, never missed ones. It stays separate from `lifecycle_version`, so admin lifecycle commands still never go stale because of a user's own edit (schema:218-222).

### 4.5 Role-specific columns and KYC

| Column                                         | Used by  | Status                                                                      | Action                                                                                                                                                                                      |
| ---------------------------------------------- | -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_type`                                  | client   | live                                                                        | keep, CHECK NULL for customers                                                                                                                                                              |
| `kyc_status`                                   | client   | live                                                                        | keep as the account-level verdict. The values `rejected` and `more_info_needed` are never written, although `profile.js:88-90` reads `rejected`. Fix the writer or remove the values later. |
| `payout_upi_id`                                | client   | legacy mirror                                                               | **drop** (§5)                                                                                                                                                                               |
| `payout_bank_ref`                              | client   | write-only                                                                  | **drop** (§5)                                                                                                                                                                               |
| `responds_within_mins`, `response_rate`        | client   | read by the public listing (`db/queries.js:162-163`); only seeds write them | keep for now. Either add a job that computes them or remove them together with the UI. (§18)                                                                                                |
| `privacy_erasure_pending`, `privacy_erased_at` | customer | live                                                                        | keep, CHECK default values for clients                                                                                                                                                      |
| `person_id`                                    | —        | dead                                                                        | **drop**                                                                                                                                                                                    |

KYC after the change has one owner per fact:

- **Evidence** (document type, name on document): `client_application.kyc_doc_type`, `kyc_name_on_doc`, plus the files in `document`.
- **Verdict:** `user.kyc_status`.
- Dropped: `client_application.kyc_ref` and `kyc_verified_at` (no reader or writer outside M0004), and `person`.

### 4.6 Case-insensitive email uniqueness

`user_email_role_idx` is on the raw `email`. `A@x.com` and `a@x.com` would be different accounts. The admin login lowercases (`admin-actions.js:19`), but the index does not enforce it. Add a unique index on `(lower(email), role)`. Keep the existing index, because an `ON CONFLICT (email, role)` target may rely on it.

### 4.7 A `role` lookup table

Today `user.role` is the Postgres enum `user_role ('customer','client')`. The same enum is used by `review.author_role` and `booking.cancelled_by`. `booking.cancelled_by` does not belong with the other two; see the note below.

**Recommendation: replace the enum with a small `role` table, keyed by the role code.**

```sql
CREATE TABLE role (
  code        varchar(16)  PRIMARY KEY,               -- 'customer', 'client'
  label       varchar(60)  NOT NULL,
  description text,
  is_active   boolean      NOT NULL DEFAULT true,
  sort_order  integer      NOT NULL DEFAULT 0,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT role_code_chk CHECK (code ~ '^[a-z_]{3,16}$')
);

-- "user".role and review.author_role reference it:
--   role varchar(16) NOT NULL REFERENCES role(code) ON UPDATE RESTRICT ON DELETE RESTRICT
```

The primary key is the code itself (`'client'`), **not** a surrogate `role_id uuid`. That is the key design choice:

- 32 service files and 16 comparisons inside triggers already filter on `role = 'client'` or `role = 'customer'`. None of them cast to `::user_role`. With a code key, all of them keep working unchanged. With a `role_id` key, every one would need a join or a hard-coded UUID.
- The unique indexes `(phone, role)` and `(email, role)` keep their meaning.
- Codes are stable. `ON UPDATE RESTRICT` stops anyone renaming a code that rows depend on.

What it gains over the enum:

- A value can be retired (`is_active = false`) or deleted when unused. An enum value can never be removed.
- Labels and descriptions for admin screens live in the database, like `category` and `city`.
- It is the natural place for role metadata later, for example a `role_permission` table, if role-based permissions are ever needed. Do not add that now.

Honest limit: with two roles, the gain is small. It is worth doing because the cost is also small: one migration, no code change except the Drizzle schema.

What it does **not** change:

- A user still has exactly one role (§4.2). This is a lookup table, not a many-to-many `user_role(user_id, role)` table. A many-to-many table would mean one row per human, which §4.2 explains is not worth the risk now.
- `admin_user` and `client_staff` stay separate principals and are **not** rows in `role`. Admins have their own `permissions` jsonb; caretakers have per-property grants (§14).

Migration: part of Phase 3, as its own migration that runs before the profile merge (step 3a0 in §17):

```sql
CREATE TABLE role ( ...as above... );
INSERT INTO role (code, label, sort_order) VALUES
  ('customer', 'Customer', 1),
  ('client',   'Client (owner or authorised agent)', 2);

-- public_customer_review selects r.*, so it depends on review.author_role. Drop and recreate it around the type change.
DROP VIEW public_customer_review;

ALTER TABLE "user"  ALTER COLUMN role         TYPE varchar(16) USING role::text;
ALTER TABLE booking RENAME COLUMN cancelled_by TO cancelled_by_kind;
ALTER TABLE booking ALTER COLUMN cancelled_by_kind TYPE varchar(16) USING cancelled_by_kind::text;
ALTER TABLE booking ADD CONSTRAINT booking_cancelled_by_kind_chk
  CHECK (cancelled_by_kind IS NULL OR cancelled_by_kind IN ('customer','client','admin','system'));
ALTER TABLE review  ALTER COLUMN author_role  TYPE varchar(16) USING author_role::text;

ALTER TABLE "user"  ADD CONSTRAINT user_role_fk           FOREIGN KEY (role)         REFERENCES role(code) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE review  ADD CONSTRAINT review_author_role_fk   FOREIGN KEY (author_role)  REFERENCES role(code) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE VIEW public_customer_review AS
  SELECT r.* FROM review r
   WHERE r.author_role = 'customer' AND r.moderation_state = 'published' AND r.published_at IS NOT NULL
     AND rentra_review_eligible(r.booking_id, r.author_id, r.rentable_id);   -- copy the exact body from M0018:40-42

DROP TYPE user_role;
```

Notes:

- `ALTER COLUMN … TYPE` rewrites the table and rebuilds its indexes. It does not fire row triggers, so no session is revoked and no listing version is bumped. At 22 users and 49 bookings this takes milliseconds.
- Check on the rehearsal branch that no function or view other than `public_customer_review` depends on these columns. Postgres refuses the `ALTER` if one does, so the migration fails safely instead of silently.
- Drizzle: add `export const role = pgTable('role', …)`, change `role: userRole('role')` to `varchar('role', { length: 16 }).notNull().references(() => role.code)` (and the same for `authorRole`), and delete the `userRole` enum export. Nothing in `src/` imports `userRole` outside the schema file.
- **Why `booking.cancelled_by` becomes `cancelled_by_kind` and does not reference `role`.** It records _who cancelled_, and that is not always a user role. A customer cancellation writes `'customer'` (`cancellation.js:86`). An admin cancellation through a booking case writes NULL (`booking-cases.js:321`). The hold-expiry and settlement paths set `cancelled_at` but no `cancelled_by` at all (`inventory.js:138`, `payments/settlement.js:99`). So today NULL means "admin, system or unknown". A CHECK over `('customer','client','admin','system')` lets each path say what happened. Update those three writers to set `'admin'` and `'system'`. The rename touches 2 files (`cancellation.js`, `booking-cases.js`). **The same migration must also replace `rentra_checkout_terms_immutable()` (M0015:64-83)**: its `mutable` array names `'cancelled_by'`. If that name is not changed to `'cancelled_by_kind'`, cancelling any booking whose order has a payment execution fails with "Accepted checkout terms are immutable".

### 4.8 Can `admin_user` be removed and merged into `user`?

Short answer: it is technically possible, but it makes the design weaker. **Keep `admin_user` separate.** The evidence follows.

#### What depends on `admin_user` today

| Dependency                               | Count                  | Where                                                                                                                                                                 |
| ---------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreign keys pointing at `admin_user.id` | 27 live, 29 with M0040 | `reviewed_by`, `assigned_to`, `decided_by`, `resolved_by`, `published_by`, `changed_by` and others, on 21 tables                                                      |
| Trigger checks that read `admin_user`    | 13                     | "is this actor an active admin, with this permission" in M0017:73, M0018:55, M0019:70, M0028:103,112, M0029:96-129, M0031:69, M0032:57, M0034:93-98                   |
| Service files                            | 34                     | login, operators, every admin queue                                                                                                                                   |
| Admin-only columns                       | 9                      | `password_hash`, `totp_secret`, `failed_attempts`, `locked_until`, `permissions`, `security_version`, `enrollment_hash`, `enrollment_secret`, `enrollment_expires_at` |
| Columns shared with `user`               | 5                      | `email`, `name`, active flag, `last_login_at`, `created_at`                                                                                                           |

#### What a merge would look like

`role` gets a third value, `'admin'`. The 9 admin-only columns move to `user` as nullable columns with a CHECK. Admin rows are copied into `user` **with the same ids**. Ids are random UUIDs, so they do not collide. Because the ids stay the same, the 27 FKs can be pointed at `user` without changing any data.

So the migration itself is not the hard part. The problems are what the merged design loses.

#### Why it makes the design worse

1. **The FKs stop proving "this person is an admin".** Today `payout_destination.decided_by → admin_user` means that only an admin can be recorded as the decider. After the merge, `decided_by → user` accepts a customer id. To get the guarantee back, each of the 27 referencing tables would need an extra constant column (`decided_by_role = 'admin'`) and a composite FK `(decided_by, decided_by_role) → user(id, role)`. That is 27 extra columns to save one table.
2. **`permissions IS NULL` means full access.** `capabilities.js:13` and `admin/operators.js:137,146` treat a NULL `permissions` value as a super-admin. In a merged table, `permissions` is NULL on every customer and client row, because it is the column default. Any code path or trigger that forgets `AND role = 'admin'` would give a customer full admin capability. With the separate table, that mistake cannot happen: a customer id is simply not found in `admin_user`.
3. **Public code would write to the admin table.** Customer signup upserts into `user` (`customer-identity.js:97`), and so does client signup (`auth/actions.js:128-138`). A bug that takes `role` from request input becomes an admin account. Today the only `INSERT INTO admin_user` is `admin/operators.js:170`, behind `admin.security.write`.
4. **Database permissions become coarser.** With separate tables, the public API's database role can later be denied `UPDATE` on `admin_user` completely. With one table, Postgres grants apply to the whole table. Only row-level security could separate admins from customers, and that is more complex than the current design.
5. **The credentials are different anyway.** Admins log in with a password and TOTP, have a lockout counter and an enrollment flow, and use their own cookie (`rentra_admin`, 8-hour life, `SameSite=Strict`, audience `rentra:admin`, `admin.js:16-26`). Customers and clients use phone or email OTP. A merged table does not give a shared login: it gives 9 columns that are NULL for 21 of the 22 rows.
6. **Common guidance agrees.** Guidance on least privilege says to keep different trust levels in separate accounts, to reduce the damage one bug can do and to make audits clearer. Discussions of "one users table versus a separate admin table" usually prefer one table when admins and users share one login flow. Rentra does not.

What a merge would gain: 5 shared columns in one place, and one table for "who did this" in timelines. The second point has a cheaper answer, below.

#### The better alternative: a read-only `principal` view

The real need behind merging is usually "show one name for whoever did this", across `audit_log.actor_id` and the `actor_kind` / `actor_id` columns on the case tables. A view solves that without touching any FK or trigger:

```sql
CREATE VIEW principal AS
  SELECT id, role::text AS kind, coalesce(name, email, phone) AS display_name, email,
         account_status = 'active' AS is_active
    FROM "user"
  UNION ALL
  SELECT id, 'admin', name, email, is_active FROM admin_user
  UNION ALL
  SELECT id, 'staff', coalesce(name, phone), NULL, is_active AND revoked_at IS NULL FROM client_staff;
```

Timelines and the audit browser can join `principal` on `actor_id`. This is safe because ids are random UUIDs, unique across the three tables.

#### Other merge candidates checked again

| Candidate                                                | Verdict       | Reason                                                                                                                           |
| -------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `admin_user` into `user`                                 | Keep separate | Above.                                                                                                                           |
| `client_staff` into `user`                               | Keep separate | §14. Caretakers are delegated to one owner, with grants per property.                                                            |
| `admin_user.permissions` jsonb into a `permission` table | Keep jsonb    | 8 fixed capability strings, checked with `@>` in triggers. A table adds joins and nothing else.                                  |
| `admin_export_job` + `privacy_job` into one job table    | Keep separate | Both hold an encrypted artifact and a state, but their parents, states and stages differ. `privacy_job` is keyed by its request. |
| `payment_execution` + `refund_execution`                 | Keep separate | Different parents and different trigger rules for what may change (M0015:37, M0016:25).                                          |
| `client_update` + `notification_outbox`                  | Keep separate | An inbox that people read versus an SMS delivery queue with leases.                                                              |
| `visit_evidence_correction` into `visit_evidence`        | Keep separate | Evidence is immutable. Corrections form a chain that supersedes it without erasing it.                                           |
| `staff_invitation` into the OTP table                    | Keep separate | A long-lived, single-use link token versus a 5-minute code.                                                                      |

### 4.9 Before and after

```
BEFORE                                        AFTER
                                              role ──1:*── user  (lookup, code PK)
user ──1:1── customer_profile                 user  (common + customer + client columns,
user ──1:1── client_update_preference                role CHECKs, profile_version)
user ──*:1── person (unused)                  │
user ──1:1── client_application               ├─1:1── client_application (slim)
user ──1:*── customer_session                 ├─1:*── auth_session (user_id)
user ──1:*── portal_session (user_id)         │        admin_user ─1:*─ auth_session (admin_id)
admin_user ─1:*─ portal_session (admin_id)    │        client_staff ─1:*─ auth_session (staff_id)
client_staff ─1:*─ portal_session (staff_id)  ├─1:*── client_staff ─1:*─ staff_invitation
otp_token (partners, staff)                   │                      └─*:*─ rentable (staff_property)
customer_otp_challenge (customers)            otp_challenge (all principals)   [Phase 9]
customer_auth_rate                            auth_rate_event (all principals)
14 tables                                     11 tables (incl. role)
```

---

## 5. Payout details are stored three times

| Copy                                                                                                               | Written by                                                         | Read by                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `user.payout_upi_id`, `payout_bank_ref`                                                                            | `application.js:162-163`, `destinations.js:89` (`mirrorLegacy`)    | `profile.js:111` as a fallback; `payout_bank_ref` is never read                       |
| `client_application.payout_upi_id`, `payout_account_ref`, `payout_ifsc`, `payout_holder_name`, `payout_name_match` | `application.js:152-164`, `destinations.js:83-90`                  | stepper `profile.js:106-114`; approval gate `admin/applications.js:36-37,100,138,244` |
| `payout_destination` (versioned, verified, append-only by trigger)                                                 | `recordOnboardingDestination` (`application.js:171-173`), settings | payouts, finance                                                                      |

`payout_destination` is the correct design. It is versioned, stores no full account number, needs provider evidence to reach `verified`, and each payout is pinned to one destination version (`payout.destination_id`). The other two copies were left over from before migration 0033. Migration 0033 backfilled them with `source='migration'` (M0033:98-116), but rows that failed its regex or length checks stayed only in the legacy columns (comment at M0033:98-99).

**Change:**

1. Switch the approval gate from `client_application.payout_name_match` to the current destination's `name_check`. The current destination is the row with `state IN ('submitted','verified')`, which is unique per client (`payout_destination_current_idx`).
2. Switch the stepper to read the current destination.
3. Remove the mirror writes.
4. Drop all 7 legacy columns.

Run the pre-check A.3 first. Rows that exist only in the legacy columns need a manual `payout_destination` row, or a decision to re-collect.

---

## 6. Dead tables, columns and indexes

### 6.1 Tables

- **`unit`.** Serial-numbered goods for a future phase. It has zero references outside the schema and the seed truncate list (`seed.js:75`). Inventory code rejects `total_units ≠ 1` (`inventory.js:201`, `quotes.js:35`). Drop it now; create it again when goods rental is actually built, designed against real requirements.
- **`person`.** See §4.3.

### 6.2 Columns

| Table.column                                                                         | Evidence                                                                                                               | Action                                                                          |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `booking.accept_deadline`                                                            | no reader or writer; only the index `booking_state_deadline_idx`                                                       | drop, with the index                                                            |
| `booking.legacy_advance_reported_minor`, `backfill_version`, `backfilled_at`         | used only in `domain/booking-legacy.js`, which nothing imports                                                         | drop, with `booking_backfill_idx` and the dead file                             |
| `booking.amount_advance_paid`, `balance_mode`, `balance_settled_at`, `check_in_code` | seeds only (`seed.js:477-487`)                                                                                         | drop, unless on the roadmap (§18). Drop the enum type `balance_mode` with them. |
| `user.person_id`, `payout_upi_id`, `payout_bank_ref`                                 | §4, §5                                                                                                                 | drop                                                                            |
| `client_application.kyc_ref`, `kyc_verified_at`                                      | no reader or writer outside M0004                                                                                      | drop                                                                            |
| `client_application.payout_*` (5 columns)                                            | §5                                                                                                                     | drop                                                                            |
| `rentable.amenities`                                                                 | written only by seeds; read only as a fallback when no join rows exist (`domain/listing-content.js:53-68`)             | drop (§7.1)                                                                     |
| `rentable.requires_operator`                                                         | no reader or writer anywhere in `src/` (goods-rental placeholder, like `unit`)                                         | drop                                                                            |
| `rentable.approved_snapshot`                                                         | copy of `listing_submission.snapshot`, which `published_submission_id` already points to (`admin/verification.js:336`) | drop (§7.2)                                                                     |

### 6.3 Indexes

| Index                          | Why                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `booking_order_idx (order_id)` | Redundant. It is the leading column of the unique indexes `booking_order_position_idx` and `booking_order_localday_slot_idx`. |
| `booking_state_deadline_idx`   | Indexes the dead `accept_deadline`.                                                                                           |
| `booking_backfill_idx`         | Indexes a dead column.                                                                                                        |
| `user_person_idx`              | Goes with `person_id`.                                                                                                        |

---

## 7. Listing (`rentable`) design

### 7.1 Amenities: two stores

Owner writes, search filters and reads all use `rentable_amenity` (`auth/listings.js:298-303`, `db/discovery.js:57,100`, `db/queries.js:207-210`). The `amenities` jsonb is a seed-era fallback. Drop it. Before that, pre-check A.6 finds listings that have jsonb amenities but no join rows. Fix those through the seed data or an owner edit.

Do not mass-insert them with SQL. The `amenity_content_version` trigger (M0026:56) bumps the listing content version on every insert.

### 7.2 Controlled denormalisation: what stays and what goes

| Column                       | Copy of                                                     | Verdict                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `rating_avg`, `review_count` | aggregate of `public_customer_review`                       | **keep**. Trigger-maintained (M0018:63-86) and guarded against manual writes. Needed so a listing card is one query.       |
| `verified_at`, `verified_by` | the completed `verification_visit`                          | **keep**. Used for the badge on cards; set once at publish.                                                                |
| `rejection_reason`           | the latest `listing_review.reason`                          | keep. Cheap and read on owner pages.                                                                                       |
| `review_pass`                | pointer to `listing_submission.pass_number`                 | keep. Used as a join key.                                                                                                  |
| `approved_snapshot`          | `listing_submission.snapshot` via `published_submission_id` | **drop**. Read the snapshot through the FK instead (`admin/listings.js:72`).                                               |
| `form`                       | `category.form`, copied at create (`auth/listings.js:159`)  | keep. Block changing `category.form` while live listings use it, in `catalogue_reference_guard`, or else the copies drift. |

### 7.3 City and area consistency

`rentable` stores both `city_id` and `area_id`, and `area` already has `city_id`. Today the trigger `catalogue_reference_guard` (M0035:12-32) checks that they match. It only runs on rentable insert and on a change to area or city. Nothing stops `area.city_id` itself from changing.

Replace the procedural check with a declarative one. It is stronger and costs nothing:

```sql
CREATE UNIQUE INDEX area_id_city_idx ON area (id, city_id);
ALTER TABLE rentable ADD CONSTRAINT rentable_area_city_fk
  FOREIGN KEY (area_id, city_id) REFERENCES area (id, city_id) NOT VALID;
ALTER TABLE rentable VALIDATE CONSTRAINT rentable_area_city_fk;
```

Keep `rentable.city_id`. Discovery filters by city through `rentable_city_cat_idx`, so the copy earns its place, and the composite FK now proves it is correct. Keep the trigger for its `is_active` checks.

---

## 8. Inventory, pricing and money units

### 8.1 Current state

`availability` (28,632 rows, all created by seeds or by the owner "open dates" action) does three jobs:

1. **Open-date whitelist.** `prepareInventoryCheck` returns `INVENTORY_MISSING` when a date and slot has no row, and `INVENTORY_UNAVAILABLE` when `units_available ≤ 0` (`inventory.js:167-170,268-270`). This job is still load-bearing.
2. **Legacy owner blocks.** `blocked_by_client` rows are turned into block intervals by `legacyOwnerIntervals` (`inventory.js:175-196`). New blocks go to `inventory_reservation` (`createOwnerBlock`, `inventory.js:283-306`).
3. **Legacy price overrides** in rupees. New overrides go to `booking_price_override` in paise (`owner-settings.js:41`). Quotes merge both; the explicit row wins (`quotes.js:43-46,88-91`).

So jobs 2 and 3 each have two stores.

### 8.2 Change

- `availability` keeps job 1 only: `(rentable_id, day, slot, units_available)`.
- Existing `price_override` values move to `booking_price_override` (×100). Explicit rows already win, so `ON CONFLICT DO NOTHING` keeps today's quotes exactly. `booking_price_override` has no content-version trigger, so the insert does not touch listings.
- Existing `blocked_by_client` rows move to `inventory_reservation` as `owner_block` rows. Use a one-off script that reuses `legacyOwnerIntervals()` inside `withListingInventory`, so the intervals are the same as the quote path computes today. A block that overlaps an existing booking hits the exclusion constraint `reservation_active_overlap_excl` (M0008:165-169). Report those; do not force them.
- Then remove the legacy branches in `quotes.js`, `inventory.js` and `owner-calendar.js`, and drop both columns.

A later, optional step: make open dates rule-based, derived from `rentable.booking_config` (horizon and lead time) with blocks as the only exceptions. That would remove most of the 28k rows. It is a product decision about how owners open dates (§18), so it is not part of this plan.

### 8.3 Money: one unit everywhere

The codebase's own rule is "money in integer minor units in `*_minor` columns" (schema:57-65). These columns break it:

| Column                                                                       | Today                               | After                                   |
| ---------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------- |
| `rentable_price.weekday`, `weekend`                                          | integer rupees                      | `weekday_minor`, `weekend_minor` bigint |
| `rentable.deposit_amount`                                                    | integer rupees                      | `deposit_minor` bigint                  |
| `rentable.extra_guest_charge`                                                | integer rupees                      | `extra_guest_charge_minor` bigint       |
| `availability.price_override`                                                | integer rupees                      | removed (§8.2)                          |
| `payout.gross`, `commission`, `tds_194o`, `gst_tcs`, `net`                   | integer rupees                      | `*_minor` bigint                        |
| `booking.amount_rent`, `amount_fee`, `amount_deposit`, `amount_advance_paid` | integer rupees, copies of `*_minor` | removed (§10)                           |

Conversion method: `rentable`, `rentable_price` and `payout` have row triggers that react to `UPDATE`. `rentable_content_version` and `price_content_version` bump listing versions; `financial_scope` freezes funded payouts. So do **not** convert with `UPDATE ... SET x_minor = x * 100`. Instead:

1. Add each new column as `GENERATED ALWAYS AS (x::bigint * 100) STORED`. `ALTER TABLE` does not fire row triggers.
2. Deploy code that reads `*_minor`.
3. `ALTER COLUMN ... DROP EXPRESSION` (Postgres 13+). The column becomes a normal column that keeps its values. Deploy code that writes `*_minor`.
4. Drop the rupee column.

Section 17, Phase 7 has the exact steps.

### 8.4 `payout`

No service code creates payouts; only seeds do. The finance statement labels the rupee fields "legacyQuote … not proof of collection" (`finance/statements.js:270-294`). Converting now, while the table holds only seed rows, is much cheaper than after real payouts begin. It is also the moment to add basic CHECKs (all amounts ≥ 0, `net_minor ≤ gross_minor`). The exact net formula should be confirmed with the CA first (schema:1246-1250).

---

## 9. Sessions and OTP

### 9.1 Merge `customer_session` into `portal_session`, rename it `auth_session`

|                    | `customer_session`                                                 | `portal_session`                                                          |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Principal          | `user_id` (customer)                                               | exactly one of `user_id` (client), `admin_id`, `staff_id` (CHECK)         |
| Cookie             | `rentra_session`                                                   | `rentra_session` (client), `rentra_admin`, `rentra_staff`                 |
| Validity           | role customer and status `active` (`customer-identity.js:107-114`) | client: `active` or `pending_application` (`portal-sessions.js:16,42`)    |
| Revocation trigger | `customer_status_session_revocation` (M0011:36-47)                 | `user_portal_access_revoked`, `admin_portal_access_revoked` (M0024:11-39) |

These are one concept stored twice. Customers and clients already share a cookie. `portal_session.user_id` references `user` with no role restriction. The only difference is the validity rule, and that is a `CASE` on `user.role`.

Merging gives one revocation model, one "sign out everywhere" query, one retention rule, and one table for the admin operator view. Copying the rows **with their existing ids** keeps customer JWTs valid (the claim holds the session id). The rename makes the name match the content. A simple view named `portal_session` keeps old code working during the rollout, because Postgres can write through simple views.

### 9.2 Unify OTP tables (optional, Phase 9)

`otp_token` serves partner and staff logins. It stores `request_ip` in plain text and has no browser binding and no delivery-mode binding. `verify_email` is never used. `customer_otp_challenge` plus `customer_auth_rate` is the stronger design: it hashes the IP and phone, binds the challenge to the browser and the delivery mode, and handles phone changes (`customer-identity.js:23-105`).

One `otp_challenge` table, plus `auth_rate_event` for all principals, gives partners the same protection and gives one retention rule. OTP rows live 5 minutes (`customer-identity.js:55`), so **no data needs copying**. The new code starts writing the new table, and codes already in flight expire on their own.

This is marked optional because it is a code change more than a data change. The security gain is real, but nothing is broken today. If it is skipped, still do two things: hash `otp_token.request_ip`, and add retention (§13.1).

---

## 10. Booking: remove the legacy copy

### 10.1 `booking` versus `booking_order`

`booking_order` is the checkout, and `booking` is one visit inside it (1 to 10 visits). Keeping them separate is correct. Some of the duplication between them is controlled and correct too:

- **Keep** `customer_id`, `rentable_id`, `currency`, `time_zone` on `booking`. The composite FK `booking_order_scope_fk` (M0008:152,160) proves they equal the parent's values. They serve the reservation FK `(booking_id, rentable_id)` and the per-visit indexes.
- **Keep** `payment_mode`, `visit_provenance` and `collected_minor` per visit. The `captured_payment_allocation` view and `rentra_review_eligible()` read them for each visit.
- **Remove** `listing_snapshot`, `policy_snapshot`, `pricing_version` and `policy_version` from `booking`. Checkout writes the same values into both tables (`checkout.js:59,64,79`). Readers use `coalesce(bo.listing_snapshot, b.listing_snapshot)` only because orderless rows exist (`finance/statements.js:254,268`). Once `order_id` is `NOT NULL`, read the order. Readers to switch: `refund-operations.js:48`, `investigation.js:39,148`, `finance/statements.js:254,268`.
- **Remove** `price_snapshot`. It holds the same JSON as `slot_snapshot` (`checkout.js:80`). Keep `slot_snapshot`, which `checkout-review.js:39-46` reads.

### 10.2 The legacy rupee and date columns

`day` equals `local_day` on every new row. `amount_rent`, `amount_fee` and `amount_deposit` equal `floor(minor / 100)` (`checkout.js:70-71`). They are `NOT NULL`, so every new booking must write them, and no trigger keeps them in sync. Their only readers:

- `day`: ORDER BY in `booking-cases.js:189` and `staff-visits.js:70`; selects in `booking-cases.js:435`, `property-overview.js:59`, `privacy-fulfillment.js:342`. Switch all to `local_day`.
- The rupee amounts: the privacy export (`privacy-fulfillment.js:342`). Switch it to `*_minor`.

### 10.3 Orderless bookings are the root problem

`booking.order_id` is nullable "only for legacy rows the backfill has not reached" (schema:1109). No backfill was ever run: the planner is dead code, and the `legacy` order state is never used. Seeds still insert orderless bookings.

As long as those rows exist, every query needs a legacy branch, and `local_day`, the `*_minor` amounts, `currency` and `time_zone` cannot become `NOT NULL`. Making `order_id NOT NULL` is the one change that lets the whole legacy copy go. There are two ways to get there (section 17, Phase 6):

- **Option A: reseed.** Choose this if the orderless rows are seed or test data (pre-check A.1). Change the seeds to create bookings through orders, then reseed. This is simplest and cleanest.
- **Option B: backfill.** Choose this if real history must be kept. Create one `booking_order` per legacy booking with `state='legacy'`, and fill `local_day`, `*_minor`, `currency`, `time_zone` and `item_position` from the legacy columns.

---

## 11. `document`: real owners and review history

### 11.1 Polymorphic owner without an FK

`document.owner_type` + `owner_id` point to `client_application` or `rentable` with no foreign key. An orphan is possible, and a deleted listing leaves documents behind silently. The codebase already has a better pattern: nullable FKs plus a `num_nonnulls` CHECK, as used by `portal_session` and `visit_attachment`.

The migration trick: **add the FK columns as stored generated columns** computed from `owner_type` and `owner_id`. There is then no `UPDATE`, so `document_content_version` (M0026:58) does not fire, and no code change is needed, because code keeps writing `owner_type` / `owner_id`. Integrity is enforced from the moment the migration runs. FKs on stored generated columns are allowed with `ON DELETE RESTRICT` or `NO ACTION`.

### 11.2 Re-upload destroys the reviewed file record

`document_slot_idx` is a full unique index on `(owner_type, owner_id, doc_type, side)`. Uploads use `onConflictDoUpdate` (`auth/documents.js:154-169`, `auth/listings.js:515-527`). So a re-upload overwrites the row that an admin reviewed: the storage key, the review note and the name match are replaced. The `superseded` status in `document_status` can never be reached, and the old Cloudinary file is left orphaned. That conflicts with the schema's own comment "Re-uploading supersedes" (schema:423).

**Change:**

1. Make the unique index partial: `WHERE status IN ('uploaded','accepted')`.
2. On re-upload, insert a new row and set the old row to `superseded`, in one transaction.
3. Retention later destroys superseded files and sets `deleted_at`.

---

## 12. Payment ledger: keep the structure, fix the scans

The chain `payment_order → payment_attempt → payment_transaction → payment_allocation`, plus `refund → refund_allocation`, is a sound append-only ledger:

- `financial_immutable` allows only a short list of columns to change (M0009:239-260).
- `rentra_financial_scope` checks that each child's provider, environment, mode and currency match its parent (M0009:263-375).
- Deferred `payment_reconciles` constraint triggers check the totals (M0009:399-447).

The repeated `provider`, `environment`, `mode` and `currency` columns are deliberate: each immutable fact describes itself, and a trigger proves it matches its parent. Keep them.

Fixes (details in §13):

- `payment_event_job` rows are never deleted. Release sets `next_attempt_at = now() + 1 minute` (`webhooks.js:81`), so after one minute every processed job looks due again. The claim query (`webhooks.js:43-46`, up to 10 times per tick) then walks all historical jobs through a join and discards them with `e.state <> 'processed'`. Fix: delete the job row when the event is processed. The job table exists only for leasing. Also add an attempts cap for failed events.
- The admin investigation joins `payment_event` on `redacted_payload->>'orderId'` (`investigation.js:55-57`). That is a sequential scan per payment order. Add an expression index.
- `refunds.js:66-70` scans `refund` for `state='requested'` on every tick with no index. Add a partial index.
- Not verified, to review in code: failed or cancelled payment orders and refunds seem to stay "due" in `payment_execution` / `refund_execution` and get polled forever (`payments/jobs.js:15-20`, `refunds.js:71-75`).

---

## 13. Performance, retention and operations

### 13.1 Retention (new hourly job in `cron/jobs.js`)

Nothing deletes these rows today. The windows below are safe against the code's own time windows: OTP expiry 5 minutes, rate window 1 hour, session 30 days.

| Table                                                         | Rule                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `otp_token`, `customer_otp_challenge` (later `otp_challenge`) | delete when `created_at < now() - 7 days`                                                          |
| `customer_auth_rate` (later `auth_rate_event`)                | delete when `created_at < now() - 7 days`                                                          |
| `customer_session`, `portal_session` (later `auth_session`)   | delete when `coalesce(revoked_at, expires_at) < now() - 90 days`                                   |
| `booking_quote`                                               | delete expired quotes older than 30 days that no `booking_order` references (the FK is `RESTRICT`) |
| `payment_event_job`                                           | delete when the event is `processed` (in code, §12)                                                |
| `notification_outbox`                                         | keep; archive after 12 months if needed                                                            |
| `audit_log`                                                   | cannot be pruned (append-only trigger, M0039). See §13.3.                                          |

### 13.2 Indexes

Postgres does not index foreign-key columns automatically. Without an index, every `RESTRICT` or `CASCADE` check on a parent delete, and every join from parent to child, scans the child table. These columns have no index that starts with them:

`review.rentable_id`, `review.author_id`, `payout.booking_id`, `payout.destination_id`, `booking_order.rentable_id`, `booking_order.quote_id`, `booking_quote.customer_id`, `booking_quote.rentable_id`, `refund_allocation.booking_id`, `notification_outbox.order_id`, `notification_outbox.booking_id`, `support_request.order_id`, `support_request.property_id`, `support_request.assigned_to`, `support_request.privacy_request_id`, `dispute_case.order_id`, `dispute_case.visit_id`, `customer_otp_challenge.customer_id`, `customer_payment_method.customer_id`, `client_update.rentable_id`, `client_update.order_id`, `rentable.category_id`, `rentable_amenity.amenity_id`.

Queries that cannot use an existing index:

| Query                                              | Problem                                                                                                 | Fix                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `getListingsNearby` (`db/queries.js:135`)          | `ST_DWithin(location::geography, …)`. The cast stops it using the GiST index on `geometry`.             | expression index `USING gist ((location::geography))` |
| Owner booking history (`booking/records.js:69-81`) | filters `booking_order` by `rentable_id`; no index starts with it                                       | `(rentable_id, created_at DESC)`                      |
| Review totals trigger (M0018:63-86)                | runs on **every booking state update**, recounts reviews per listing; `review.rentable_id` has no index | partial index on published customer reviews           |
| Discovery cursor (`db/discovery.js:44-59`)         | `status='live' AND id > cursor ORDER BY id`                                                             | partial index `(id) WHERE status='live'`              |
| Payment investigation (`investigation.js:55-57`)   | JSON field lookup                                                                                       | expression index on `(redacted_payload->>'orderId')`  |
| Export worker (`admin/audit-browser.js:488-491`)   | `ORDER BY created_at` but the index is `(state, updated_at)`; expiry purge has no index                 | partial indexes                                       |
| Privacy worker (`privacy-fulfillment.js:543-545`)  | expiry purge has no index                                                                               | partial index                                         |
| Refund worker (`refunds.js:66-70`)                 | `state='requested'` has no index                                                                        | partial index                                         |

Application-level issue, not a schema issue: with dates, discovery runs `previewBookingQuote` once per candidate listing, 4 at a time (`db/discovery.js:65`). That is the main search cost. It should become one set-based availability query. That is outside this schema plan, but it matters more than any index here.

Scale note: at today's volume (123 listings, 49 bookings), none of this is slow. The FK and worker indexes are there so growth does not turn into outages. Trigram indexes for the `ILIKE '%term%'` search are **not** proposed yet. Add them when there are thousands of listings.

### 13.3 `audit_log` growth

`audit_log` is append-only, and triggers block truncation (M0039:25-35). It grows with traffic, not only with changes, because it records read events (`document_viewed`, `audit_search_read` and others) and every OTP login (`auth/actions.js:77,106`). Plan for it now, act later:

- When it passes about 5 to 10 million rows, convert it to a range-partitioned table on `at`, by month. Old partitions can then be detached and archived by the migration role. The append-only rule still holds for the application.
- Consider whether read events belong in `audit_log` or in a separate access log with a shorter retention.

### 13.4 Security and operations

1. **Separate database roles.** A table owner can run `ALTER TABLE … DISABLE TRIGGER`, which switches off every immutability and append-only guarantee in this schema. Run migrations as the owner role. Run the API and worker as a role that has only `SELECT`, `INSERT`, `UPDATE` and `DELETE`: no `TRUNCATE`, no DDL, not the owner. On Neon, create a `rentra_app` role and point `DATABASE_URL` at it for the app. This is the most important production-readiness item in this document.
2. **Schema drift.** The live database lacks `operational_incident` and `operational_incident_event` (M0040, journal entry at `drizzle/meta/_journal.json:289`). Check the migrations table and apply 0040 before anything else.
3. **Plain-text personal data.**
   - `otp_token.request_ip`: hash it, or remove it in Phase 9.
   - `notification_outbox.recipient`: phone number. Apply the archive rule.
   - `client_application.residential_address` and `consent_ip`: these are legal evidence, so keep them, but include them in the privacy export and erasure rules.
   - `audit_log.ip`: needed for audit.
4. **Admin secrets.** Check that `admin_user.totp_secret` and `enrollment_secret` are stored encrypted (`services/auth/admin-crypto.js`). If they are not, encrypt them the way `customer_payment_method.token_ciphertext` is.
5. **Stale documentation.** Update `docs/MIGRATION.md` "The shared schema". The frontend no longer has a schema copy.

### 13.5 Naming and data types

- **`"user"` is a reserved word.** Unquoted `SELECT * FROM user` returns the current database role, not the table. That is a quiet bug waiting to happen in hand-written SQL. Renaming it to `app_user`, with a compatibility view, is optional (Phase 8). The benefit is real but small, and the rename touches many raw SQL strings.
- **Mixed vocabulary.**
  - The user role is `client`, but actor columns say `owner`.
  - `support_request.property_id` and `dispute_case.visit_id` point to `rentable` and `booking`.
  - `dispute_case.owner_id` points to a client.
    Do not rename the existing CHECK values: that would mean rewriting triggers for little gain. Do use `client_id`, `rentable_id` and `booking_id` for all new columns, and write the mapping (owner = client, visit = booking, property = rentable) into `docs/ARCHITECTURE.md`.
- **Enum versus varchar with CHECK.** Older tables use `pgEnum`; newer tables use `varchar` with `CHECK IN (…)`. No document explains the mix. Recommend `varchar` + CHECK for new work: a CHECK can drop values and can change inside a transaction. Do not convert existing enums; that is churn with no gain.
- **Missing CHECKs:** `customer_otp_challenge.purpose` and `delivery_mode`, and `customer_auth_rate.kind`, accept any string. Add CHECKs (Phase 1).
- **Phone lengths:** `customer_otp_challenge.phone` is `varchar(10)`; phones elsewhere are `varchar(15)`. Standardise on `varchar(15)` in the new OTP table.
- **`real` columns:** `rentable.rating_avg`, `user.response_rate`, `rentable.farm_size`, `verification_visit.geo_lat` and `geo_lng`. These are acceptable for display values. The visit GPS point would be more consistent as `geometry(Point, 4326)`, like `rentable.location`, but that is low priority.
- **UUID keys:** random v4 UUIDs are fine at this scale. For high-insert append tables (`audit_log`, `notification_outbox`, `client_update`), switch to time-ordered UUIDv7 generation later, to keep B-tree inserts local. Postgres 18 has `uuidv7()`; otherwise generate them in the app.

---

## 14. Merges considered and rejected

Rule applied: merge only when it removes a duplicated fact or a real inconsistency. Similar-looking columns are not a reason.

| Candidate                                                                                                  | Why rejected                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_user` into `user`                                                                                   | Different credentials, no self-signup, a separate cookie, 27 FKs that prove "is an admin", and `permissions IS NULL` meaning full access. Full analysis in §4.8.                                                                                                              |
| `client_staff` into `user`                                                                                 | A caretaker is a delegated sub-principal of one owner, with grants per property. Making it a `user` role would need a membership table and would change the portal auth model, for 12 rows.                                                                                   |
| Customer and client rows into one row per human                                                            | See §4.2. It changes the meaning of every FK to `user` and every role filter and trigger.                                                                                                                                                                                     |
| `client_application` into `user`                                                                           | It is a workflow record with its own review lifecycle, version, assignee, strikes and decision. Different lifecycle from the account.                                                                                                                                         |
| `booking` into `booking_order`                                                                             | Order is the checkout; booking is one of 1 to 10 visits. Different granularity.                                                                                                                                                                                               |
| `booking_quote` into `booking_order`                                                                       | A quote is a priced intent that expires. Most quotes never become orders (121 quotes, 15 orders).                                                                                                                                                                             |
| `booking_case`, `dispute_case`, `support_request`, `visit_incident`, `review_report` into one `case` table | Each has different states, outcomes, participants and CHECK invariants, all enforced by per-table scope and immutability triggers. One table would need a very large per-type CHECK and nullable FKs for every kind of subject. If admins need one inbox, add a view (§15.4). |
| The `*_message` and `*_attachment` tables into shared tables                                               | Same columns, different parents. A shared table needs a polymorphic parent without an FK, which is exactly the problem §11 removes from `document`.                                                                                                                           |
| `payment_event_job`, `payment_execution`, `refund_execution` into their parents                            | The parents are frozen by trigger. These tables hold the changing lease and poll state, so the ledger rows stay immutable and do not churn.                                                                                                                                   |
| `payment_order`, `payment_attempt`, `payment_transaction` into one table                                   | Ledger semantics: one order, several attempts, each with an authorisation and a capture fact.                                                                                                                                                                                 |
| `customer_privacy_request` + `privacy_job`, and `listing_submission` + `listing_review`                    | Request versus worker state; immutable submission versus decision. Same pattern as the payment side tables.                                                                                                                                                                   |
| `content_draft` + `content_publication`                                                                    | A mutable working copy versus an append-only published history.                                                                                                                                                                                                               |
| `booking_lifecycle_event` into `audit_log`                                                                 | It drives notifications and the client inbox through triggers, with once-per-kind uniqueness (`booking_lifecycle_once_idx`).                                                                                                                                                  |
| `customer_favourite_merge` into `customer_favourite`                                                       | It stores receipts for entries that were removed, so a replayed merge cannot bring them back.                                                                                                                                                                                 |
| `rentable_price` into `booking_price_override`                                                             | A base weekly rate versus a date exception. Different concepts.                                                                                                                                                                                                               |
| Amenity labels into an i18n table; city, area and category into enums                                      | Three fixed languages do not need an i18n table. The catalogue is admin-editable and drives SEO routes, so it must stay in tables.                                                                                                                                            |

---

## 15. Final schema

Tables not listed in 15.2 are unchanged, apart from the indexes and CHECKs in 15.3. Their definitions stay as in `src/services/db/schema/index.js`.

### 15.1 Final table list (73)

- **Identity (10):** `user`, `role`, `admin_user`, `client_application`, `client_staff`, `staff_invitation`, `staff_property`, `auth_session`, `otp_challenge`, `auth_rate_event`.
- **Catalogue (12):** `city`, `area`, `category`, `amenity`, `rentable`, `rentable_amenity`, `rentable_price`, `listing_submission`, `listing_review`, `verification_visit`, `document`, `redirect`.
- **Booking (13):** `booking_quote`, `booking_order`, `booking`, `availability`, `booking_price_override`, `inventory_reservation`, `booking_cancellation`, `booking_lifecycle_event`, `booking_case`, `booking_case_update`, `booking_case_visit`, `customer_favourite`, `customer_favourite_merge`.
- **Payments (14):** `payment_gateway_config`, `payment_order`, `payment_execution`, `payment_attempt`, `payment_transaction`, `payment_allocation`, `payment_event`, `payment_event_job`, `refund`, `refund_allocation`, `refund_execution`, `customer_payment_method`, `payout`, `payout_destination`.
- **Cases and evidence (14):** `support_request`, `support_message`, `support_attachment`, `dispute_case`, `dispute_message`, `dispute_attachment`, `visit_evidence`, `visit_evidence_correction`, `visit_incident`, `visit_attachment`, `review`, `review_report`, `notification_outbox`, `client_update`.
- **Platform (10):** `audit_log`, `customer_privacy_request`, `privacy_job`, `admin_export_job`, `content_draft`, `content_publication`, `customer_measurement`, `service_health`, `operational_incident`, `operational_incident_event`.
- **Views (2, plus 2 optional):** `captured_payment_allocation`, `public_customer_review`, and optionally `admin_work_queue` (§15.4) and `principal` (§4.8).

### 15.2 DDL for changed tables

This is the target state. Section 17 shows how to reach it step by step; do not run this block directly.

```sql
-- ============ user ============
CREATE TABLE "user" (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role                    varchar(16) NOT NULL REFERENCES role(code) ON UPDATE RESTRICT,  -- §4.7
  phone                   varchar(15),
  email                   varchar(254),
  name                    varchar(160),
  email_verified_at       timestamptz,
  phone_verified_at       timestamptz,
  account_status          account_status NOT NULL DEFAULT 'pending_application',
  preferred_locale        varchar(5)  NOT NULL DEFAULT 'en',
  -- profile (from customer_profile; usable by both roles)
  photo_public_id         text,
  marketing_consent       boolean     NOT NULL DEFAULT false,
  consent_updated_at      timestamptz,
  profile_completed_at    timestamptz,             -- replaces "customer_profile row exists"
  profile_version         integer     NOT NULL DEFAULT 1,  -- self-service edit token
  -- client only
  client_type             client_type,
  kyc_status              kyc_status  NOT NULL DEFAULT 'none',
  muted_update_categories jsonb       NOT NULL DEFAULT '[]',  -- from client_update_preference
  responds_within_mins    integer,
  response_rate           real,
  -- customer only
  privacy_erasure_pending boolean     NOT NULL DEFAULT false,
  privacy_erased_at       timestamptz,
  -- admin lifecycle
  lifecycle_version       integer     NOT NULL DEFAULT 1,
  last_login_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_client_fields_chk CHECK (role = 'client' OR (
    client_type IS NULL AND kyc_status = 'none' AND muted_update_categories = '[]'::jsonb
    AND responds_within_mins IS NULL AND response_rate IS NULL)),
  CONSTRAINT user_customer_fields_chk CHECK (role = 'customer' OR (
    privacy_erasure_pending = false AND privacy_erased_at IS NULL)),
  CONSTRAINT user_muted_shape_chk CHECK (jsonb_typeof(muted_update_categories) = 'array'),
  CONSTRAINT user_versions_chk CHECK (profile_version > 0 AND lifecycle_version > 0)
);
CREATE UNIQUE INDEX user_phone_role_idx    ON "user" (phone, role);
CREATE UNIQUE INDEX user_email_role_idx    ON "user" (email, role);
CREATE UNIQUE INDEX user_email_role_ci_idx ON "user" (lower(email), role);
CREATE INDEX        user_status_idx        ON "user" (role, account_status);
-- removed: person_id, payout_upi_id, payout_bank_ref, user_person_idx

-- ============ client_application (slim) ============
-- removed: kyc_ref, kyc_verified_at, payout_upi_id, payout_account_ref,
--          payout_ifsc, payout_holder_name, payout_name_match
-- all other columns and indexes unchanged

-- ============ auth_session (was portal_session + customer_session) ============
CREATE TABLE auth_session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES "user"(id)       ON DELETE CASCADE,
  admin_id    uuid REFERENCES admin_user(id)   ON DELETE CASCADE,
  staff_id    uuid REFERENCES client_staff(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CONSTRAINT auth_session_principal_chk CHECK (num_nonnulls(user_id, admin_id, staff_id) = 1),
  CONSTRAINT auth_session_window_chk CHECK (expires_at > created_at)
);
CREATE INDEX auth_session_user_idx  ON auth_session (user_id)  WHERE user_id  IS NOT NULL;
CREATE INDEX auth_session_admin_idx ON auth_session (admin_id) WHERE admin_id IS NOT NULL;
CREATE INDEX auth_session_staff_idx ON auth_session (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX auth_session_purge_idx ON auth_session (expires_at);

-- ============ otp_challenge (Phase 9; replaces otp_token + customer_otp_challenge) ============
CREATE TABLE otp_challenge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_kind  varchar(10) NOT NULL,          -- customer | client | staff
  channel         varchar(8)  NOT NULL,          -- sms | email
  purpose         varchar(16) NOT NULL,          -- login | verify_phone | phone_change
  identifier      varchar(254) NOT NULL,         -- normalised phone (E.164) or lower(email)
  code_hash       varchar(64) NOT NULL,
  browser_hash    varchar(64),
  delivery_mode   varchar(16) NOT NULL,
  delivered       boolean     NOT NULL DEFAULT false,
  attempts        integer     NOT NULL DEFAULT 0,
  user_id         uuid REFERENCES "user"(id) ON DELETE CASCADE,  -- binding for phone_change
  session_id      uuid,
  original_phone  varchar(15),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenge_valid_chk CHECK (
    principal_kind IN ('customer','client','staff') AND channel IN ('sms','email')
    AND purpose IN ('login','verify_phone','phone_change') AND attempts >= 0
    AND code_hash ~ '^[a-f0-9]{64}$' AND expires_at > created_at
    AND (purpose <> 'phone_change' OR (user_id IS NOT NULL AND session_id IS NOT NULL)))
);
CREATE INDEX otp_challenge_lookup_idx ON otp_challenge (principal_kind, identifier, purpose, created_at);
CREATE INDEX otp_challenge_user_idx   ON otp_challenge (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX otp_challenge_purge_idx  ON otp_challenge (created_at);

-- ============ auth_rate_event (was customer_auth_rate) ============
ALTER TABLE customer_auth_rate RENAME TO auth_rate_event;
ALTER TABLE auth_rate_event RENAME COLUMN phone_hash TO identifier_hash;
ALTER TABLE auth_rate_event ADD COLUMN principal_kind varchar(10) NOT NULL DEFAULT 'customer';
ALTER TABLE auth_rate_event ADD CONSTRAINT auth_rate_event_valid_chk CHECK (
  principal_kind IN ('customer','client','staff') AND kind IN ('request','verify')
  AND identifier_hash ~ '^[a-f0-9]{64}$' AND ip_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX auth_rate_event_purge_idx ON auth_rate_event (created_at);
-- existing (hash, kind, created_at) indexes kept; add principal_kind as a leading column in Phase 9

-- ============ rentable (changed columns only) ============
-- removed: amenities, approved_snapshot, deposit_amount, extra_guest_charge, requires_operator
--   deposit_minor            bigint NOT NULL DEFAULT 0
--   extra_guest_charge_minor bigint NOT NULL DEFAULT 0
--   CHECK (deposit_minor BETWEEN 0 AND 9007199254740991
--          AND extra_guest_charge_minor BETWEEN 0 AND 9007199254740991)
--   FOREIGN KEY (area_id, city_id) REFERENCES area (id, city_id)

-- ============ rentable_price ============
CREATE TABLE rentable_price (
  rentable_id    uuid NOT NULL REFERENCES rentable(id) ON DELETE CASCADE,
  slot           booking_slot NOT NULL,
  weekday_minor  bigint NOT NULL,
  weekend_minor  bigint NOT NULL,
  PRIMARY KEY (rentable_id, slot),
  CONSTRAINT rentable_price_amount_chk CHECK (
    weekday_minor BETWEEN 0 AND 9007199254740991 AND weekend_minor BETWEEN 0 AND 9007199254740991)
);

-- ============ availability (narrowed to the open-date calendar) ============
CREATE TABLE availability (
  rentable_id      uuid NOT NULL REFERENCES rentable(id) ON DELETE CASCADE,
  day              date NOT NULL,
  slot             availability_slot NOT NULL,
  units_available  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (rentable_id, day, slot),
  CONSTRAINT availability_units_chk CHECK (units_available >= 0)
);
CREATE INDEX availability_day_idx ON availability (day, slot);
-- removed: price_override (to booking_price_override), blocked_by_client (to inventory_reservation)

-- ============ booking (legacy copy removed) ============
CREATE TABLE booking (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             varchar(16) NOT NULL UNIQUE,
  order_id              uuid NOT NULL,
  item_position         integer NOT NULL,
  rentable_id           uuid NOT NULL REFERENCES rentable(id) ON DELETE RESTRICT,
  customer_id           uuid NOT NULL REFERENCES "user"(id)  ON DELETE RESTRICT,
  currency              varchar(3)  NOT NULL,
  time_zone             varchar(64) NOT NULL,
  local_day             date NOT NULL,
  slot                  booking_slot NOT NULL,
  starts_at             timestamptz,
  ends_at               timestamptz,
  blocked_start_at      timestamptz,
  blocked_end_at        timestamptz,
  hours_known           boolean NOT NULL DEFAULT false,
  units_booked          integer NOT NULL DEFAULT 1,
  guests                integer NOT NULL DEFAULT 1,
  amount_rent_minor     bigint NOT NULL,
  amount_fee_minor      bigint NOT NULL,
  amount_deposit_minor  bigint NOT NULL,
  amount_advance_minor  bigint,
  collected_minor       bigint NOT NULL DEFAULT 0,
  payment_mode          payment_mode     NOT NULL DEFAULT 'legacy_unknown',
  visit_provenance      visit_provenance NOT NULL DEFAULT 'legacy_unknown',
  slot_snapshot         jsonb,
  state                 booking_state NOT NULL DEFAULT 'requested',
  contact_phone         varchar(15),
  note                  text,
  confirmed_at          timestamptz,
  cancelled_at          timestamptz,
  cancelled_by_kind     varchar(16),   -- customer | client | admin | system, CHECK below
  cancellation_reason   text,
  lifecycle_version     integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_order_scope_fk FOREIGN KEY (order_id, customer_id, rentable_id, currency, time_zone)
    REFERENCES booking_order (id, customer_id, rentable_id, currency, time_zone),
  CONSTRAINT booking_order_visit_chk CHECK (item_position BETWEEN 1 AND 10 AND guests > 0 AND units_booked = 1),
  CONSTRAINT booking_collected_requires_real_chk CHECK (collected_minor = 0 OR payment_mode = 'real'),
  CONSTRAINT booking_minor_amounts_nonnegative_chk CHECK (
    amount_rent_minor BETWEEN 0 AND 9007199254740991 AND amount_fee_minor BETWEEN 0 AND 9007199254740991
    AND amount_deposit_minor BETWEEN 0 AND 9007199254740991
    AND (amount_advance_minor IS NULL OR amount_advance_minor BETWEEN 0 AND 9007199254740991)
    AND collected_minor BETWEEN 0 AND 9007199254740991)
  -- booking_known_hours_have_interval_chk unchanged
);
CREATE UNIQUE INDEX booking_id_rentable_idx         ON booking (id, rentable_id);
CREATE UNIQUE INDEX booking_order_position_idx      ON booking (order_id, item_position);
CREATE UNIQUE INDEX booking_order_localday_slot_idx ON booking (order_id, local_day, slot);
CREATE INDEX booking_rentable_day_idx ON booking (rentable_id, local_day);   -- was (rentable_id, day)
CREATE INDEX booking_customer_idx     ON booking (customer_id, state);
-- removed columns: day, amount_rent, amount_fee, amount_deposit, amount_advance_paid,
--   balance_mode*, balance_settled_at*, check_in_code*, accept_deadline,
--   listing_snapshot, policy_snapshot, price_snapshot, pricing_version, policy_version,
--   legacy_advance_reported_minor, backfill_version, backfilled_at
--   (* only if not on the roadmap, see section 18)

-- ============ payout ============
CREATE TABLE payout (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id             uuid NOT NULL REFERENCES booking(id) ON DELETE RESTRICT,
  client_id              uuid NOT NULL REFERENCES "user"(id)  ON DELETE RESTRICT,
  destination_id         uuid REFERENCES payout_destination(id) ON DELETE RESTRICT,
  funding_allocation_id  uuid REFERENCES payment_allocation(id) ON DELETE RESTRICT,
  gross_minor            bigint NOT NULL,
  commission_minor       bigint NOT NULL,
  tds_194o_minor         bigint NOT NULL DEFAULT 0,
  gst_tcs_minor          bigint NOT NULL DEFAULT 0,
  net_minor              bigint NOT NULL,
  actual_net_minor       bigint NOT NULL DEFAULT 0,
  status                 payout_status NOT NULL DEFAULT 'pending',
  utr                    varchar(64),
  settled_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_amounts_chk CHECK (
    gross_minor BETWEEN 0 AND 9007199254740991 AND commission_minor >= 0
    AND tds_194o_minor >= 0 AND gst_tcs_minor >= 0 AND net_minor BETWEEN 0 AND gross_minor),
  CONSTRAINT payout_actual_funding_chk CHECK (
    actual_net_minor BETWEEN 0 AND 9007199254740991 AND (actual_net_minor = 0 OR funding_allocation_id IS NOT NULL))
);
CREATE INDEX        payout_client_status_idx     ON payout (client_id, status);
CREATE INDEX        payout_booking_idx           ON payout (booking_id);
CREATE INDEX        payout_destination_fk_idx    ON payout (destination_id) WHERE destination_id IS NOT NULL;
CREATE UNIQUE INDEX payout_funding_allocation_idx ON payout (funding_allocation_id);

-- ============ document (real owner FKs, history kept) ============
ALTER TABLE document
  ADD COLUMN application_id uuid GENERATED ALWAYS AS
    (CASE WHEN owner_type = 'client_application' THEN owner_id END) STORED,
  ADD COLUMN rentable_id uuid GENERATED ALWAYS AS
    (CASE WHEN owner_type = 'rentable' THEN owner_id END) STORED;
ALTER TABLE document
  ADD CONSTRAINT document_application_fk FOREIGN KEY (application_id) REFERENCES client_application(id) ON DELETE RESTRICT,
  ADD CONSTRAINT document_rentable_fk    FOREIGN KEY (rentable_id)    REFERENCES rentable(id)           ON DELETE RESTRICT,
  ADD CONSTRAINT document_owner_chk CHECK (num_nonnulls(application_id, rentable_id) = 1);
DROP INDEX document_slot_idx;
CREATE UNIQUE INDEX document_live_slot_idx ON document (owner_type, owner_id, doc_type, side)
  WHERE status IN ('uploaded', 'accepted');
CREATE INDEX document_application_idx ON document (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX document_rentable_idx    ON document (rentable_id)    WHERE rentable_id    IS NOT NULL;
```

### 15.3 Index and constraint additions for unchanged tables

```sql
-- FK coverage
CREATE INDEX booking_order_rentable_idx     ON booking_order (rentable_id, created_at DESC);
CREATE INDEX booking_order_quote_idx        ON booking_order (quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX booking_quote_customer_idx     ON booking_quote (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX booking_quote_rentable_idx     ON booking_quote (rentable_id);
CREATE INDEX review_rentable_public_idx     ON review (rentable_id)
  WHERE author_role = 'customer' AND moderation_state = 'published';
CREATE INDEX review_author_idx              ON review (author_id);
CREATE INDEX refund_allocation_booking_idx  ON refund_allocation (booking_id);
CREATE INDEX notification_order_idx         ON notification_outbox (order_id);
CREATE INDEX notification_booking_idx       ON notification_outbox (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX support_request_order_idx      ON support_request (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX support_request_property_idx   ON support_request (property_id) WHERE property_id IS NOT NULL;
CREATE INDEX support_request_assignee_idx   ON support_request (assigned_to, state) WHERE assigned_to IS NOT NULL;
CREATE INDEX support_request_privacy_idx    ON support_request (privacy_request_id) WHERE privacy_request_id IS NOT NULL;
CREATE INDEX dispute_case_order_idx         ON dispute_case (order_id);
CREATE INDEX dispute_case_visit_idx         ON dispute_case (visit_id);
CREATE INDEX customer_otp_customer_idx      ON customer_otp_challenge (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX payment_method_customer_idx    ON customer_payment_method (customer_id);
CREATE INDEX client_update_rentable_idx     ON client_update (rentable_id) WHERE rentable_id IS NOT NULL;
CREATE INDEX client_update_order_idx        ON client_update (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX rentable_category_idx          ON rentable (category_id);
CREATE INDEX rentable_amenity_amenity_idx   ON rentable_amenity (amenity_id);

-- Hot paths and workers
CREATE INDEX rentable_location_geog_idx     ON rentable USING gist ((location::geography));
CREATE INDEX rentable_live_cursor_idx       ON rentable (id) WHERE status = 'live';
CREATE INDEX payment_event_order_ref_idx    ON payment_event ((redacted_payload->>'orderId'));
CREATE INDEX refund_requested_idx           ON refund (created_at) WHERE state = 'requested';
CREATE INDEX admin_export_queue_idx         ON admin_export_job (created_at, id) WHERE state = 'queued';
CREATE INDEX admin_export_artifact_exp_idx  ON admin_export_job (expires_at) WHERE artifact_ciphertext IS NOT NULL;
CREATE INDEX privacy_job_artifact_exp_idx   ON privacy_job (expires_at) WHERE artifact_ciphertext IS NOT NULL;
CREATE INDEX otp_token_purge_idx            ON otp_token (created_at);
CREATE INDEX customer_otp_purge_idx         ON customer_otp_challenge (created_at);
CREATE INDEX customer_auth_rate_purge_idx   ON customer_auth_rate (created_at);

-- Integrity
CREATE UNIQUE INDEX area_id_city_idx ON area (id, city_id);
ALTER TABLE rentable ADD CONSTRAINT rentable_area_city_fk
  FOREIGN KEY (area_id, city_id) REFERENCES area (id, city_id) NOT VALID;
ALTER TABLE rentable VALIDATE CONSTRAINT rentable_area_city_fk;

ALTER TABLE customer_otp_challenge ADD CONSTRAINT customer_otp_challenge_valid_chk
  CHECK (purpose IN ('login','phone_change') AND attempts >= 0) NOT VALID;
ALTER TABLE customer_otp_challenge VALIDATE CONSTRAINT customer_otp_challenge_valid_chk;
-- add delivery_mode IN (...) with the exact values from services/auth/customer-delivery.js

ALTER TABLE customer_auth_rate ADD CONSTRAINT customer_auth_rate_kind_chk
  CHECK (kind IN ('request','verify')) NOT VALID;
ALTER TABLE customer_auth_rate VALIDATE CONSTRAINT customer_auth_rate_kind_chk;

CREATE UNIQUE INDEX user_email_role_ci_idx ON "user" (lower(email), role);
```

All tables are small today, so a plain `CREATE INDEX` inside a Drizzle migration takes milliseconds. When a table passes about a million rows, create new indexes with `CREATE INDEX CONCURRENTLY`, outside a transaction, in a separate migration step.

### 15.4 Optional unified admin queue (view)

```sql
CREATE VIEW admin_work_queue AS
  SELECT 'support'::text  AS kind, id, reference, state, assigned_to AS assignee_id, created_at, updated_at
    FROM support_request WHERE state <> 'resolved'
  UNION ALL
  SELECT 'booking_case', id, reference, state, assignee_id, created_at, updated_at
    FROM booking_case WHERE state = 'open'
  UNION ALL
  SELECT 'dispute', id, NULL, state, assignee_id, created_at, updated_at
    FROM dispute_case WHERE state = 'open'
  UNION ALL
  SELECT 'incident', id, reference, state, NULL, created_at, updated_at
    FROM visit_incident WHERE state = 'open'
  UNION ALL
  SELECT 'review_report', id, NULL, state, NULL, created_at, created_at
    FROM review_report WHERE state = 'open';
```

---

## 16. Relationship map (after)

```
GEOGRAPHY & CATALOGUE
city 1──* area 1──* rentable *──1 category          rentable(area_id, city_id) ──> area(id, city_id)
amenity 1──* rentable_amenity *──1 rentable
rentable 1──* rentable_price            (base rate per slot, paise)
rentable 1──* booking_price_override    (date exception, paise)
rentable 1──* availability              (open-date calendar)
rentable 1──* listing_submission 1──0..1 listing_review
rentable 1──* verification_visit *──0..1 listing_submission
rentable.published_submission_id ──> listing_submission
document ──> client_application | rentable   (exactly one, real FKs)

IDENTITY
user(role=client) 1──1 client_application
user(role=client) 1──* rentable, payout_destination, client_staff, client_update
client_staff 1──* staff_invitation ;  client_staff *──* rentable (staff_property)
auth_session ──> exactly one of user | admin_user | client_staff
otp_challenge ──> user (phone_change binding only)

BOOKING
user(role=customer) 1──* booking_quote 0..1──* booking_order 1──1..10 booking (visit)
booking(order_id, customer_id, rentable_id, currency, time_zone) ──> booking_order(same)
booking 1──0..1 inventory_reservation (active; GiST exclusion per rentable)
rentable 1──* inventory_reservation (owner_block, booking_id NULL)
booking_order 1──* booking_lifecycle_event ──trigger──> notification_outbox, client_update
booking_order 1──* booking_cancellation ; booking_order 1──* booking_case *──* booking (booking_case_visit)
booking 1──* visit_evidence 1──* visit_evidence_correction ; booking 1──* visit_incident
visit_attachment ──> visit_evidence | visit_incident (exactly one)

MONEY (append-only, trigger-frozen)
booking_order 1──* payment_order 1──1 payment_execution ──> payment_gateway_config(version)
payment_order 1──* payment_attempt 1──* payment_transaction 1──* payment_allocation *──1 booking
payment_transaction 1──* refund 1──1 refund_execution ; refund 1──* refund_allocation *──1 payment_allocation
payment_event 1──1 payment_event_job (deleted when processed)
booking 1──* payout *──1 payout_destination ; payout 0..1──1 payment_allocation (funding)

CASES
support_request 1──* support_message 1──* support_attachment   (customer XOR client)
dispute_case(order, visit, owner, customer) 1──* dispute_message 1──* dispute_attachment
review ──> booking, rentable, user ; review 1──* review_report

PLATFORM
audit_log (no FKs by design: must outlive what it describes)
customer_privacy_request 1──1 privacy_job ; admin_user 1──* admin_export_job
content_draft (mutable) ── content_publication (append-only)
```

---

## 17. Migration plan

### 17.1 Rules for every phase

These follow `docs/ARCHITECTURE.md` §6-7 and the project's hosted-database caution.

1. **Rehearse on a Neon branch first.** Create a branch from production, run the phase's migration and the test suite against it, and run the verification queries. Only then run it on the main branch.
2. **Checkpoint before every destructive step.** Before any `DROP`, create a named Neon branch as a restore point (for example `pre-phase-6`). Neon point-in-time restore is the fallback.
3. **Forward-only Drizzle migrations.** Never edit applied SQL. Update `schema/index.js` in the same change. Put rollback SQL in `docs/rollback/phase-N.sql`, never in `drizzle/`.
4. **Expand, migrate, contract.**
   - _Expand:_ add new structures. Old code keeps working.
   - _Migrate:_ deploy code that uses the new structures, and move the data.
   - _Contract:_ drop the old structures, in a **separate** later migration, after the new code has run cleanly.
     Rollback before contract means redeploying the previous code. Rollback after contract means restoring the checkpoint branch.
5. **Do not mass-update trigger-guarded tables.** `rentable`, `rentable_price`, `rentable_amenity` and `document` bump listing versions. `payout`, `payment_*` and `refund*` raise errors. Use generated columns and `ALTER TABLE` as shown below.
6. **Apply explicitly.** Run `npm run db:check`, lint and tests, then `npm run db:migrate` during deploy. The app never migrates on start.
7. **Update the seeds in the same phase as the schema.** `seed.js`, `seed-owner-listings.js` and `seed-gujarat-partners.js` write many of the columns being removed.

### Phase 0: preparation (no schema change)

1. Confirm the migration state. Check the journal table used by `src/scripts/migrate.js`, then apply 0040 so the live database matches the schema file.
2. Run every query in Appendix A. Save the output with the phase notes.
3. Create the `rentra_app` role (§13.4 item 1). Grant DML on all tables and `USAGE` on sequences. Switch the API and worker `DATABASE_URL` to it. Keep the owner role for `db:migrate`.
4. Answer the questions in section 18.

**Verification:** API smoke test (`npm run smoke`) passes with the new role. A test `ALTER TABLE` as `rentra_app` fails.

### Phase 1: additive safety (no behaviour change)

**Migration `0041_indexes_constraints.sql`:** everything in §15.3.

**Code:**

- New hourly retention job in `src/cron/jobs.js`, with the rules from §13.1. `payment_event_job` is handled separately below.
- `payments/webhooks.js:78-82`: when the event reaches `processed`, `DELETE FROM payment_event_job WHERE event_id = …` instead of rescheduling it. Keep rescheduling for `failed`, with an attempts cap (for example 20, then leave it for manual review).
- One-off cleanup inside the migration: `DELETE FROM payment_event_job j USING payment_event e WHERE e.id = j.event_id AND e.state = 'processed';`

**Verification:**

- `EXPLAIN` on `getListingsNearby` shows `rentable_location_geog_idx`.
- `EXPLAIN` on the webhook claim query shows no scan of processed rows.
- The retention job logs its row counts.

**Rollback:** drop the new indexes and constraints. They are all additive.

### Phase 2: remove dead objects

**Code first** (deploy before the migration):

- Delete `domain/booking-legacy.js`.
- Remove `personId` from `dal.js:49`, and the `person_id = NULL` in `privacy-fulfillment.js:466`.
- Remove the `person` inserts from the seeds and `unit` from the truncate list (`seed.js:75`).
- Remove `accept_deadline`, `backfill_*` and `legacy_advance_reported_minor` from the schema file.

**Migration `0042_drop_dead.sql`** (contract):

```sql
DROP INDEX IF EXISTS booking_state_deadline_idx, booking_backfill_idx, booking_order_idx, user_person_idx;
ALTER TABLE booking DROP COLUMN accept_deadline,
                    DROP COLUMN legacy_advance_reported_minor,
                    DROP COLUMN backfill_version,
                    DROP COLUMN backfilled_at;
ALTER TABLE "user" DROP COLUMN person_id;
ALTER TABLE client_application DROP COLUMN kyc_ref, DROP COLUMN kyc_verified_at;
DROP TABLE unit;
DROP TABLE person;
```

`ALTER TABLE … DROP COLUMN` does not fire row triggers. The `to_jsonb` comparisons in `checkout_terms` and similar triggers keep working, because they compare whole rows.

**Pre-check:** A.8 (whether any `person_id` is set; if so, the data is seed-only per §4.3).

**Rollback:** restore the checkpoint branch. Unused structures lose no data that the application ever read.

### Phase 3: identity consolidation

**3a0. Role lookup table.** Apply the migration in §4.7. Verify: `SELECT role, count(*) FROM "user" GROUP BY 1` returns the same counts as before, customer and client login both work, and `public_customer_review` returns the same rows.

**3a. Expand: `0043_user_profile.sql`**

```sql
ALTER TABLE "user"
  ADD COLUMN photo_public_id text,
  ADD COLUMN marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN consent_updated_at timestamptz,
  ADD COLUMN profile_completed_at timestamptz,
  ADD COLUMN profile_version integer NOT NULL DEFAULT 1,
  ADD COLUMN muted_update_categories jsonb NOT NULL DEFAULT '[]';

UPDATE "user" u SET photo_public_id = p.photo_public_id, marketing_consent = p.marketing_consent,
       consent_updated_at = p.consent_updated_at, profile_completed_at = p.completed_at,
       profile_version = p.version
  FROM customer_profile p WHERE p.user_id = u.id;

UPDATE "user" u SET muted_update_categories = c.muted,
       profile_version = greatest(u.profile_version, c.version)
  FROM client_update_preference c WHERE c.user_id = u.id;

ALTER TABLE "user"
  ADD CONSTRAINT user_client_fields_chk CHECK (role = 'client' OR (client_type IS NULL AND kyc_status = 'none'
    AND muted_update_categories = '[]'::jsonb AND responds_within_mins IS NULL AND response_rate IS NULL)) NOT VALID,
  ADD CONSTRAINT user_customer_fields_chk CHECK (role = 'customer' OR (privacy_erasure_pending = false
    AND privacy_erased_at IS NULL)) NOT VALID,
  ADD CONSTRAINT user_muted_shape_chk CHECK (jsonb_typeof(muted_update_categories) = 'array');
ALTER TABLE "user" VALIDATE CONSTRAINT user_client_fields_chk;
ALTER TABLE "user" VALIDATE CONSTRAINT user_customer_fields_chk;
```

The `UPDATE` on `user` changes only profile columns. The session revocation triggers react only to role, status and email changes (M0011:36-47, M0024:11-39), so no session is revoked. Confirm this on the rehearsal branch.

Pre-check A.7 must return zero rows, or `VALIDATE` fails.

**3b. Code switch.**

- Files that read or write `customer_profile`: `customer/account.js:33-45`, `customer/photo.js:34`, `admin/customers.js:389`, `privacy-fulfillment.js:316,375,444,454`. Onboarding done becomes `profile_completed_at IS NOT NULL` (`customer-actions.js:62-64`).
- Files that use `client_update_preference`: `auth/client-inbox.js:84-116`.
- New migration that replaces the function `client_update_insert()` (M0030:34-39) so it reads `"user".muted_update_categories`.

**3c. Sessions. Expand: `0044_auth_session.sql`**

```sql
ALTER TABLE portal_session RENAME TO auth_session;
CREATE VIEW portal_session AS SELECT * FROM auth_session;      -- compatibility shim, writable

INSERT INTO auth_session (id, user_id, created_at, expires_at, revoked_at)
  SELECT id, user_id, created_at, expires_at, revoked_at FROM customer_session
  ON CONFLICT (id) DO NOTHING;
```

Then, in the same migration, replace the trigger functions:

- `customer_status_session_revocation` (M0011) now revokes `auth_session` rows of a customer whose role changes or whose status is no longer `active`.
- `revoke_changed_portal_access()` (M0024) keeps its client rule (email change, or a status outside `active` / `pending_application`) and must **not** apply that rule to customer rows. Branch on `NEW.role`.

**Code:**

- `customer-identity.js:93,101,107-118`: issue and validate sessions in `auth_session`. Validation joins `user` and requires `role = 'customer'` and status `active`.
- `admin/customers.js`: revocation.
- `portal-sessions.js`, `recent-auth.js:15`, `admin/operators.js:121,222`: rename to `auth_session`. The view keeps them working until this deploy.

The window between the row copy and the code deploy: a customer who logs in during that window gets a `customer_session` row that the new code does not see, and has to log in again. Rerun the `INSERT … ON CONFLICT DO NOTHING` right after the deploy to close most of that gap.

**3d. Contract: `0045_identity_contract.sql`** (at least one release later)

```sql
DROP TABLE customer_profile;
DROP TABLE client_update_preference;
DROP TABLE customer_session;
DROP VIEW portal_session;
```

**Verification:**

- Customer login, profile edit, photo upload, marketing toggle, privacy export, and admin customer view all work.
- Client inbox mute works.
- Suspending a customer revokes their sessions. Changing a client's email revokes theirs.
- `SELECT count(*) FROM auth_session WHERE user_id IS NOT NULL` equals the old customer plus client session counts.

**Rollback:**

- Before 3d: redeploy the previous code. The old tables still hold the data, stale only for edits made after the deploy.
- After 3d: restore the checkpoint.

### Phase 4: payout details, single source

1. Pre-check A.3. For each client whose payout data exists only in legacy columns, create a `payout_destination` row through the normal settings flow, or record a decision to re-collect.
2. **Code:**
   - `admin/applications.js:36-37,100,138,244`: the approval gate reads `name_check` from the current destination (`state IN ('submitted','verified')`) instead of `payout_name_match`.
   - `profile.js:106-114`: the stepper reads the current destination.
   - `application.js:152-164`: remove the legacy writes; keep `recordOnboardingDestination`.
   - `destinations.js:83-90`: delete `mirrorLegacy`.
3. **Contract migration:**

```sql
ALTER TABLE "user" DROP COLUMN payout_upi_id, DROP COLUMN payout_bank_ref;
ALTER TABLE client_application DROP COLUMN payout_upi_id, DROP COLUMN payout_account_ref,
  DROP COLUMN payout_ifsc, DROP COLUMN payout_holder_name, DROP COLUMN payout_name_match;
```

Also check the body of `client_update_from_audit()` (M0030:47-88) for references to these columns before dropping them.

**Verification:** submit an onboarding payout; the admin approves (and is blocked when `name_check = 'different'`); the settings change creates a new destination version.

### Phase 5: inventory and pricing, single source

1. **Price overrides.** Pre-check A.5.

```sql
INSERT INTO booking_price_override (rentable_id, day, slot, rent_minor)
SELECT rentable_id, day, slot::text::booking_slot, price_override::bigint * 100
  FROM availability WHERE price_override IS NOT NULL
ON CONFLICT (rentable_id, day, slot) DO NOTHING;   -- explicit rows already win in quotes.js
```

2. **Owner blocks.** Write a one-off script, `src/scripts/migrate-legacy-blocks.js`. For each `blocked_by_client` row, inside `withListingInventory`, call `createOwnerBlock` with the interval that `legacyOwnerIntervals()` returns today. Then set `blocked_by_client = false` on that row. Log and skip any row that conflicts with the exclusion constraint. Rerunning the script is safe, because processed rows are no longer flagged.
3. **Verification before the code switch:** for a sample of listings and dates, quotes and calendar output are identical before and after the script. Use `previewBookingQuote` and compare the JSON.
4. **Code:**
   - Remove the legacy override merge (`quotes.js:43-46,88-91,163`).
   - Remove `legacyOwnerIntervals` (`inventory.js:175-196`).
   - Remove the `blocked_by_client` and `price_override` reads in `owner-calendar.js:14-34,72,160-167`, `operations/overview.js:19` and `operations/incidents.js:48`.
   - Remove the `price_override` write in `owner-settings.js:39`.
   - Update the seeds.
   - Delete `db/queries.js:326` `getAvailability`, which has no callers.
5. **Contract:** `ALTER TABLE availability DROP COLUMN price_override, DROP COLUMN blocked_by_client;`

**Rollback:** before contract, redeploy the old code. The old columns are intact and `blocked_by_client` can be restored from the script log.

### Phase 6: booking legacy contraction

1. Pre-check A.1 decides the option.
   - **Option A (seed or test data):** change the seeds to create `booking_order` + `booking` through the checkout path, or with complete order rows. Delete the orderless bookings and their dependants (`payout`, `review` and others), then reseed. This is simple, and it is the right choice when no real customer history is involved.
   - **Option B (real history):** for each orderless booking, in one transaction:

```sql
-- 1. one legacy order per legacy booking
INSERT INTO booking_order (id, reference, customer_id, rentable_id, state, currency, time_zone,
    pricing_version, policy_version, policy_snapshot, listing_snapshot,
    amount_rent_minor, amount_fee_minor, amount_deposit_minor, idempotency_key, request_hash,
    confirmed_at, created_at, updated_at)
SELECT gen_random_uuid(), 'LEGACY-' || b.reference, b.customer_id, b.rentable_id, 'legacy', 'INR', 'Asia/Kolkata',
    'legacy-v1', 'legacy-v1', coalesce(b.policy_snapshot, '{}'), coalesce(b.listing_snapshot, '{}'),
    b.amount_rent::bigint * 100, b.amount_fee::bigint * 100, b.amount_deposit::bigint * 100,
    'legacy:' || b.id, encode(sha256(b.id::text::bytea), 'hex'),
    b.confirmed_at, b.created_at, b.updated_at
  FROM booking b WHERE b.order_id IS NULL;
-- 2. link and fill the visit (join on reference)
UPDATE booking b SET order_id = o.id, item_position = 1, local_day = b.day,
    currency = 'INR', time_zone = 'Asia/Kolkata',
    amount_rent_minor = coalesce(b.amount_rent_minor, b.amount_rent::bigint * 100),
    amount_fee_minor = coalesce(b.amount_fee_minor, b.amount_fee::bigint * 100),
    amount_deposit_minor = coalesce(b.amount_deposit_minor, b.amount_deposit::bigint * 100)
  FROM booking_order o WHERE o.reference = 'LEGACY-' || b.reference AND b.order_id IS NULL;
```

Check that `LEGACY-` plus the reference fits in `booking_order.reference` (varchar 64, fine). Payment and payout-destination triggers do not fire, because legacy rows have no `payment_order` or `payment_execution`. Rehearse on the branch anyway: `visit_transition_proof` and `review_visit_refresh` react to `booking.state`, which this does not change.

2. **Code:**
   - Switch `day` to `local_day` (`booking-cases.js:189,435`, `staff-visits.js:70`, `property-overview.js:59`, `privacy-fulfillment.js:342`).
   - Switch the rupee amounts to `*_minor` (`privacy-fulfillment.js:342`).
   - Switch booking snapshots and versions to the order (`refund-operations.js:48`, `investigation.js:39,148`, `finance/statements.js:254,268`, remove the `coalesce`).
   - `checkout.js:70-81`: stop writing the removed columns.
3. **Tighten** (after the code is deployed):

```sql
ALTER TABLE booking ALTER COLUMN order_id SET NOT NULL, ALTER COLUMN item_position SET NOT NULL,
  ALTER COLUMN local_day SET NOT NULL, ALTER COLUMN currency SET NOT NULL, ALTER COLUMN time_zone SET NOT NULL,
  ALTER COLUMN amount_rent_minor SET NOT NULL, ALTER COLUMN amount_fee_minor SET NOT NULL,
  ALTER COLUMN amount_deposit_minor SET NOT NULL;
ALTER TABLE booking ALTER COLUMN day DROP NOT NULL, ALTER COLUMN amount_rent DROP NOT NULL,
  ALTER COLUMN amount_fee DROP NOT NULL;
DROP INDEX booking_rentable_day_idx;
CREATE INDEX booking_rentable_day_idx ON booking (rentable_id, local_day);
```

4. **Contract** (a later release):

```sql
ALTER TABLE booking DROP COLUMN day, DROP COLUMN amount_rent, DROP COLUMN amount_fee,
  DROP COLUMN amount_deposit, DROP COLUMN amount_advance_paid,
  DROP COLUMN listing_snapshot, DROP COLUMN policy_snapshot, DROP COLUMN price_snapshot,
  DROP COLUMN pricing_version, DROP COLUMN policy_version;
-- only if confirmed off the roadmap (section 18):
ALTER TABLE booking DROP COLUMN balance_mode, DROP COLUMN balance_settled_at, DROP COLUMN check_in_code;
DROP TYPE balance_mode;
```

After dropping `check_in_code` and `balance_settled_at`, replace `rentra_checkout_terms_immutable()` without those names in its `mutable` array. Removing a key that no longer exists is harmless, but keep the function tidy.

**Verification:**

- `SELECT count(*) FROM booking WHERE order_id IS NULL` returns 0.
- The booking history for customer, owner and admin renders.
- The finance statement totals are unchanged.
- The full test suite passes.

### Phase 7: money units to paise

Use the same pattern for each table (shown for `rentable_price`):

```sql
-- 7a expand (no row triggers fire)
ALTER TABLE rentable_price
  ADD COLUMN weekday_minor bigint GENERATED ALWAYS AS (weekday::bigint * 100) STORED,
  ADD COLUMN weekend_minor bigint GENERATED ALWAYS AS (weekend::bigint * 100) STORED;
-- deploy code that READS *_minor and still writes rupees

-- 7b detach (run immediately before deploying code that WRITES *_minor)
ALTER TABLE rentable_price ALTER COLUMN weekday_minor DROP EXPRESSION,
                           ALTER COLUMN weekend_minor DROP EXPRESSION;
ALTER TABLE rentable_price ALTER COLUMN weekday DROP NOT NULL, ALTER COLUMN weekend DROP NOT NULL;
ALTER TABLE rentable_price ALTER COLUMN weekday_minor SET NOT NULL, ALTER COLUMN weekend_minor SET NOT NULL;

-- 7c contract (later release)
ALTER TABLE rentable_price DROP COLUMN weekday, DROP COLUMN weekend;
ALTER TABLE rentable_price ADD CONSTRAINT rentable_price_amount_chk
  CHECK (weekday_minor BETWEEN 0 AND 9007199254740991 AND weekend_minor BETWEEN 0 AND 9007199254740991);
```

Between 7b and the deploy, the old code writes rupees only. An owner price edit in that short window would not reach `*_minor`. Run 7b and the deploy back to back in a quiet period. Before 7c, confirm that `SELECT count(*) FROM rentable_price WHERE weekday IS NOT NULL AND weekday_minor <> weekday * 100` returns 0.

Apply the same steps to:

- `rentable.deposit_amount` → `deposit_minor` and `extra_guest_charge` → `extra_guest_charge_minor`. Readers: `quotes.js:48` and the `legacyRupeesToMinor` call sites. Writers: the listing editor.
- `payout.gross`, `commission`, `tds_194o`, `gst_tcs`, `net` → `*_minor`. Readers: `finance/statements.js:270-294`, `payouts/destinations.js:275`. Pre-check A.9: funded payouts are frozen by `financial_scope`, but `ALTER TABLE` does not fire it.

Then delete `legacyRupeesToMinor()` once nothing calls it.

### Phase 8: document integrity and naming (optional)

1. Apply the `document` block from §15.2. Pre-check A.10 must show zero orphans, or the FK fails.
2. **Code:** in `auth/documents.js:154-169` and `auth/listings.js:515-527`, replace `onConflictDoUpdate` with: mark the live row `superseded`, then insert the new row, in one transaction. The review UI reads live rows only (`status IN ('uploaded','accepted')`, as `listDocuments` already does, `documents.js:32`).
3. **Optional rename of `"user"` to `app_user`:** `ALTER TABLE "user" RENAME TO app_user; CREATE VIEW "user" AS SELECT * FROM app_user;`. Triggers and FKs follow the rename. Move the code over gradually, then drop the view. Do this only if hand-written SQL keeps tripping on the quoting.

### Phase 9: OTP unification (optional hardening)

1. Create `otp_challenge` (§15.2). Rename `customer_auth_rate` to `auth_rate_event` and add `principal_kind`.
2. **Code:** move `customer-identity.js`, `auth/otp.js` and `staff-session.js` to one OTP service that writes `otp_challenge` and `auth_rate_event`. Partners get hashed-IP rate limits and browser binding.
3. No data copy is needed. Codes expire in 5 minutes.
4. After one release: `DROP TABLE otp_token; DROP TABLE customer_otp_challenge; DROP TYPE otp_channel; DROP TYPE otp_purpose;`

### 17.2 Phase dependencies

```
0 ─> 1 ─> 2 ─┬─> 3 ─> 4
             ├─> 5 ─> 6 ─> 7
             └─> 8, 9 (independent)
```

Phase 4 goes after Phase 3, because both change `user` and it keeps review simple. Phase 7's `payout` step can move earlier, since `payout` holds seed rows only.

---

## 18. Open questions for the owner

1. **Is the hosted data real or seed/test?** This decides Phase 6, Option A or B. Pre-check A.1 shows the provenance of orderless bookings.
2. **Roadmap check.**
   - Cash-on-arrival balances (`balance_mode`, `balance_settled_at`), check-in codes (`check_in_code`), serial-numbered goods (`unit`): are any of these planned soon? If yes, keep those booking columns. `unit` should still be dropped and designed again when needed.
   - Host response stats (`responds_within_mins`, `response_rate`): compute them, or remove them from the listing UI?
3. **One forced re-login** for customers who log in during the Phase 3 session switch: acceptable?
4. **Open dates:** should owners keep opening dates explicitly (`availability` rows), or should dates be open by default within the booking horizon, with blocks as the only exceptions? The second removes most of the 28k rows, but it is a product change.
5. **Payout formula:** confirm how `net` relates to gross, commission, TDS and TCS with the CA, so `payout_amounts_chk` can be exact.

---

## 19. Relationship integrity audit

Every foreign key in `schema/index.js` and the SQL migrations was checked: 130 declared FKs (93 `RESTRICT`, 14 `CASCADE`, the rest `SET NULL` or the implicit `NO ACTION`), plus every `*_id` column that has no FK.

### 19.1 Relationships that are correct

These are well designed. Keep them as they are.

| Relationship                                                                                                                      | Why it is correct                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `booking (order_id, customer_id, rentable_id, currency, time_zone) → booking_order`                                               | A composite FK proves that each visit's copied columns equal the order's.                                                                                                                         |
| `inventory_reservation (booking_id, rentable_id) → booking (id, rentable_id)` + GiST exclusion                                    | A reservation cannot point at a booking for another listing. Active holds cannot overlap.                                                                                                         |
| Money chain `payment_order → attempt → transaction → allocation → booking`, and `refund → refund_allocation → payment_allocation` | `rentra_financial_scope` (M0012:55-100) checks that each allocation belongs to the paying order and matches its mode and currency, and that each refund allocation matches its source allocation. |
| `payment_execution`, `refund_execution`, `payment_event_job`, `privacy_job`                                                       | 1:1, enforced by using the parent id as the primary key.                                                                                                                                          |
| `client_application.user_id` UNIQUE                                                                                               | 1:1 per client.                                                                                                                                                                                   |
| `listing_review.submission_id` UNIQUE                                                                                             | At most one decision per submission.                                                                                                                                                              |
| `portal_session`, `visit_attachment`, `support_request`                                                                           | "Exactly one parent" is enforced with `num_nonnulls` or `IS NULL` CHECKs.                                                                                                                         |
| `staff_property`, `rentable_amenity`, `booking_case_visit`                                                                        | Many-to-many junctions with a composite primary key.                                                                                                                                              |
| `dispute_case (order, visit, owner, customer)`                                                                                    | The copies are checked on insert by the `dispute_case_scope` trigger (M0034:81-89).                                                                                                               |
| `audit_log` without FKs                                                                                                           | Deliberate. An audit row must outlive the thing it describes.                                                                                                                                     |
| `customer_favourite.rentable_id` without an FK                                                                                    | Deliberate (schema:1634). A deleted listing remains as an "unavailable" saved place.                                                                                                              |

### 19.2 Issue 1: delete rules are inconsistent, and some are dangerous

Users, listings and admins are never hard-deleted in this system. They are anonymised (privacy erasure), hidden or deactivated. The delete rule should say the same thing: history is never removed by a cascade.

| FK                                                                                                                                                                                                                                                            | Today     | Problem                                                                                                                                                                               | Change to         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `review.booking_id → booking`                                                                                                                                                                                                                                 | CASCADE   | Deleting a visit silently deletes its review and changes the listing rating.                                                                                                          | RESTRICT          |
| `review.author_id → user`                                                                                                                                                                                                                                     | CASCADE   | Deleting a user deletes their reviews. Privacy erasure anonymises instead, so the cascade only fires by mistake.                                                                      | RESTRICT          |
| `client_staff.client_id → user`                                                                                                                                                                                                                               | CASCADE   | Can never succeed: `staff_property`, `staff_invitation` and `portal_session.staff_id` are RESTRICT, so the cascade errors halfway.                                                    | RESTRICT          |
| `area.city_id → city`                                                                                                                                                                                                                                         | CASCADE   | Deleting a city silently deletes its areas, which are SEO routes. The catalogue retires rows with `is_active`.                                                                        | RESTRICT          |
| `rentable_amenity.amenity_id → amenity`                                                                                                                                                                                                                       | CASCADE   | Deleting an amenity strips it from every listing and bumps each listing's content version.                                                                                            | RESTRICT          |
| Admin attribution: `document.reviewed_by`, `client_application.reviewed_by`, `rentable.verified_by` / `published_by` / `restricted_by`, `verification_visit.created_by` / `recorded_by`, `listing_review.reviewed_by`                                         | SET NULL  | Erases _who_ approved a KYC document, a publication or a visit. Newer tables (`booking_case`, `dispute_case`, `payout_destination`) already use RESTRICT for the same kind of column. | RESTRICT          |
| `document.uploaded_by → user`                                                                                                                                                                                                                                 | SET NULL  | Loses who uploaded identity evidence.                                                                                                                                                 | RESTRICT          |
| 11 FKs with no rule given (implicit NO ACTION): `rentable.category_id` / `city_id` / `area_id`, `listing_submission.*`, `listing_review.submission_id`, `verification_visit.submission_id`, `review.moderated_by` / `replied_by`, `review_report.resolved_by` | NO ACTION | Behaves almost like RESTRICT, but it is implicit and inconsistent with the rest of the schema.                                                                                        | explicit RESTRICT |

Keep CASCADE only for data that has no value without its parent: sessions, OTP challenges, `customer_favourite` / `customer_favourite_merge` (privacy deletion relies on it), `customer_profile` (merged anyway), and the listing's own rows `rentable_price` and `availability`.

Assignment columns (`client_application.assigned_to`, `support_request.assigned_to` and similar) may stay `SET NULL`, because an assignment is workflow state, not history. `portal_session.staff_id` is RESTRICT while `user_id` and `admin_id` CASCADE. Caretaker rows are revoked, never deleted, so this is harmless. Make it CASCADE for consistency when the table becomes `auth_session`.

Changing a delete rule is a constraint swap. It does not touch rows or fire triggers:

```sql
-- list the current rules first ('a' no action, 'r' restrict, 'c' cascade, 'n' set null)
SELECT conrelid::regclass AS tbl, conname, confdeltype
  FROM pg_constraint WHERE contype = 'f' ORDER BY 1, 2;

-- pattern, one per FK (Drizzle's default name is <table>_<column>_<ref table>_<ref column>_fk)
ALTER TABLE review DROP CONSTRAINT review_booking_id_booking_id_fk,
  ADD CONSTRAINT review_booking_id_booking_id_fk
  FOREIGN KEY (booking_id) REFERENCES booking(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE review VALIDATE CONSTRAINT review_booking_id_booking_id_fk;
```

### 19.3 Issue 2: FKs to `user` do not check the role

`booking_order.customer_id → user(id)` accepts a **client** row. `rentable.client_id → user(id)` accepts a **customer** row. The application only ever writes the right role, but nothing in the database proves it. Migrations 0017, 0019, 0028, 0029, 0031, 0032 and 0033 check the role inside triggers for their own tables. The core booking, listing and money tables have no check at all.

Fix: a composite FK to `user(id, role)`. This works cleanly once `role` is a plain code (§4.7). A constant generated column supplies the role on the child side. Adding a generated column fires no row triggers.

```sql
CREATE UNIQUE INDEX user_id_role_idx ON "user" (id, role);

ALTER TABLE booking_order
  ADD COLUMN customer_role varchar(16) GENERATED ALWAYS AS ('customer') STORED,
  ADD CONSTRAINT booking_order_customer_role_fk
    FOREIGN KEY (customer_id, customer_role) REFERENCES "user" (id, role) NOT VALID;
ALTER TABLE booking_order VALIDATE CONSTRAINT booking_order_customer_role_fk;
```

Apply to:

- `booking_order.customer_id` (role `customer`).
- `rentable.client_id` and `payout.client_id` (role `client`).
- Not applied to `booking_quote`, `customer_payment_method` and `client_staff`. Those rows are only reachable through a proven order, a payment attempt or an owner, so an extra column on each buys little. Add it later only if a wrong-role row ever turns up.
- `booking.customer_id` needs nothing: its composite FK to `booking_order` already carries the proven customer.
- `review` needs no generated column. It already has `author_role`, so `FOREIGN KEY (author_id, author_role) REFERENCES "user" (id, role)` works directly.

Pre-check: `SELECT count(*) FROM booking_order o JOIN "user" u ON u.id = o.customer_id WHERE u.role <> 'customer'` (and the same for each table) must return 0.

### 19.4 Issue 3: redundant parent copies without a declarative guarantee

Some tables store a second parent id that could be derived. The copy is fine for query speed, but it should be proven, the way `booking → booking_order` is.

| Child                        | Copied column                                 | Today                                                                                                               | Fix                                                                                                                                                                |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `review`                     | `rentable_id` (nullable) next to `booking_id` | Checked only when the review is shown (`rentra_review_eligible`, M0018:33-38). A mismatched row is silently hidden. | `rentable_id SET NOT NULL`; composite FK `(booking_id, rentable_id) → booking(id, rentable_id)`. The target unique index `booking_id_rentable_idx` already exists. |
| `listing_review`             | `rentable_id` next to `submission_id`         | No check.                                                                                                           | Unique index `listing_submission(id, rentable_id)`; composite FK `(submission_id, rentable_id)`.                                                                   |
| `verification_visit`         | `rentable_id` next to `submission_id`         | No check.                                                                                                           | The same composite FK.                                                                                                                                             |
| `rentable`                   | `city_id` next to `area_id`                   | Trigger on rentable changes only.                                                                                   | Composite FK (§7.3).                                                                                                                                               |
| `listing_review.pass_number` | copy of `listing_submission.pass_number`      | No check.                                                                                                           | Include it in the composite FK, or drop it and read it through the join.                                                                                           |

### 19.5 Issue 4: missing FKs

| Column                                                                                                                                                                                                           | Points to                                                         | Action                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document.owner_id`                                                                                                                                                                                              | `client_application` or `rentable`                                | Generated FK columns (§11.1).                                                                                                                                                                                                                                                                                                                             |
| `customer_otp_challenge.session_id`                                                                                                                                                                              | `customer_session.id`                                             | After the session merge, `REFERENCES auth_session(id) ON DELETE CASCADE`.                                                                                                                                                                                                                                                                                 |
| `actor_id` / `created_by_id` on `visit_evidence`, `visit_incident`, `visit_evidence_correction`, `visit_attachment`, `booking_case`, `booking_case_update`, `support_message`, `dispute_case`, `dispute_message` | `user`, `admin_user` or `client_staff`, depending on `actor_kind` | Scope triggers validate these on insert, and principals are never deleted, so this is **acceptable as is**. If you want database-level FKs, use the §11.1 trick: one generated column per kind (for example `actor_admin_id uuid GENERATED ALWAYS AS (CASE WHEN actor_kind = 'admin' THEN actor_id END) STORED REFERENCES admin_user(id)`). Low priority. |

### 19.6 Issue 5: cardinality to confirm

- **`booking_order.quote_id` is not unique.** One quote could back several orders. The idempotency key stops double-submits from the same request, but not two different requests carrying the same quote. If one quote is meant to become at most one order, add `CREATE UNIQUE INDEX booking_order_quote_once_idx ON booking_order (quote_id) WHERE quote_id IS NOT NULL;` (after checking for duplicates). Owner decision.
- **An order with zero visits is possible.** Nothing forces a `booking_order` to have at least one `booking`. Checkout creates both in one transaction, so this is low risk. A deferred constraint trigger could enforce it if needed.
- **Circular FK:** `rentable.published_submission_id → listing_submission → rentable`. This is fine because the column is nullable. It does mean inserts must happen in order (rentable, then submission, then set the pointer), and restore tools must load the FK after the data. `pg_dump` handles this.

### 19.7 Where this fits in the migration plan

- §19.2 (delete rules) and §19.4 (composite FKs) go into **Phase 1**. They only swap or add constraints, and every constraint uses `NOT VALID` then `VALIDATE`.
- §19.3 (role-checked FKs) goes into **Phase 3**, right after the `role` table (§4.7), because the generated columns need `role` to be a plain code.
- §19.5 follows the phases already listed: documents in Phase 8, sessions in Phase 3.

## 20. Implementation status (30 September 2026)

Implemented in migrations `0041`–`0051` with the matching code, seed and test changes. Everything is verified on local disposable PostgreSQL only; the hosted Neon database has not been touched.

| Migration                              | Content                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `0041_integrity_indexes`               | FK and worker indexes, delete rules, composite FKs, case-insensitive email uniqueness                        |
| `0042_remove_dead_objects`             | `unit`, `person`, dead booking/application/listing columns                                                   |
| `0043_identity_consolidation`          | `role` table, profile and inbox preferences on `user`, `auth_session`, role-checked FKs, `cancelled_by_kind` |
| `0044_payout_details_single_source`    | `client_payout_current` view; legacy payout columns archived to `audit_log` and dropped                      |
| `0045_inventory_pricing_single_source` | legacy price overrides and owner blocks moved; `availability` narrowed                                       |
| `0046_listing_content_cleanup`         | amenity labels to taxonomy rows (unmatched ones archived); `approved_snapshot` dropped                       |
| `0047_booking_legacy_contraction`      | orderless bookings moved into `legacy` orders; booking legacy copy dropped                                   |
| `0048_money_minor_units`               | prices, deposits, extra-guest charges and payouts in paise                                                   |
| `0049_document_integrity`              | owner FKs; re-upload supersedes instead of overwriting                                                       |
| `0050_otp_unification`                 | `otp_challenge`, `auth_rate_event`                                                                           |
| `0051_worker_performance`              | review refresh trigger only on completion changes                                                            |

Differences from the plan above:

- The `customer_role` / `client_role` columns are constant columns (`DEFAULT` + `CHECK`), not generated columns. `BEFORE UPDATE` triggers see generated columns as NULL in `NEW`, which made the immutability triggers reject every update.
- They exist on `booking_order`, `rentable` and `payout` only (§19.3).
- `booking.cancelled_by_kind`: rows cancelled before 0043 keep NULL (unknown). Every writer now records the kind.
- All phases run in one release, so the expand/contract steps are combined. Every migration has a pre-check that stops with a clear message instead of a bare constraint error.
- API responses keep their rupee fields and existing JSON keys. Money is stored in paise only.

Verification:

- 144/144 backend tests pass, including the 3 that were previously skipped and a new `schema-integrity` test.
- Upgrade rehearsal: a database at migration 0040 with the old seed data (orderless bookings, rupee payouts, jsonb amenities, owner blocks, price overrides) upgraded through 0051. Counts and money totals were unchanged, and listing content versions did not move.
- API checked over HTTP on the upgraded database: listing detail, cards, search with and without dates, and next-dates.

### Deploy runbook (hosted)

1. Create a Neon branch of production as a restore point.
2. Stop the Render worker.
3. Run `npm run db:migrate` against the branch first, then against production. It applies 0040 (pending) and 0041–0051.
4. Deploy the backend commit, then start the worker.
5. Expect a one-time effect: quotes and held orders created before the deploy fail with `QUOTE_CHANGED`, because the rate rows are now hashed in paise. Customers re-quote. Partner and customer OTP codes in flight must be re-requested.
6. The frontend needs no change. The `Rentra/scripts/portal-gate/mint.mjs` QA script was updated for the new tables.
7. Still open: remove the hard-coded database URL fallback in `src/scripts/seed-gujarat-partners.js` and rotate that credential; create the `rentra_app` runtime role (§13.4).

## Appendix A: pre-migration audit queries

Run on a Neon branch, and on production read-only, before each phase.

```sql
-- A.1 Orderless (legacy) bookings and their provenance            [Phase 6]
SELECT visit_provenance, payment_mode, count(*) FROM booking WHERE order_id IS NULL GROUP BY 1, 2;
SELECT count(*) FROM payout p JOIN booking b ON b.id = p.booking_id WHERE b.order_id IS NULL;
SELECT count(*) FROM review r JOIN booking b ON b.id = r.booking_id WHERE b.order_id IS NULL;

-- A.2 Migration drift                                              [Phase 0]
SELECT to_regclass('public.operational_incident') AS has_0040;

-- A.3 Payout details that exist only in legacy columns            [Phase 4]
SELECT u.id, u.email FROM "user" u
  LEFT JOIN client_application a ON a.user_id = u.id
 WHERE u.role = 'client'
   AND (u.payout_upi_id IS NOT NULL OR u.payout_bank_ref IS NOT NULL
        OR a.payout_upi_id IS NOT NULL OR a.payout_account_ref IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM payout_destination d WHERE d.client_id = u.id);

-- A.4 Legacy owner blocks                                          [Phase 5]
SELECT count(*) FILTER (WHERE blocked_by_client) AS legacy_blocks,
       count(*) FILTER (WHERE price_override IS NOT NULL) AS legacy_prices
  FROM availability;

-- A.5 Price override conflicts (explicit row wins today)           [Phase 5]
SELECT count(*) FROM availability a JOIN booking_price_override o
    ON (o.rentable_id, o.day, o.slot::text) = (a.rentable_id, a.day, a.slot::text)
 WHERE a.price_override IS NOT NULL AND o.rent_minor <> a.price_override::bigint * 100;

-- A.6 Listings relying on the amenities jsonb fallback             [Phase 2/7]
SELECT r.id, r.title FROM rentable r
 WHERE jsonb_array_length(r.amenities) > 0
   AND NOT EXISTS (SELECT 1 FROM rentable_amenity ra WHERE ra.rentable_id = r.id);

-- A.7 Role-column violations (must be empty before VALIDATE)       [Phase 3]
SELECT id, role FROM "user"
 WHERE (role = 'customer' AND (client_type IS NOT NULL OR kyc_status <> 'none'
        OR responds_within_mins IS NOT NULL OR response_rate IS NOT NULL))
    OR (role = 'client' AND (privacy_erasure_pending OR privacy_erased_at IS NOT NULL));
SELECT u.id FROM client_update_preference c JOIN "user" u ON u.id = c.user_id
 WHERE u.role <> 'client' AND c.muted <> '[]'::jsonb;

-- A.8 person usage                                                 [Phase 2]
SELECT count(*) FROM "user" WHERE person_id IS NOT NULL;

-- A.9 Funded payouts                                               [Phase 7]
SELECT count(*) FROM payout WHERE funding_allocation_id IS NOT NULL;

-- A.10 Document owners and orphans                                 [Phase 8]
SELECT owner_type, count(*) FROM document GROUP BY 1;
SELECT count(*) FROM document d WHERE owner_type = 'rentable'
   AND NOT EXISTS (SELECT 1 FROM rentable r WHERE r.id = d.owner_id);
SELECT count(*) FROM document d WHERE owner_type = 'client_application'
   AND NOT EXISTS (SELECT 1 FROM client_application a WHERE a.id = d.owner_id);

-- A.11 Case-insensitive email duplicates                           [Phase 1]
SELECT lower(email), role, count(*) FROM "user" WHERE email IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;

-- A.12 Area/city mismatches (must be empty before the composite FK) [Phase 1]
SELECT r.id FROM rentable r JOIN area a ON a.id = r.area_id WHERE a.city_id <> r.city_id;

-- A.13 Unknown values before new CHECKs                            [Phase 1]
SELECT purpose, delivery_mode, count(*) FROM customer_otp_challenge GROUP BY 1, 2;
SELECT kind, count(*) FROM customer_auth_rate GROUP BY 1;

-- A.14 Growth baselines (repeat monthly)
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 20;
```
