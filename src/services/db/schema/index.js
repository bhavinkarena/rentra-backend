import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, varchar, integer, bigint, boolean, timestamp,
  date, jsonb, real, geometry, uniqueIndex, index, primaryKey, check, foreignKey,
} from 'drizzle-orm/pg-core';

/** Aggregate-only measurement: bounded dimensions, no per-person event history. */
export const customerMeasurement = pgTable('customer_measurement', {
  day: date('day').notNull(),
  event: varchar('event', { length: 32 }).notNull(),
  source: varchar('source', { length: 8 }).notNull(),
  device: varchar('device', { length: 8 }).notNull(),
  visits: varchar('visits', { length: 8 }).notNull(),
  count: integer('count').notNull(),
}, t => [primaryKey({ columns: [t.day, t.event, t.source, t.device, t.visits] }),
  check('customer_measurement_bounds_chk', sql`${t.count} BETWEEN 1 AND 1000000
    AND ${t.device} IN ('mobile','desktop','unknown') AND ${t.visits} IN ('single','multiple','unknown')
    AND ((${t.source}='browser' AND ${t.event} IN ('search_submitted','listing_viewed','dates_selected','history_viewed','share_attempted','share_completed'))
      OR (${t.source}='server' AND ${t.event} IN ('quote_ready','login_completed','checkout_started','inventory_conflict','quote_changed','payment_unavailable','otp_request_rejected','otp_rejected')))`),
]);

export const serviceHealth = pgTable('service_health', {
  service: varchar('service', { length: 16 }).primaryKey(),
  healthy: boolean('healthy').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
}, t => [check('service_health_name_chk', sql`${t.service} IN ('payments','notifications')`)]);

/**
 * Money in the customer booking tables is stored in integer MINOR UNITS
 * (paise) on columns whose names end in `Minor`. The legacy whole-rupee
 * columns on `booking`/`payout` keep their original names and meaning; they
 * are read-only from here on. `legacyRupeesToMinor()` in
 * lib/domain/booking-money.js is the single conversion boundary — never
 * multiply a value that already carries a `Minor` name.
 */
const minor = (name) => bigint(name, { mode: 'number' });

/* ==========================================================================
   ENUMS
   ========================================================================== */

/** One account = one role, fixed at signup. See docs plan §"Roles". */
export const userRole = pgEnum('user_role', ['customer', 'client']);

/** A broker may list only as an explicitly-labelled agent, never as owner. */
export const clientType = pgEnum('client_type', ['owner', 'authorised_agent']);

export const kycStatus = pgEnum('kyc_status', [
  'none', 'pending', 'verified', 'rejected', 'more_info_needed',
]);

/**
 * A Client is logged in from the moment their email is verified, but cannot
 * publish until a Super Admin approves them. `pending_application` is the
 * state the completion stepper lives in — see docs/rentra-role-flow.html.
 */
export const accountStatus = pgEnum('account_status', [
  'pending_application', 'active', 'suspended', 'blocked',
]);

export const otpChannel = pgEnum('otp_channel', ['email', 'sms']);
export const otpPurpose = pgEnum('otp_purpose', [
  'login', 'verify_email', 'verify_phone',
]);

export const auditActor = pgEnum('audit_actor', [
  'client', 'customer', 'admin', 'system',
]);

/**
 * Gate 1's own lifecycle. Three review outcomes, never two — `more_info_needed`
 * is what stops a fixable typo becoming a permanent rejection.
 */
export const applicationStatus = pgEnum('application_status', [
  'draft', 'submitted', 'more_info_needed', 'approved', 'rejected',
]);

/* --- The three columns that keep goods rental a feature, not a rewrite --- */
export const rentableForm = pgEnum('rentable_form', ['fixed', 'movable']);
export const fulfilment = pgEnum('fulfilment', [
  'visit_site',        // a place — the renter travels to it
  'pickup_from_owner', // movable, collected
  'delivered',         // movable, brought to the renter
]);
export const rentalUnit = pgEnum('rental_unit', ['slot', 'night', 'day', 'week', 'month']);

/**
 * Availability is stored per DAY and per NIGHT only.
 * `full_day` is a booking-level concept that consumes BOTH rows — keeping it
 * out of this enum makes that invariant impossible to violate.
 */
export const availabilitySlot = pgEnum('availability_slot', ['day', 'night']);
export const bookingSlot = pgEnum('booking_slot', ['day', 'night', 'full_day']);

export const listingStatus = pgEnum('listing_status', [
  'draft', 'pending_review', 'pending_verification', 'live', 'paused', 'hidden',
  // Gate 2 can say no. Without this a rejected listing had nowhere to sit.
  'rejected',
]);

/** Some amenity tags carry a number or a dimension; most carry nothing. */
export const amenityValueType = pgEnum('amenity_value_type', [
  'none', 'count', 'dimensions', 'area', 'charge',
]);

/** Gate 2's outcomes. Three ways forward, one way back — same as Gate 1. */
export const listingReviewOutcome = pgEnum('listing_review_outcome', [
  'changes_requested', 'approved_for_visit', 'published', 'rejected',
]);

/**
 * Video by default: a scheduled screen-recorded walkthrough is free, remote,
 * and roughly 70% as convincing as standing there. Physical visits are for
 * high-value listings and once a cluster has volume.
 */
export const visitMode = pgEnum('visit_mode', ['video_call', 'physical']);
export const visitOutcome = pgEnum('visit_outcome', ['passed', 'failed', 'no_show']);

/** Same 7 states describe a guest checking in AND a camera leaving a shop. */
export const bookingState = pgEnum('booking_state', [
  'requested', 'confirmed', 'handed_over', 'returned',
  'completed', 'cancelled', 'disputed',
]);

export const balanceMode = pgEnum('balance_mode', [
  'online_before', 'cash_on_arrival', 'none',
]);

export const cancellationTier = pgEnum('cancellation_tier', [
  'flexible', 'moderate', 'strict',
]);

/**
 * Local land units. Every Surat-belt competitor lists "Farm Size" in Vigha or
 * Var, not acres or sq ft. Guests filter on it, so it is a first-class field.
 */
export const landUnit = pgEnum('land_unit', ['vigha', 'var', 'acre', 'sqft']);

export const payoutStatus = pgEnum('payout_status', [
  'pending', 'processing', 'paid', 'failed', 'frozen',
]);

/** Payment mode never establishes evidence of an actual visit or capture. */
export const paymentMode = pgEnum('payment_mode', ['simulated', 'real', 'legacy_unknown']);
export const visitProvenance = pgEnum('visit_provenance', ['real', 'test', 'seed', 'legacy_unknown']);
export const bookingOrderState = pgEnum('booking_order_state', [
  'draft', 'held', 'confirmed', 'partially_cancelled', 'completed', 'cancelled', 'expired', 'legacy',
]);
export const reservationState = pgEnum('reservation_state', ['held', 'committed', 'released', 'expired']);

/* ==========================================================================
   IDENTITY
   ========================================================================== */

/**
 * One verified human. Created from the KYC vendor's result so a person who
 * holds both a Customer and a Client account is verified ONCE — otherwise we
 * pay the vendor twice and ask a verified owner to re-photograph his Aadhaar.
 * We store the vendor's reference, never a raw ID image (DPDP Act).
 */
export const person = pgTable('person', {
  id: uuid('id').primaryKey().defaultRandom(),
  kycRef: varchar('kyc_ref', { length: 128 }).unique(),
  verifiedName: varchar('verified_name', { length: 160 }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: varchar('phone', { length: 15 }),
    role: userRole('role').notNull(),
    name: varchar('name', { length: 160 }),
    email: varchar('email', { length: 254 }),

    /**
     * Email is the CLIENT credential; phone is the CUSTOMER credential.
     * A Client signs up with email alone, so `phone` is nullable until they
     * reach that step of the stepper — it blocks submitting the application,
     * not logging in.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    accountStatus: accountStatus('account_status').notNull().default('pending_application'),
    /**
     * Optimistic-concurrency token for admin lifecycle commands (suspend,
     * reinstate). Bumped only by those commands, so a client's own login or
     * profile edit never makes an admin's reviewed impact preview stale.
     */
    lifecycleVersion: integer('lifecycle_version').notNull().default(1),
    preferredLocale: varchar('preferred_locale', { length: 5 }).notNull().default('en'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    personId: uuid('person_id').references(() => person.id, { onDelete: 'set null' }),
    clientType: clientType('client_type'),
    kycStatus: kycStatus('kyc_status').notNull().default('none'),
    payoutUpiId: varchar('payout_upi_id', { length: 128 }),
    payoutBankRef: varchar('payout_bank_ref', { length: 128 }),
    respondsWithinMins: integer('responds_within_mins'),
    responseRate: real('response_rate'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * NOT unique on phone alone. A Client has one phone number; if phone were
     * globally unique he could never open a Customer account to book someone
     * else's farmhouse, and we'd learn that from a support call.
     *
     * Both are partial-unique via nullability: Postgres treats NULLs as
     * distinct, so many Clients can sit with no phone yet without colliding.
     */
    uniqueIndex('user_phone_role_idx').on(t.phone, t.role),
    uniqueIndex('user_email_role_idx').on(t.email, t.role),
    index('user_person_idx').on(t.personId),
    index('user_status_idx').on(t.role, t.accountStatus),
  ],
);

/**
 * One-time codes. Only the HMAC of the code is stored — never the code, so a
 * database leak cannot be replayed into logins.
 *
 * Rate limits live here rather than in Redis: at this scale two indexed
 * queries are cheaper than another piece of infrastructure to run.
 */
export const otpToken = pgTable(
  'otp_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: varchar('identifier', { length: 254 }).notNull(),
    channel: otpChannel('channel').notNull(),
    purpose: otpPurpose('purpose').notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestIp: varchar('request_ip', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Serves both "find the live code" and the resend rate-limit count.
    index('otp_lookup_idx').on(t.identifier, t.purpose, t.createdAt),
  ],
);

/** Customer challenges are isolated from partner login/phone verification. */
export const customerOtpChallenge = pgTable('customer_otp_challenge', {
  id: uuid('id').primaryKey(),
  phone: varchar('phone', { length: 10 }).notNull(),
  purpose: varchar('purpose', { length: 16 }).notNull().default('login'),
  customerId: uuid('customer_id').references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id'),
  originalPhone: varchar('original_phone', { length: 15 }),
  browserHash: varchar('browser_hash', { length: 64 }).notNull(),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  deliveryMode: varchar('delivery_mode', { length: 16 }).notNull(),
  delivered: boolean('delivered').notNull().default(false),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('customer_otp_phone_idx').on(t.phone, t.createdAt)]);

/** HMAC identifiers only; includes failed verification and failed delivery. */
export const customerAuthRate = pgTable('customer_auth_rate', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneHash: varchar('phone_hash', { length: 64 }).notNull(),
  ipHash: varchar('ip_hash', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('customer_auth_phone_rate_idx').on(t.phoneHash, t.kind, t.createdAt), index('customer_auth_ip_rate_idx').on(t.ipHash, t.kind, t.createdAt)]);

export const customerSession = pgTable('customer_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('customer_session_user_idx').on(t.userId)]);

export const customerProfile = pgTable('customer_profile', {
  photoPublicId: text('photo_public_id'),
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  marketingConsent: boolean('marketing_consent').notNull().default(false),
  consentUpdatedAt: timestamp('consent_updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const customerPrivacyRequest = pgTable('customer_privacy_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('customer_privacy_kind_chk', sql`${t.kind} IN ('access', 'deletion')`),
  check('customer_privacy_state_chk', sql`${t.state} IN ('open', 'in_review', 'closed')`),
  uniqueIndex('customer_privacy_active_idx').on(t.customerId, t.kind).where(sql`${t.state} <> 'closed'`),
  index('customer_privacy_queue_idx').on(t.state, t.createdAt),
]);

export const documentType = pgEnum('document_type', [
  // Identity — Gate 1
  'pan_card', 'aadhaar_masked', 'passport', 'driving_licence', 'voter_id',
  // Ownership — Gate 2, per listing
  'electricity_bill', 'property_tax', 'extract_7_12', 'extract_8a',
  'index_ii', 'sale_deed', 'na_order', 'authorisation_letter', 'noc',
]);

export const documentSide = pgEnum('document_side', ['front', 'back', 'single']);

export const documentStatus = pgEnum('document_status', [
  'uploaded', 'accepted', 'rejected', 'superseded', 'deleted',
]);

/**
 * THE DOCUMENT VAULT — one polymorphic store, one review lifecycle.
 *
 * Files live in Cloudinary under `type: authenticated`, which means the URL
 * alone grants nothing: delivery needs a short-lived signed URL minted per
 * request. We store the `public_id`, never a public URL — a public URL to
 * somebody's ID sitting in a database column is a breach waiting for someone
 * to run a SELECT.
 *
 * Aadhaar: only the MASKED version UIDAI provides is accepted. Under the DPDP
 * Act an Aadhaar image is sensitive personal data, and UIDAI restricts
 * non-authorised entities from storing full Aadhaar copies at all. PAN is the
 * preferred document precisely because it carries none of that.
 */
export const documents = pgTable(
  'document',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Polymorphic owner: an application (Gate 1) or a rentable (Gate 2).
    ownerType: varchar('owner_type', { length: 32 }).notNull(),
    ownerId: uuid('owner_id').notNull(),

    docType: documentType('doc_type').notNull(),
    side: documentSide('side').notNull().default('single'),

    /** Cloudinary public_id. The only handle we keep — never a delivery URL. */
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    mimeType: varchar('mime_type', { length: 80 }),
    bytes: integer('bytes'),
    width: integer('width'),
    height: integer('height'),

    /** Name-matching evidence, filled by the reviewer. */
    nameOnDocument: varchar('name_on_document', { length: 160 }),
    nameMatch: varchar('name_match', { length: 16 }), // exact | partial | none
    /** Freshness rule: a light bill older than ~3 months is re-requested. */
    issuedAt: date('issued_at'),

    status: documentStatus('status').notNull().default('uploaded'),
    reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),

    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    /** Retention: set when the file is destroyed in Cloudinary. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('document_owner_idx').on(t.ownerType, t.ownerId, t.status),
    // One live file per (owner, type, side). Re-uploading supersedes.
    uniqueIndex('document_slot_idx').on(t.ownerType, t.ownerId, t.docType, t.side),
  ],
);

/**
 * GATE 1 — the Client's onboarding application. One per Client.
 *
 * Deliberately holds nothing about a property. Address, photos, price and
 * amenities all belong to a listing, and mixing them here is the most common
 * way this flow goes wrong: it makes Gate 1 impossible to decide cleanly, and
 * a Client with three farmhouses would have to redo KYC three times.
 */
export const clientApplication = pgTable(
  'client_application',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: applicationStatus('status').notNull().default('draft'),

    // --- their details ---
    legalName: varchar('legal_name', { length: 160 }),
    residentialAddress: text('residential_address'),
    pincode: varchar('pincode', { length: 6 }),
    intendedListingCount: integer('intended_listing_count'),

    // --- the agent path ---
    ownerName: varchar('owner_name', { length: 160 }),
    ownerRelationship: varchar('owner_relationship', { length: 80 }),

    // --- KYC. We store the vendor's REFERENCE and verdict, never the image. --
    kycRef: varchar('kyc_ref', { length: 128 }),
    kycDocType: varchar('kyc_doc_type', { length: 16 }), // 'pan' | 'aadhaar'
    kycNameOnDoc: varchar('kyc_name_on_doc', { length: 160 }),
    kycVerifiedAt: timestamp('kyc_verified_at', { withTimezone: true }),

    // --- payout destination ---
    payoutUpiId: varchar('payout_upi_id', { length: 128 }),
    payoutAccountRef: varchar('payout_account_ref', { length: 64 }),
    payoutIfsc: varchar('payout_ifsc', { length: 11 }),
    payoutHolderName: varchar('payout_holder_name', { length: 160 }),
    /**
     * Penny-drop result. NULL = not checked, false = mismatch, true = matched.
     * A mismatch blocks approval: paying out to a third-party account is how a
     * marketplace becomes a laundering route.
     */
    payoutNameMatch: boolean('payout_name_match'),

    // --- consent ---
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentIp: varchar('consent_ip', { length: 45 }),

    // --- review ---
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    decisionReason: text('decision_reason'),
    flaggedFields: jsonb('flagged_fields'),
    /** Third rejection blocks the account; only a manual appeal reopens it. */
    strikeCount: integer('strike_count').notNull().default(0),
    /**
     * Bumped by every submit, withdraw and decision. A decision must name the
     * version it reviewed, so a resubmitted or already-decided application
     * cannot receive a second, contradictory decision.
     */
    reviewVersion: integer('review_version').notNull().default(1),
    /** Responsible reviewer. Kept after a correction request so the resubmission returns to them. */
    assignedTo: uuid('assigned_to').references(() => adminUsers.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('application_status_idx').on(t.status, t.submittedAt),
    index('application_queue_idx').on(t.status, t.assignedTo, t.submittedAt),
  ],
);

/**
 * Every consequential action, by anyone. Worth building before anything reads
 * it: the first time a Client disputes a suspension you will need to show what
 * happened and when, and that cannot be reconstructed after the fact.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: auditActor('actor_type').notNull(),
    actorId: uuid('actor_id'),
    entity: varchar('entity', { length: 64 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }),
    action: varchar('action', { length: 64 }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    ip: varchar('ip', { length: 45 }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entity, t.entityId, t.at),
    index('audit_actor_idx').on(t.actorType, t.actorId, t.at),
  ],
);

/**
 * Super Admin lives in its OWN table with its own auth — no self-signup, no
 * public login route. If admin were a role on `user`, one privilege-escalation
 * bug would hand over every payout control.
 */
export const adminUsers = pgTable('admin_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  permissions: jsonb('permissions'),
  name: varchar('name', { length: 160 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

  /**
   * Brute-force protection. A password form needs this in a way an OTP form
   * does not — an OTP is already single-use and short-lived, but a password
   * can be guessed indefinitely. This is the account that releases payouts and
   * approves listings, so it is the one worth locking.
   */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The caretaker. A CHILD of a Client, not a fourth role — build the primitive
 * once and it serves the caretaker now and the vendor's delivery driver in
 * Phase 3. Without it the check-in photo requirement never gets complied with,
 * and the whole dispute process rests on those photos.
 */
export const clientStaff = pgTable(
  'client_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    phone: varchar('phone', { length: 15 }).notNull(),
    name: varchar('name', { length: 160 }),
    // { checkIn, capturePhotos, markReturn, confirmCash } — never earnings/pricing
    permissions: jsonb('permissions').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('staff_client_phone_idx').on(t.clientId, t.phone)],
);

/* ==========================================================================
   GEOGRAPHY & TAXONOMY  —  these drive the SEO route tree, so they are real
   tables and never hardcoded strings.
   ========================================================================== */

export const city = pgTable('city', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  state: varchar('state', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const portalSession = pgTable('portal_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  adminId: uuid('admin_id').references(() => adminUsers.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  check('portal_session_principal_chk', sql`(${t.userId} IS NOT NULL) <> (${t.adminId} IS NOT NULL)`),
  index('portal_session_user_idx').on(t.userId),
  index('portal_session_admin_idx').on(t.adminId),
]);

export const area = pgTable(
  'area',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cityId: uuid('city_id').notNull().references(() => city.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    centre: geometry('centre', { type: 'point', mode: 'xy', srid: 4326 }),
  },
  (t) => [
    uniqueIndex('area_city_slug_idx').on(t.cityId, t.slug),
    index('area_centre_idx').using('gist', t.centre),
  ],
);

export const category = pgTable('category', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  form: rentableForm('form').notNull().default('fixed'),
  defaultRentalUnit: rentalUnit('default_rental_unit').notNull().default('slot'),
  isActive: boolean('is_active').notNull().default(true),
});

/* ==========================================================================
   THE CORE OBJECT  —  `rentable`, not `properties`.
   Everything Rentra will ever rent lives here.
   ========================================================================== */

export const rentable = pgTable(
  'rentable',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

    slug: varchar('slug', { length: 140 }).notNull().unique(),
    /**
     * Short, permanent, public id used in the URL: /listing/[slug]-[code].
     * The code — not the slug — is what resolves the page, so retitling a
     * listing never breaks a link. Deliberately NOT the uuid: 36 characters
     * of noise truncates in a WhatsApp preview, which is the main discovery
     * channel, and costs click-through in search results.
     */
    publicCode: varchar('public_code', { length: 10 }).notNull().unique(),
    title: varchar('title', { length: 140 }).notNull(),
    description: text('description'),
    status: listingStatus('status').notNull().default('draft'),

    // --- the three columns ---
    form: rentableForm('form').notNull().default('fixed'),
    fulfilment: fulfilment('fulfilment').notNull().default('visit_site'),
    rentalUnit: rentalUnit('rental_unit').notNull().default('slot'),

    categoryId: uuid('category_id').notNull().references(() => category.id),
    cityId: uuid('city_id').notNull().references(() => city.id),
    areaId: uuid('area_id').notNull().references(() => area.id),

    requiresOperator: boolean('requires_operator').notNull().default(false),
    /** 1 for a farmhouse. 800 for a tent-house's chairs. */
    totalUnits: integer('total_units').notNull().default(1),

    capacity: integer('capacity').notNull().default(1),
    bedrooms: integer('bedrooms').notNull().default(0),
    highlight: varchar('highlight', { length: 60 }),
    amenities: jsonb('amenities').notNull().default([]),
    houseRules: jsonb('house_rules').notNull().default([]),
    photos: jsonb('photos').notNull().default([]),

    /** Public map shows an area circle. The exact address unlocks on confirm. */
    location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }),
    exactAddress: text('exact_address'),

    /** Farm size in the local unit guests actually use. */
    farmSize: real('farm_size'),
    farmSizeUnit: landUnit('farm_size_unit'),
    /** Pool dimensions as published locally, e.g. "15x25". */
    poolSize: varchar('pool_size', { length: 24 }),
    /** Market convention is a WINDOW, not a fixed time: "9 AM to 7 PM". */
    checkInFrom: varchar('check_in_from', { length: 32 }),
    checkOutBy: varchar('check_out_by', { length: 32 }),

    depositAmount: integer('deposit_amount').notNull().default(0), // whole rupees
    cancellationTier: cancellationTier('cancellation_tier').notNull().default('moderate'),
    /** Explicit owner schedules; null is unavailable until reviewed/configured. */
    bookingConfig: jsonb('booking_config'),
    bookingConfigVersion: integer('booking_config_version').notNull().default(0),
    extraGuestCharge: integer('extra_guest_charge').notNull().default(0),

    // Denormalised so a listing card is one query, not N.
    ratingAvg: real('rating_avg'),
    reviewCount: integer('review_count').notNull().default(0),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    availabilityConfirmedAt: timestamp('availability_confirmed_at', { withTimezone: true }),

    /**
     * Stored when a listing is hidden, so reinstating a suspended Client
     * restores each listing to what it WAS rather than blanket-publishing.
     * A listing the owner had deliberately paused must come back paused.
     */
    priorStatus: listingStatus('prior_status'),

    /**
     * The last version an admin approved. Diffing an edit against this is the
     * only way to tell a genuine reshoot from a photo swap — which is the
     * widest fraud vector in the whole system.
     */
    approvedSnapshot: jsonb('approved_snapshot'),
    rejectionReason: text('rejection_reason'),
    /** Increments each time the listing goes back for review. */
    reviewPass: integer('review_pass').notNull().default(0),
    contentVersion: integer('content_version').notNull().default(1),
    /** Publication attribution (CP07): the exact reviewed revision that went live, by whom. */
    // FK to listing_submission is added in 0026 SQL (declared later in this file).
    publishedSubmissionId: uuid('published_submission_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => adminUsers.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rentable_city_cat_idx').on(t.cityId, t.categoryId, t.status),
    index('rentable_area_idx').on(t.areaId, t.status),
    index('rentable_client_idx').on(t.clientId),
    index('rentable_location_idx').using('gist', t.location),
  ],
);

/**
 * FIXED AMENITY TAXONOMY. Tags are PICKED, never typed.
 *
 * Free-typed amenities cannot be filtered on, cannot be translated, and turn
 * into forty spellings of "swimming pool". Labels live here in all three
 * languages because the Client side is Gujarati-first and the guest side is
 * English — the same tag has to render correctly in both.
 */
export const amenity = pgTable(
  'amenity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 60 }).notNull().unique(),
    groupSlug: varchar('group_slug', { length: 40 }).notNull(),
    labelEn: varchar('label_en', { length: 80 }).notNull(),
    labelHi: varchar('label_hi', { length: 120 }),
    labelGu: varchar('label_gu', { length: 120 }),
    valueType: amenityValueType('value_type').notNull().default('none'),
    /** Only filterable tags get a search facet; the rest are display-only. */
    isFilterable: boolean('is_filterable').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [index('amenity_group_idx').on(t.groupSlug, t.sortOrder)],
);

export const rentableAmenity = pgTable(
  'rentable_amenity',
  {
    rentableId: uuid('rentable_id').notNull()
      .references(() => rentable.id, { onDelete: 'cascade' }),
    amenityId: uuid('amenity_id').notNull()
      .references(() => amenity.id, { onDelete: 'cascade' }),
    /** e.g. "15x25" for a pool, "8" for parking. NULL when valueType='none'. */
    value: varchar('value', { length: 40 }),
  },
  (t) => [primaryKey({ columns: [t.rentableId, t.amenityId] })],
);

/**
 * GATE 2 — one row per review pass, so history survives.
 *
 * A listing that was sent back twice and then published has three rows here.
 * Overwriting a single row would lose exactly the context that makes a later
 * decision defensible.
 */
export const listingSubmission = pgTable('listing_submission', {
  id: uuid('id').primaryKey().defaultRandom(),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id),
  contentVersion: integer('content_version').notNull(),
  passNumber: integer('pass_number').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  submittedBy: uuid('submitted_by').notNull().references(() => users.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  assignedTo: uuid('assigned_to').references(() => adminUsers.id),
}, t => [uniqueIndex('listing_submission_pass_idx').on(t.rentableId, t.passNumber)]);

export const listingReview = pgTable(
  'listing_review',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rentableId: uuid('rentable_id').notNull()
      .references(() => rentable.id, { onDelete: 'cascade' }),
    passNumber: integer('pass_number').notNull().default(1),
    submissionId: uuid('submission_id').references(() => listingSubmission.id),
    /** { ownership, photos, contacts, price, rules, permits } — each a bool. */
    checklist: jsonb('checklist'),
    outcome: listingReviewOutcome('outcome').notNull(),
    reason: text('reason'),
    flaggedFields: jsonb('flagged_fields'),
    reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('listing_review_idx').on(t.rentableId, t.passNumber), uniqueIndex('listing_review_submission_idx').on(t.submissionId)],
);

/**
 * The verification visit. GPS proves it happened AT the property, which is the
 * whole point — a report filed from a sofa is worth nothing, and this is the
 * check that makes "Physically Verified" mean something.
 */
export const verificationVisit = pgTable(
  'verification_visit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rentableId: uuid('rentable_id').notNull()
      .references(() => rentable.id, { onDelete: 'cascade' }),
    mode: visitMode('mode').notNull().default('video_call'),
    assignedTo: uuid('assigned_to').references(() => adminUsers.id, { onDelete: 'set null' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Captured on site and compared against the listing's map pin. */
    geoLat: real('geo_lat'),
    geoLng: real('geo_lng'),
    /** amenities claimed vs present, condition, network, approach road, flags */
    report: jsonb('report'),
    outcome: visitOutcome('outcome'),
    recordingKey: varchar('recording_key', { length: 300 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** CP07: the immutable submitted revision this verification examines. */
    submissionId: uuid('submission_id').references(() => listingSubmission.id),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Asia/Kolkata'),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    recordedBy: uuid('recorded_by').references(() => adminUsers.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    /** Optimistic-concurrency token for reschedule, cancel and outcome commands. */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('visit_rentable_idx').on(t.rentableId, t.outcome),
    // At most one open (not completed, not cancelled) verification per property.
    uniqueIndex('verification_open_idx')
      .on(t.rentableId)
      .where(sql`${t.completedAt} IS NULL AND ${t.cancelledAt} IS NULL`),
  ],
);

/** Base price per slot. Weekend/weekday, in whole rupees. */
export const rentablePrice = pgTable(
  'rentable_price',
  {
    rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'cascade' }),
    slot: bookingSlot('slot').notNull(),
    weekday: integer('weekday').notNull(),
    weekend: integer('weekend').notNull(),
  },
  (t) => [primaryKey({ columns: [t.rentableId, t.slot] })],
);

/**
 * THE DOUBLE-BOOKING LOCK.
 *
 * Units-over-time, which degrades correctly to a calendar: a farmhouse has
 * totalUnits = 1, so "1 unit consumed" == "that slot is blocked"; chairs have
 * totalUnits = 800, so 40 consumed still leaves 760 bookable.
 *
 * The unique constraint is enforced by Postgres, not by the UI. A farmhouse
 * double-booked on a Saturday is an unrecoverable trust failure.
 */
export const availability = pgTable(
  'availability',
  {
    rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    slot: availabilitySlot('slot').notNull(),
    unitsAvailable: integer('units_available').notNull().default(1),
    priceOverride: integer('price_override'),
    blockedByClient: boolean('blocked_by_client').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.rentableId, t.day, t.slot] }),
    index('availability_day_idx').on(t.day, t.slot),
  ],
);

/** Serial-numbered physical items. Movable goods only (Phase 3); empty for places. */
export const unit = pgTable(
  'unit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'cascade' }),
    serialNo: varchar('serial_no', { length: 120 }),
    conditionGrade: varchar('condition_grade', { length: 24 }),
    status: varchar('status', { length: 24 }).notNull().default('available'),
  },
  (t) => [index('unit_rentable_idx').on(t.rentableId)],
);

/* ==========================================================================
   BOOKINGS & MONEY
   ========================================================================== */

/** Server snapshots; an unexpired quote alone never reserves inventory. */
export const bookingQuote = pgTable('booking_quote', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => users.id, { onDelete: 'restrict' }),
  intentHash: varchar('intent_hash', { length: 64 }),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  currency: varchar('currency', { length: 3 }).notNull(),
  timeZone: varchar('time_zone', { length: 64 }).notNull(),
  selection: jsonb('selection').notNull(),
  visitSnapshots: jsonb('visit_snapshots').notNull(),
  policySnapshot: jsonb('policy_snapshot').notNull(),
  paymentSnapshot: jsonb('payment_snapshot').notNull().default({}),
  pricingVersion: varchar('pricing_version', { length: 32 }).notNull(),
  policyVersion: varchar('policy_version', { length: 32 }).notNull(),
  version: integer('version').notNull(),
  quoteHash: varchar('quote_hash', { length: 64 }).notNull(),
  amountRentMinor: minor('amount_rent_minor').notNull(),
  amountFeeMinor: minor('amount_fee_minor').notNull(),
  amountDepositMinor: minor('amount_deposit_minor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  index('booking_quote_expiry_idx').on(t.expiresAt),
  check('booking_quote_valid_chk', sql`${t.currency} = 'INR' AND ${t.timeZone} = 'Asia/Kolkata'
    AND ${t.version} > 0 AND ${t.expiresAt} > ${t.createdAt}
    AND ${t.amountRentMinor} BETWEEN 0 AND 9007199254740991
    AND ${t.amountFeeMinor} BETWEEN 0 AND 9007199254740991
    AND ${t.amountDepositMinor} BETWEEN 0 AND 9007199254740991
    AND jsonb_typeof(${t.selection}) = 'object'
    AND jsonb_typeof(${t.visitSnapshots}) = 'array'
    AND jsonb_array_length(${t.visitSnapshots}) BETWEEN 1 AND 10`),
]);

export const bookingOrder = pgTable('booking_order', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: varchar('reference', { length: 64 }).notNull().unique(),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  state: bookingOrderState('state').notNull().default('draft'),
  currency: varchar('currency', { length: 3 }).notNull(),
  timeZone: varchar('time_zone', { length: 64 }).notNull(),
  quoteId: uuid('quote_id').references(() => bookingQuote.id, { onDelete: 'restrict' }),
  quoteVersion: integer('quote_version'),
  quoteHash: varchar('quote_hash', { length: 64 }),
  quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
  pricingVersion: varchar('pricing_version', { length: 32 }).notNull(),
  policyVersion: varchar('policy_version', { length: 32 }).notNull(),
  policySnapshot: jsonb('policy_snapshot').notNull(),
  listingSnapshot: jsonb('listing_snapshot').notNull(),
  amountRentMinor: minor('amount_rent_minor').notNull(),
  amountFeeMinor: minor('amount_fee_minor').notNull(),
  amountDepositMinor: minor('amount_deposit_minor').notNull(),
  amountAdvanceMinor: minor('amount_advance_minor'),
  collectedMinor: minor('collected_minor').notNull().default(0),
  paymentMode: paymentMode('payment_mode').notNull().default('legacy_unknown'),
  visitProvenance: visitProvenance('visit_provenance').notNull().default('legacy_unknown'),
  idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('booking_order_customer_key_idx').on(t.customerId, t.idempotencyKey),
  uniqueIndex('booking_order_scope_idx').on(t.id, t.customerId, t.rentableId, t.currency, t.timeZone),
  index('booking_order_history_idx').on(t.customerId, t.createdAt),
  index('booking_order_hold_idx').on(t.state, t.holdExpiresAt),
  check('booking_order_valid_chk', sql`${t.currency} = 'INR' AND ${t.timeZone} = 'Asia/Kolkata'
    AND ${t.amountRentMinor} BETWEEN 0 AND 9007199254740991
    AND ${t.amountFeeMinor} BETWEEN 0 AND 9007199254740991
    AND ${t.amountDepositMinor} BETWEEN 0 AND 9007199254740991
    AND (${t.amountAdvanceMinor} IS NULL OR ${t.amountAdvanceMinor} BETWEEN 0 AND 9007199254740991)
    AND ${t.collectedMinor} BETWEEN 0 AND 9007199254740991
    AND (${t.collectedMinor} = 0 OR ${t.paymentMode} = 'real')
    AND (${t.state} <> 'held' OR ${t.holdExpiresAt} IS NOT NULL)`),
]);

export const booking = pgTable(
  'booking',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: varchar('reference', { length: 16 }).notNull().unique(),
    rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),

    day: date('day').notNull(),
    slot: bookingSlot('slot').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    unitsBooked: integer('units_booked').notNull().default(1),
    guests: integer('guests').notNull().default(1),

    // All amounts in whole rupees. See lib/domain/pricing.js for the rules.
    amountRent: integer('amount_rent').notNull(),
    amountFee: integer('amount_fee').notNull(),
    amountDeposit: integer('amount_deposit').notNull().default(0),
    /** Advance = slice of rent + the WHOLE platform fee, so revenue is safe. */
    amountAdvancePaid: integer('amount_advance_paid').notNull().default(0),
    balanceMode: balanceMode('balance_mode').notNull().default('online_before'),
    balanceSettledAt: timestamp('balance_settled_at', { withTimezone: true }),

    state: bookingState('state').notNull().default('requested'),
    checkInCode: varchar('check_in_code', { length: 8 }),
    contactPhone: varchar('contact_phone', { length: 15 }),
    note: text('note'),

    /** Accept within the window or it auto-expires and auto-refunds in full. */
    acceptDeadline: timestamp('accept_deadline', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: userRole('cancelled_by'),
    cancellationReason: text('cancellation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /* ----------------------------------------------------------------------
       CUSTOMER PART 02 — a booking becomes one VISIT inside an order.
       Every column here is additive and nullable (or defaulted), because
       legacy rows already exist and their review/payout foreign keys must
       keep pointing at the same booking IDs. Nothing above this line moves.
       ---------------------------------------------------------------------- */

    /** The parent order. Null only for legacy rows the backfill has not reached. */
    orderId: uuid('order_id').references(() => bookingOrder.id, { onDelete: 'restrict' }),
    /** 1-based position within the order, so a 3-visit order has a stable display order. */
    itemPosition: integer('item_position'),

    /**
     * The property-LOCAL visit-start date. `day` is retained untouched for the
     * legacy readers; this column is the one the new services read, alongside
     * an explicit timezone so a date is never reinterpreted in another zone.
     */
    localDay: date('local_day'),
    timeZone: varchar('time_zone', { length: 64 }),
    currency: varchar('currency', { length: 3 }),

    /**
     * Buffer-INCLUSIVE occupied window. Distinct from starts_at/ends_at, which
     * are the guest-facing hours. The reservation ledger blocks on these.
     */
    blockedStartAt: timestamp('blocked_start_at', { withTimezone: true }),
    blockedEndAt: timestamp('blocked_end_at', { withTimezone: true }),
    /**
     * False means the exact hours are UNKNOWN, not that they are zero. Legacy
     * rows have no start/end at all, and a date whose hours are unknown cannot
     * be resold safely. Absent data must never read as a safe interval.
     */
    hoursKnown: boolean('hours_known').notNull().default(false),

    // Minor-unit mirrors of the legacy rupee columns above. See `minor`.
    amountRentMinor: minor('amount_rent_minor'),
    amountFeeMinor: minor('amount_fee_minor'),
    amountDepositMinor: minor('amount_deposit_minor'),
    /** The INTENDED advance. An intent is not a payment — see collectedMinor. */
    amountAdvanceMinor: minor('amount_advance_minor'),
    /**
     * Actual money received for this visit. Zero unless a verified real capture
     * exists, which cannot happen before Part 20. A database CHECK pins this to
     * zero for every non-real payment mode, so a simulated or legacy row can
     * never be summed into revenue or a payable balance.
     */
    collectedMinor: minor('collected_minor').notNull().default(0),

    /**
     * Payment truth and visit truth are separate facts. A real visit can carry
     * a simulated payment; a seeded row proves neither. Both default to the
     * fail-closed value so an un-backfilled row is never mistaken for real.
     */
    paymentMode: paymentMode('payment_mode').notNull().default('legacy_unknown'),
    visitProvenance: visitProvenance('visit_provenance').notNull().default('legacy_unknown'),

    policyVersion: varchar('policy_version', { length: 32 }),
    pricingVersion: varchar('pricing_version', { length: 32 }),
    /** Immutable listing facts as sold, so a retitled or repriced listing does not rewrite history. */
    listingSnapshot: jsonb('listing_snapshot'),
    policySnapshot: jsonb('policy_snapshot'),
    slotSnapshot: jsonb('slot_snapshot'),
    priceSnapshot: jsonb('price_snapshot'),
    legacyAdvanceReportedMinor: minor('legacy_advance_reported_minor'),

    /** THE IDEMPOTENCY MARKER. Set once by the backfill; its presence is what makes a rerun a no-op. */
    backfillVersion: varchar('backfill_version', { length: 32 }),
    backfilledAt: timestamp('backfilled_at', { withTimezone: true }),
    lifecycleVersion: integer('lifecycle_version').notNull().default(0),
  },
  (t) => [
    index('booking_rentable_day_idx').on(t.rentableId, t.day),
    index('booking_customer_idx').on(t.customerId, t.state),
    index('booking_state_deadline_idx').on(t.state, t.acceptDeadline),

    uniqueIndex('booking_id_rentable_idx').on(t.id, t.rentableId),
    foreignKey({ name: 'booking_order_scope_fk',
      columns: [t.orderId, t.customerId, t.rentableId, t.currency, t.timeZone],
      foreignColumns: [bookingOrder.id, bookingOrder.customerId, bookingOrder.rentableId, bookingOrder.currency, bookingOrder.timeZone],
    }),
    check('booking_order_visit_chk', sql`${t.orderId} IS NULL OR (
      ${t.itemPosition} IS NOT NULL AND ${t.itemPosition} BETWEEN 1 AND 10
      AND ${t.localDay} IS NOT NULL AND ${t.currency} IS NOT NULL AND ${t.timeZone} IS NOT NULL
      AND ${t.guests} > 0 AND ${t.unitsBooked} = 1
      AND ${t.amountRentMinor} IS NOT NULL AND ${t.amountFeeMinor} IS NOT NULL AND ${t.amountDepositMinor} IS NOT NULL)`),
    index('booking_order_idx').on(t.orderId),
    index('booking_backfill_idx').on(t.backfillVersion),
    uniqueIndex('booking_order_position_idx').on(t.orderId, t.itemPosition),
    /** One visit per order per local date and slot — a duplicated date is a bug, not a second visit. */
    uniqueIndex('booking_order_localday_slot_idx').on(t.orderId, t.localDay, t.slot),
    /** Simulated and legacy money can never become collected money. */
    check('booking_collected_requires_real_chk',
      sql`${t.collectedMinor} = 0 OR ${t.paymentMode} = 'real'`),
    check('booking_legacy_advance_chk', sql`${t.legacyAdvanceReportedMinor} IS NULL OR ${t.legacyAdvanceReportedMinor} BETWEEN 0 AND 9007199254740991`),
    check('booking_minor_amounts_nonnegative_chk',
      sql`(${t.amountRentMinor} IS NULL OR ${t.amountRentMinor} BETWEEN 0 AND 9007199254740991)
        AND (${t.amountFeeMinor} IS NULL OR ${t.amountFeeMinor} BETWEEN 0 AND 9007199254740991)
        AND (${t.amountDepositMinor} IS NULL OR ${t.amountDepositMinor} BETWEEN 0 AND 9007199254740991)
        AND (${t.amountAdvanceMinor} IS NULL OR ${t.amountAdvanceMinor} BETWEEN 0 AND 9007199254740991)
        AND ${t.collectedMinor} BETWEEN 0 AND 9007199254740991`),
    /** Known hours must actually carry an interval, and it must move forwards. */
    check('booking_known_hours_have_interval_chk',
      sql`${t.hoursKnown} = false OR (
        ${t.startsAt} IS NOT NULL AND ${t.endsAt} IS NOT NULL
        AND ${t.blockedStartAt} IS NOT NULL AND ${t.blockedEndAt} IS NOT NULL
        AND ${t.endsAt} > ${t.startsAt} AND ${t.blockedEndAt} > ${t.blockedStartAt}
        AND ${t.blockedStartAt} <= ${t.startsAt} AND ${t.blockedEndAt} >= ${t.endsAt})`),
  ],
);

/** Staged single-property ledger. Authority is switched only after Part 04 remediation.
 * The GiST exclusion is maintained in migration 0008 (Drizzle has no exclusion builder).
 * Expiry must be transitioned under the listing lock; a clock predicate is unsafe.
 */
export const inventoryReservation = pgTable('inventory_reservation', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id'), // Null for an owner block.
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  source: varchar('source', { length: 24 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason'),
  resourceKey: varchar('resource_key', { length: 64 }).notNull().default('property'),
  units: integer('units').notNull().default(1),
  blockedStartAt: timestamp('blocked_start_at', { withTimezone: true }).notNull(),
  blockedEndAt: timestamp('blocked_end_at', { withTimezone: true }).notNull(),
  state: reservationState('state').notNull(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'reservation_booking_listing_fk', columns: [t.bookingId, t.rentableId], foreignColumns: [booking.id, booking.rentableId] }),
  uniqueIndex('reservation_active_booking_idx').on(t.bookingId).where(sql`${t.state} IN ('held', 'committed')`),
  index('reservation_listing_state_idx').on(t.rentableId, t.state),
  index('reservation_expiry_idx').on(t.state, t.holdExpiresAt),
  check('reservation_valid_chk', sql`${t.blockedEndAt} > ${t.blockedStartAt}
    AND isfinite(${t.blockedStartAt}) AND isfinite(${t.blockedEndAt})
    AND ${t.units} = 1 AND ${t.resourceKey} = 'property'
    AND ((${t.source} = 'booking' AND ${t.bookingId} IS NOT NULL) OR (${t.source} = 'owner_block' AND ${t.bookingId} IS NULL))
    AND (${t.state} <> 'held' OR ${t.holdExpiresAt} IS NOT NULL)
    AND ((${t.state} IN ('released', 'expired') AND ${t.releasedAt} IS NOT NULL)
      OR (${t.state} IN ('held', 'committed') AND ${t.releasedAt} IS NULL))`),
]);

/**
 * Tax fields exist from the FIRST payout, even at zero.
 * TDS u/s 194-O applies from the first commercial payout, not from a turnover
 * threshold, and retrofitting deduction + certificates + quarterly returns
 * onto a live payout pipeline is genuinely painful. Confirm rates with a CA.
 */
export const payout = pgTable(
  'payout',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
    clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    fundingAllocationId: uuid('funding_allocation_id').references(() => paymentAllocation.id, { onDelete: 'restrict' }),
    actualNetMinor: minor('actual_net_minor').notNull().default(0),
    gross: integer('gross').notNull(),
    commission: integer('commission').notNull(),
    tds194o: integer('tds_194o').notNull().default(0),
    gstTcs: integer('gst_tcs').notNull().default(0),
    net: integer('net').notNull(),
    status: payoutStatus('status').notNull().default('pending'),
    utr: varchar('utr', { length: 64 }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payout_client_status_idx').on(t.clientId, t.status),
    uniqueIndex('payout_funding_allocation_idx').on(t.fundingAllocationId),
    check('payout_actual_funding_chk', sql`${t.actualNetMinor} BETWEEN 0 AND 9007199254740991 AND (${t.actualNetMinor} = 0 OR ${t.fundingAllocationId} IS NOT NULL)`),
  ],
);

/** Customer publication requires actual visit evidence and score-neutral moderation. */
export const review = pgTable(
  'review',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'cascade' }),
    rentableId: uuid('rentable_id').references(() => rentable.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    authorRole: userRole('author_role').notNull(),
    rating: integer('rating').notNull(),
    cleanliness: integer('cleanliness'),
    accuracy: integer('accuracy'),
    valueForMoney: integer('value_for_money'),
    behaviour: integer('behaviour'),
    moderationState: varchar('moderation_state', { length: 16 }).notNull().default('pending'),
    moderationReason: text('moderation_reason'),
    moderatedBy: uuid('moderated_by').references(() => adminUsers.id),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    ownerReply: text('owner_reply'),
    repliedBy: uuid('replied_by').references(() => users.id),
    repliedAt: timestamp('replied_at', { withTimezone: true }),

    body: text('body'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('review_booking_author_idx').on(t.bookingId, t.authorId),
    check('review_scores_chk', sql`${t.rating} BETWEEN 1 AND 5 AND (${t.cleanliness} IS NULL OR ${t.cleanliness} BETWEEN 1 AND 5) AND (${t.accuracy} IS NULL OR ${t.accuracy} BETWEEN 1 AND 5) AND (${t.valueForMoney} IS NULL OR ${t.valueForMoney} BETWEEN 1 AND 5)`),
    check('review_moderation_chk', sql`${t.moderationState} IN ('pending','published','rejected','hidden') AND (${t.moderationState}='published') = (${t.publishedAt} IS NOT NULL) AND ${t.version}>=0`),
  ],
);

/**
 * 301 map from day one, so a changed area or listing slug never 404s.
 * Cheap now; essential the first time someone renames a listing.
 */
export const redirect = pgTable('redirect', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromPath: varchar('from_path', { length: 512 }).notNull().unique(),
  toPath: varchar('to_path', { length: 512 }).notNull(),
  statusCode: integer('status_code').notNull().default(301),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Explicit per-date rates, including full_day. New values are in paise. */
export const bookingPriceOverride = pgTable('booking_price_override', {
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  day: date('day').notNull(),
  slot: bookingSlot('slot').notNull(),
  rentMinor: minor('rent_minor').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.rentableId, t.day, t.slot] }),
  check('booking_price_override_amount_chk', sql`${t.rentMinor} BETWEEN 0 AND 9007199254740991`),
]);

/* ==========================================================================
   CUSTOMER PART 03 — immutable financial facts, separate from booking state.
   Cross-row reconciliation and immutability triggers live in migration 0009.
   ========================================================================== */
export const paymentEnvironment = pgEnum('payment_environment', ['simulated', 'test', 'live']);
/** Immutable admin revisions; no row means new online payments are disabled. */
export const paymentGatewayConfig = pgTable('payment_gateway_config', {
  version: integer('version').primaryKey(),
  provider: varchar('provider', { length: 32 }).notNull(),
  environment: paymentEnvironment('environment').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  collectionPurpose: varchar('collection_purpose', { length: 16 }).notNull().default('full'),
  changedBy: uuid('changed_by').notNull().references(() => adminUsers.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('payment_gateway_config_valid_chk', sql`${t.version} > 0 AND ${t.environment} = 'test'
    AND ${t.provider} = 'razorpay' AND ${t.collectionPurpose} IN ('full', 'advance')`),
]);
export const paymentPurpose = pgEnum('payment_purpose', ['advance', 'balance', 'deposit', 'full']);
export const paymentState = pgEnum('payment_state', ['created', 'processing', 'unknown', 'succeeded', 'failed', 'cancelled']);
export const paymentTransactionKind = pgEnum('payment_transaction_kind', ['simulated', 'authorization', 'capture', 'failure']);
export const paymentComponent = pgEnum('payment_component', ['rent', 'fee', 'tax', 'deposit']);
export const refundState = pgEnum('refund_state', ['requested', 'processing', 'unknown', 'succeeded', 'failed']);
export const paymentEventState = pgEnum('payment_event_state', ['received', 'processing', 'processed', 'failed']);

const financialScope = () => ({
  provider: varchar('provider', { length: 32 }).notNull(),
  environment: paymentEnvironment('environment').notNull(),
  mode: paymentMode('mode').notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
});
const financialScopeCheck = (name, t) => check(name, sql`${t.currency} = 'INR'
  AND length(trim(${t.provider})) > 0
  AND ((${t.mode} = 'simulated' AND ${t.provider} = 'dummy' AND ${t.environment} = 'simulated')
    OR (${t.mode} = 'real' AND ${t.provider} <> 'dummy' AND ${t.environment} IN ('test', 'live')))`);
const safeMinor = (name, ...columns) => check(name, sql.join(columns.map((c) => sql`${c} BETWEEN 0 AND 9007199254740991`), sql` AND `));

export const customerPaymentMethod = pgTable('customer_payment_method', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  provider: varchar('provider', { length: 32 }).notNull(),
  environment: paymentEnvironment('environment').notNull(),
  providerCustomerId: varchar('provider_customer_id', { length: 160 }).notNull(),
  // Encrypted application-side provider reference; never PAN, CVV, UPI PIN or raw bank details.
  tokenCiphertext: text('token_ciphertext').notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  methodFamily: varchar('method_family', { length: 24 }).notNull(),
  displayLabel: varchar('display_label', { length: 80 }).notNull(),
  last4: varchar('last4', { length: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payment_method_token_idx').on(t.provider, t.environment, t.tokenHash),
  uniqueIndex('payment_method_default_idx').on(t.customerId, t.provider, t.environment).where(sql`${t.isActive} AND ${t.isDefault}`),
  check('payment_method_real_only_chk', sql`${t.environment} IN ('test', 'live') AND ${t.provider} <> 'dummy'
    AND length(trim(${t.provider})) > 0 AND ${t.tokenHash} ~ '^[a-f0-9]{64}$'
    AND length(${t.tokenCiphertext}) > 0 AND (${t.last4} IS NULL OR ${t.last4} ~ '^[0-9]{4}$')
    AND ((${t.isActive} AND ${t.revokedAt} IS NULL) OR (NOT ${t.isActive} AND NOT ${t.isDefault} AND ${t.revokedAt} IS NOT NULL))`),
]);

export const paymentOrder = pgTable('payment_order', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingOrderId: uuid('booking_order_id').notNull().references(() => bookingOrder.id, { onDelete: 'restrict' }),
  ...financialScope(),
  purpose: paymentPurpose('purpose').notNull(),
  expectedMinor: minor('expected_minor').notNull(),
  providerOrderId: varchar('provider_order_id', { length: 160 }),
  state: paymentState('state').notNull().default('created'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payment_order_external_idx').on(t.provider, t.environment, t.providerOrderId),
  uniqueIndex('payment_order_key_idx').on(t.bookingOrderId, t.idempotencyKey),
  financialScopeCheck('payment_order_scope_chk', t),
  safeMinor('payment_order_amount_chk', t.expectedMinor),
  check('payment_order_key_chk', sql`length(trim(${t.idempotencyKey})) > 0 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`),
]);

/** Part 11: immutable execution scope, with a recoverable external-call state. */
export const paymentExecution = pgTable('payment_execution', {
  paymentOrderId: uuid('payment_order_id').primaryKey().references(() => paymentOrder.id, { onDelete: 'restrict' }),
  configVersion: integer('config_version').notNull().references(() => paymentGatewayConfig.version, { onDelete: 'restrict' }),
  credentialKeyId: varchar('credential_key_id', { length: 160 }).notNull(),
  snapshot: jsonb('snapshot').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ready'),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
  failureCode: varchar('failure_code', { length: 64 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('payment_execution_state_chk', sql`${t.state} IN ('ready','dispatched','unknown','linked')`),
  check('payment_execution_test_key_chk', sql`${t.credentialKeyId} ~ '^rzp_test_[A-Za-z0-9]+$'`),
  index('payment_execution_work_idx').on(t.nextCheckAt),
]);

export const bookingLifecycleEvent = pgTable('booking_lifecycle_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => bookingOrder.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 40 }).notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('booking_lifecycle_once_idx').on(t.orderId, t.kind)]);

export const paymentAttempt = pgTable('payment_attempt', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentOrderId: uuid('payment_order_id').notNull().references(() => paymentOrder.id, { onDelete: 'restrict' }),
  ...financialScope(),
  attemptNumber: integer('attempt_number').notNull(),
  providerPaymentId: varchar('provider_payment_id', { length: 160 }),
  methodId: uuid('method_id').references(() => customerPaymentMethod.id, { onDelete: 'restrict' }),
  methodFamily: varchar('method_family', { length: 24 }),
  expectedMinor: minor('expected_minor').notNull(),
  state: paymentState('state').notNull().default('created'),
  failureCode: varchar('failure_code', { length: 64 }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('payment_attempt_number_idx').on(t.paymentOrderId, t.attemptNumber),
  uniqueIndex('payment_attempt_external_idx').on(t.provider, t.environment, t.providerPaymentId),
  uniqueIndex('payment_attempt_active_idx').on(t.paymentOrderId).where(sql`${t.state} IN ('created', 'processing', 'unknown')`),
  financialScopeCheck('payment_attempt_scope_chk', t),
  safeMinor('payment_attempt_amount_chk', t.expectedMinor),
  check('payment_attempt_valid_chk', sql`${t.attemptNumber} > 0 AND (${t.mode} <> 'simulated' OR (${t.methodId} IS NULL AND ${t.methodFamily} IS NULL))`),
]);

export const paymentTransaction = pgTable('payment_transaction', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().references(() => paymentAttempt.id, { onDelete: 'restrict' }),
  reference: varchar('reference', { length: 100 }).notNull().unique(),
  ...financialScope(),
  providerPaymentId: varchar('provider_payment_id', { length: 160 }),
  externalLedgerId: varchar('external_ledger_id', { length: 160 }),
  kind: paymentTransactionKind('kind').notNull(),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  expectedMinor: minor('expected_minor').notNull(),
  simulatedMinor: minor('simulated_minor').notNull().default(0),
  authorizedMinor: minor('authorized_minor').notNull().default(0),
  capturedMinor: minor('captured_minor').notNull().default(0),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  evidenceHash: varchar('evidence_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payment_transaction_external_idx').on(t.provider, t.environment, t.externalLedgerId, t.kind),
  index('payment_transaction_attempt_idx').on(t.attemptId),
  financialScopeCheck('payment_transaction_scope_chk', t),
  safeMinor('payment_transaction_amount_chk', t.expectedMinor, t.simulatedMinor, t.authorizedMinor, t.capturedMinor),
  check('payment_transaction_fact_chk', sql`
    (${t.mode} = 'simulated' AND ${t.kind} = 'simulated' AND ${t.outcome} = 'succeeded'
      AND left(${t.reference}, 10) = 'DUMMY_TXN_' AND ${t.authorizedMinor} = 0 AND ${t.capturedMinor} = 0
      AND ${t.simulatedMinor} = ${t.expectedMinor})
    OR (${t.mode} = 'real' AND ${t.simulatedMinor} = 0 AND ${t.providerPaymentId} IS NOT NULL
      AND ${t.externalLedgerId} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL AND ${t.evidenceHash} ~ '^[a-f0-9]{64}$'
      AND ${t.evidenceHash} IS NOT NULL AND (
        (${t.kind} = 'authorization' AND ${t.outcome} = 'succeeded' AND ${t.authorizedMinor} > 0 AND ${t.authorizedMinor} <= ${t.expectedMinor} AND ${t.capturedMinor} = 0)
        OR (${t.kind} = 'capture' AND ${t.outcome} = 'succeeded' AND ${t.capturedMinor} > 0 AND ${t.capturedMinor} <= ${t.expectedMinor} AND ${t.authorizedMinor} = 0)
        OR (${t.kind} = 'failure' AND ${t.outcome} = 'failed' AND ${t.capturedMinor} = 0 AND ${t.authorizedMinor} = 0)))`),
]);

export const paymentAllocation = pgTable('payment_allocation', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id').notNull().references(() => paymentTransaction.id, { onDelete: 'restrict' }),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
  component: paymentComponent('component').notNull(),
  actualMinor: minor('actual_minor').notNull().default(0),
  simulatedMinor: minor('simulated_minor').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payment_allocation_visit_component_idx').on(t.transactionId, t.bookingId, t.component),
  index('payment_allocation_booking_idx').on(t.bookingId),
  safeMinor('payment_allocation_amount_chk', t.actualMinor, t.simulatedMinor),
]);

export const refund = pgTable('refund', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id').notNull().references(() => paymentTransaction.id, { onDelete: 'restrict' }),
  reference: varchar('reference', { length: 100 }).notNull().unique(),
  ...financialScope(),
  providerRefundId: varchar('provider_refund_id', { length: 160 }),
  expectedMinor: minor('expected_minor').notNull(),
  actualMinor: minor('actual_minor').notNull().default(0),
  reason: varchar('reason', { length: 160 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 160 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  state: refundState('state').notNull().default('requested'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  evidenceHash: varchar('evidence_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('refund_external_idx').on(t.provider, t.environment, t.providerRefundId),
  uniqueIndex('refund_key_idx').on(t.transactionId, t.idempotencyKey),
  financialScopeCheck('refund_scope_chk', t),
  safeMinor('refund_amount_chk', t.expectedMinor, t.actualMinor),
  check('refund_fact_chk', sql`length(trim(${t.idempotencyKey})) > 0 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'
    AND ((${t.mode} = 'simulated' AND ${t.actualMinor} = 0)
      OR (${t.mode} = 'real' AND (
        (${t.state} <> 'succeeded' AND ${t.actualMinor} = 0)
        OR (${t.state} = 'succeeded' AND ${t.actualMinor} = ${t.expectedMinor}
          AND ${t.verifiedAt} IS NOT NULL AND ${t.providerRefundId} IS NOT NULL
          AND ${t.evidenceHash} IS NOT NULL AND ${t.evidenceHash} ~ '^[a-f0-9]{64}$'))))`),
]);

export const refundAllocation = pgTable('refund_allocation', {
  id: uuid('id').primaryKey().defaultRandom(),
  refundId: uuid('refund_id').notNull().references(() => refund.id, { onDelete: 'restrict' }),
  paymentAllocationId: uuid('payment_allocation_id').notNull().references(() => paymentAllocation.id, { onDelete: 'restrict' }),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
  component: paymentComponent('component').notNull(),
  expectedMinor: minor('expected_minor').notNull(),
  actualMinor: minor('actual_minor').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('refund_allocation_source_idx').on(t.refundId, t.paymentAllocationId),
  index('refund_allocation_source_lookup_idx').on(t.paymentAllocationId),
  safeMinor('refund_allocation_amount_chk', t.expectedMinor, t.actualMinor),
  check('refund_allocation_cap_chk', sql`${t.actualMinor} <= ${t.expectedMinor}`),
]);

export const paymentEvent = pgTable('payment_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: varchar('provider', { length: 32 }).notNull(),
  environment: paymentEnvironment('environment').notNull(),
  externalEventId: varchar('external_event_id', { length: 160 }).notNull(),
  payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  // Only normalized, allowlisted metadata belongs here. Raw payloads/secrets are not retained.
  redactedPayload: jsonb('redacted_payload').notNull().default({}),
  signatureVerifiedAt: timestamp('signature_verified_at', { withTimezone: true }).notNull(),
  state: paymentEventState('state').notNull().default('received'),
  attempts: integer('attempts').notNull().default(0),
  failureCode: varchar('failure_code', { length: 64 }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('payment_event_external_idx').on(t.provider, t.environment, t.externalEventId),
  index('payment_event_work_idx').on(t.state, t.receivedAt),
  check('payment_event_valid_chk', sql`${t.provider} <> 'dummy' AND length(trim(${t.provider})) > 0
    AND ${t.environment} IN ('test', 'live') AND length(trim(${t.externalEventId})) > 0
    AND ${t.attempts} >= 0 AND ${t.payloadHash} ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(${t.redactedPayload}) = 'object'`),
]);

export const paymentEventJob = pgTable('payment_event_job', {
  eventId: uuid('event_id').primaryKey().references(() => paymentEvent.id, { onDelete: 'restrict' }),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('payment_event_job_due_idx').on(t.nextAttemptAt)]);

/** No listing FK: a deleted listing remains a removable unavailable saved place. */
export const customerFavourite = pgTable('customer_favourite', {
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  rentableId: uuid('rentable_id').notNull(),
  selection: jsonb('selection'),
  active: boolean('active').notNull().default(true),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns:[t.customerId,t.rentableId] })]);

export const customerFavouriteMerge = pgTable('customer_favourite_merge', {
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entryId: uuid('entry_id').notNull(),
  mergedAt: timestamp('merged_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns:[t.customerId,t.entryId] })]);

export const bookingCancellation = pgTable('booking_cancellation', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => bookingOrder.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  idempotencyKey: uuid('idempotency_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('cancellation_request_idx').on(t.customerId, t.idempotencyKey)]);

export const refundExecution = pgTable('refund_execution', {
  refundId: uuid('refund_id').primaryKey().references(() => refund.id, { onDelete: 'restrict' }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
  failureCode: varchar('failure_code', { length: 64 }),
}, t => [index('refund_execution_work_idx').on(t.nextCheckAt)]);

export const visitEvidence = pgTable('visit_evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  nature: varchar('nature', { length: 16 }).notNull(),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull(),
  note: text('note').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
}, t => [uniqueIndex('visit_evidence_kind_idx').on(t.bookingId, t.kind),
  uniqueIndex('visit_evidence_request_idx').on(t.actorKind, t.actorId, t.requestKey),
  check('visit_evidence_valid_chk', sql`${t.kind} IN ('handover','return','complete') AND ${t.nature} IN ('actual','simulation')
    AND ${t.actorKind} IN ('owner','admin') AND length(trim(${t.note})) BETWEEN 20 AND 1000
    AND ${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.occurredAt} <= ${t.recordedAt}`)]);

export const notificationOutbox = pgTable('notification_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => bookingOrder.id, { onDelete: 'restrict' }),
  bookingId: uuid('booking_id').references(() => booking.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  eventKey: varchar('event_key', { length: 160 }).notNull(),
  template: varchar('template', { length: 24 }).notNull(),
  channel: varchar('channel', { length: 16 }).notNull().default('sms'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  state: varchar('state', { length: 20 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  providerId: varchar('provider_id', { length: 40 }),
  providerAccount: varchar('provider_account', { length: 40 }),
  recipient: varchar('recipient', { length: 20 }),
  sender: varchar('sender', { length: 20 }),
  bodyHash: varchar('body_hash', { length: 64 }),
  failureCode: varchar('failure_code', { length: 64 }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('notification_event_recipient_idx').on(t.eventKey, t.customerId, t.channel),
  index('notification_due_idx').on(t.state, t.nextAttemptAt), index('notification_customer_idx').on(t.customerId, t.scheduledAt),
  check('notification_valid_chk', sql`${t.template} IN ('confirmation','reminder','cancellation','refund','completion','review_invitation')
    AND ${t.channel}='sms' AND ${t.attempts}>=0 AND ${t.state} IN ('pending','blocked','retry','sending','unknown','accepted','delivered','undelivered','suppressed','failed')`)]);

export const reviewReport = pgTable('review_report', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id').notNull().references(() => review.id, { onDelete: 'restrict' }),
  reporterId: uuid('reporter_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('open'),
  resolution: text('resolution'),
  resolvedBy: uuid('resolved_by').references(() => adminUsers.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('review_report_author_idx').on(t.reviewId, t.reporterId),
  check('review_report_valid_chk', sql`${t.state} IN ('open','closed') AND length(trim(${t.reason})) BETWEEN 10 AND 1000 AND (${t.state}='open' OR (${t.resolution} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL))`)]);

export const supportRequest = pgTable('support_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: varchar('reference', { length: 40 }).notNull().unique(),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  orderId: uuid('order_id').references(() => bookingOrder.id, { onDelete: 'restrict' }),
  privacyRequestId: uuid('privacy_request_id').references(() => customerPrivacyRequest.id, { onDelete: 'restrict' }),
  category: varchar('category', { length: 24 }).notNull(),
  subject: varchar('subject', { length: 120 }).notNull(),
  context: jsonb('context').notNull(),
  policyVersion: varchar('policy_version', { length: 32 }).notNull(),
  state: varchar('state', { length: 20 }).notNull().default('open'),
  version: integer('version').notNull().default(0),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('support_request_replay_idx').on(t.customerId, t.requestKey),
  index('support_request_inbox_idx').on(t.state, t.updatedAt), index('support_request_customer_idx').on(t.customerId, t.createdAt),
  check('support_request_valid_chk', sql`${t.category} IN ('booking','change','cancellation','payment','privacy','other')
    AND ${t.state} IN ('open','in_progress','waiting_customer','resolved') AND ${t.version}>=0
    AND length(trim(${t.subject})) BETWEEN 5 AND 120 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'
    AND (${t.category} NOT IN ('booking','change','cancellation','payment') OR ${t.orderId} IS NOT NULL)
    AND (${t.privacyRequestId} IS NULL OR (${t.category}='privacy' AND ${t.orderId} IS NULL))`)]);

export const supportMessage = pgTable('support_message', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => supportRequest.id, { onDelete: 'restrict' }),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull(),
  body: text('body').notNull(),
  stateAfter: varchar('state_after', { length: 20 }).notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('support_message_replay_idx').on(t.actorKind, t.actorId, t.requestKey),
  index('support_message_thread_idx').on(t.requestId, t.createdAt),
  check('support_message_valid_chk', sql`${t.actorKind} IN ('customer','admin') AND length(trim(${t.body})) BETWEEN 2 AND 5000
    AND ${t.stateAfter} IN ('open','in_progress','waiting_customer','resolved') AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`)]);
