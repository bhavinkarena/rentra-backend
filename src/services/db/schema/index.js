import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, varchar, integer, bigint, boolean, timestamp,
  date, jsonb, real, geometry, uniqueIndex, index, primaryKey, check, foreignKey, smallint,
} from 'drizzle-orm/pg-core';

/** Aggregate-only measurement: bounded dimensions, no per-person event history. */
export const customerMeasurement = pgTable('customer_measurement', {
  day: date('day').notNull(),
  event: varchar('event', { length: 32 }).notNull(),
  source: varchar('source', { length: 8 }).notNull(),
  device: varchar('device', { length: 8 }).notNull(),
  visits: varchar('visits', { length: 8 }).notNull(),
  vertical: varchar('vertical', { length: 24 }).notNull().default('unknown'),
  count: integer('count').notNull(),
}, t => [primaryKey({ name: 'customer_measurement_pk', columns: [t.day, t.event, t.source, t.device, t.visits, t.vertical] }),
  check('customer_measurement_bounds_chk', sql`${t.count} BETWEEN 1 AND 1000000
    AND ${t.device} IN ('mobile','desktop','unknown') AND ${t.visits} IN ('single','multiple','unknown')
    AND ${t.vertical} IN ('farmhouse','entertainment','unknown')
    AND ((${t.source}='browser' AND ${t.event} IN ('search_submitted','listing_viewed','dates_selected','history_viewed','share_attempted','share_completed',
      'vertical_switched','times_viewed','time_selected'))
      OR (${t.source}='server' AND ${t.event} IN ('quote_ready','login_completed','checkout_started','inventory_conflict','quote_changed','payment_unavailable','otp_request_rejected','otp_rejected')))`),
]);

export const serviceHealth = pgTable('service_health', {
  service: varchar('service', { length: 16 }).primaryKey(),
  healthy: boolean('healthy').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
}, t => [check('service_health_name_chk', sql`${t.service} IN ('payments','notifications')`)]);

export const operationalIncident = pgTable('operational_incident', {
  code: varchar('code', { length: 48 }).primaryKey(),
  status: varchar('status', { length: 16 }).notNull().default('open'),
  assigneeId: uuid('assignee_id').references(() => adminUsers.id, { onDelete: 'restrict' }),
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('operational_incident_status_chk', sql`${t.status} IN ('open','acknowledged','escalated','resolved') AND ${t.version}>0`)]);

export const operationalIncidentEvent = pgTable('operational_incident_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 48 }).notNull().references(() => operationalIncident.code, { onDelete: 'restrict' }),
  actorId: uuid('actor_id').notNull().references(() => adminUsers.id, { onDelete: 'restrict' }),
  requestKey: uuid('request_key').notNull(),
  payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  action: varchar('action', { length: 16 }).notNull(),
  note: text('note').notNull(),
  details: jsonb('details').notNull().default({}),
  signalCount: integer('signal_count').notNull(),
  sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('operational_incident_event_code_idx').on(t.code, t.at),
  uniqueIndex('operational_incident_event_request_key_idx').on(t.requestKey),
  check('operational_incident_event_chk', sql`${t.action} IN ('open','reopen','assign','note','acknowledge','snooze','escalate','resolve') AND char_length(${t.note}) BETWEEN 8 AND 2000 AND ${t.signalCount}>=0 AND ${t.payloadHash} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.details})='object'`),
]);

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


export const auditActor = pgEnum('audit_actor', [
  'client', 'customer', 'admin', 'system',
  // CP16: an owner's caretaker acting on an assigned visit.
  'staff',
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
/** 'hour' (0053): time booking on a start/duration grid per court. The engine branches on rentable.rental_unit. */
export const rentalUnit = pgEnum('rental_unit', ['slot', 'night', 'day', 'week', 'month', 'hour']);

/**
 * Availability is stored per DAY and per NIGHT only.
 * `full_day` is a booking-level concept that consumes BOTH rows — keeping it
 * out of this enum makes that invariant impossible to violate.
 */
export const availabilitySlot = pgEnum('availability_slot', ['day', 'night']);
/** 'hourly' (0053): a time-booked visit; it must name its court (booking_resource_slot_chk). */
export const bookingSlot = pgEnum('booking_slot', ['day', 'night', 'full_day', 'hourly']);

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
  'completed', 'cancelled', 'disputed','no_show',
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
 * Role lookup. The code is the key, so `role = 'client'` filters keep working.
 * One account = one role, fixed at signup. Admins and caretakers are separate principals.
 */
export const role = pgTable('role', {
  ownerNote:text('owner_note').notNull().default(''),
  code: varchar('code', { length: 16 }).primaryKey(),
  label: varchar('label', { length: 60 }).notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('role_code_chk', sql`${t.code} ~ '^[a-z_]{3,16}$'`)]);

export const users = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: varchar('phone', { length: 15 }),
    role: varchar('role', { length: 16 }).notNull().references(() => role.code, { onDelete: 'restrict', onUpdate: 'restrict' }),
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
    privacyErasurePending: boolean('privacy_erasure_pending').notNull().default(false),
    privacyErasedAt: timestamp('privacy_erased_at', { withTimezone: true }),
    preferredLocale: varchar('preferred_locale', { length: 5 }).notNull().default('en'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    // Profile (was customer_profile). profile_completed_at replaces "the profile row exists".
    photoPublicId: text('photo_public_id'),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentUpdatedAt: timestamp('consent_updated_at', { withTimezone: true }),
    profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true }),
    /** Self-service edit token: customer profile/photo edits and client inbox preferences. */
    profileVersion: integer('profile_version').notNull().default(0),
    /** Client inbox: informational categories delivered already read (was client_update_preference). */
    ownerGuide: jsonb('owner_guide').notNull().default({}),
    notificationPrefs: jsonb('notification_prefs').notNull().default({}),
    mutedUpdateCategories: jsonb('muted_update_categories').notNull().default([]),

    clientType: clientType('client_type'),
    kycStatus: kycStatus('kyc_status').notNull().default('none'),
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
    uniqueIndex('user_email_role_ci_idx').on(sql`lower(${t.email})`, t.role),
    index('user_status_idx').on(t.role, t.accountStatus),
    uniqueIndex('user_id_role_idx').on(t.id, t.role),
    check('user_client_fields_chk', sql`${t.role} = 'client' OR (${t.clientType} IS NULL AND ${t.kycStatus} = 'none'
      AND ${t.mutedUpdateCategories} = '[]'::jsonb AND ${t.respondsWithinMins} IS NULL AND ${t.responseRate} IS NULL)`),
    check('user_customer_fields_chk', sql`${t.role} IN ('customer','client') OR (${t.privacyErasurePending} = false AND ${t.privacyErasedAt} IS NULL)`),
    check('owner_notification_prefs_chk',sql`jsonb_typeof(${t.notificationPrefs})='object'`),
    check('user_muted_shape_chk', sql`jsonb_typeof(${t.mutedUpdateCategories}) = 'array'`),
    check('user_owner_guide_object_chk', sql`jsonb_typeof(${t.ownerGuide}) = 'object'`),
    check('user_versions_chk', sql`${t.profileVersion} >= 0 AND ${t.lifecycleVersion} > 0`),
  ],
);

/**
 * One-time codes for every principal (customer, client, caretaker). Only an HMAC
 * of the code is stored, never the code, so a database leak cannot be replayed.
 * Customer challenges are also bound to the browser and the delivery mode.
 */
export const otpChallenge = pgTable('otp_challenge', {
  id: uuid('id').primaryKey().defaultRandom(),
  principalKind: varchar('principal_kind', { length: 10 }).notNull(),
  channel: varchar('channel', { length: 8 }).notNull(),
  purpose: varchar('purpose', { length: 32 }).notNull(),
  /** Normalised phone, lower-cased email, or `staff:<phone>`. */
  identifier: varchar('identifier', { length: 254 }).notNull(),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  browserHash: varchar('browser_hash', { length: 64 }),
  deliveryMode: varchar('delivery_mode', { length: 16 }).notNull(),
  delivered: boolean('delivered').notNull().default(false),
  attempts: integer('attempts').notNull().default(0),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => authSession.id, { onDelete: 'cascade' }),
  originalPhone: varchar('original_phone', { length: 15 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('otp_challenge_lookup_idx').on(t.principalKind, t.identifier, t.purpose, t.createdAt),
  index('otp_challenge_user_idx').on(t.userId).where(sql`${t.userId} IS NOT NULL`),
  index('otp_challenge_session_idx').on(t.sessionId).where(sql`${t.sessionId} IS NOT NULL`),
  index('otp_challenge_purge_idx').on(t.createdAt),
  check('otp_challenge_valid_chk', sql`${t.principalKind} IN ('customer','client','staff') AND ${t.channel} IN ('sms','email')
    AND ${t.purpose} IN ('login','verify_phone','phone_change','payout_confirm','owner_email_change','owner_phone_change') AND ${t.attempts} >= 0
    AND ${t.codeHash} ~ '^[a-f0-9]{64}$' AND ${t.expiresAt} > ${t.createdAt}
    AND (${t.browserHash} IS NULL OR ${t.browserHash} ~ '^[a-f0-9]{64}$')
    AND (${t.purpose} NOT IN ('payout_confirm','owner_email_change','owner_phone_change') OR (${t.principalKind} = 'client' AND ${t.userId} IS NOT NULL AND ${t.sessionId} IS NOT NULL))
    AND (${t.purpose} <> 'phone_change' OR (${t.principalKind} = 'customer' AND ${t.userId} IS NOT NULL AND ${t.sessionId} IS NOT NULL))`),
]);

/** HMAC identifiers only; includes failed verification and failed delivery. */
export const authRateEvent = pgTable('auth_rate_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  principalKind: varchar('principal_kind', { length: 10 }).notNull().default('customer'),
  identifierHash: varchar('identifier_hash', { length: 64 }).notNull(),
  ipHash: varchar('ip_hash', { length: 64 }).notNull(),
  kind: varchar('kind', { length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('auth_rate_identifier_idx').on(t.identifierHash, t.kind, t.createdAt),
  index('auth_rate_ip_idx').on(t.ipHash, t.kind, t.createdAt),
  index('auth_rate_event_purge_idx').on(t.createdAt),
  check('auth_rate_event_valid_chk', sql`${t.principalKind} IN ('customer','client','staff') AND ${t.kind} IN ('request','verify')
    AND ${t.identifierHash} ~ '^[a-f0-9]{64}$' AND ${t.ipHash} ~ '^[a-f0-9]{64}$'`),
]);

export const customerPrivacyRequest = pgTable('customer_privacy_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('open'),
  version: integer('version').notNull().default(1),
  review: jsonb('review'),
  receipt: jsonb('receipt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('customer_privacy_kind_chk', sql`${t.kind} IN ('access', 'deletion')`),
  check('customer_privacy_state_chk', sql`${t.state} IN ('open', 'in_review', 'closed')`),
  uniqueIndex('customer_privacy_active_idx').on(t.customerId, t.kind).where(sql`${t.state} <> 'closed'`),
  index('customer_privacy_queue_idx').on(t.state, t.createdAt),
]);

export const privacyJob = pgTable('privacy_job', {
  requestId: uuid('request_id').primaryKey().references(() => customerPrivacyRequest.id, { onDelete: 'restrict' }),
  state: varchar('state', { length: 16 }).notNull().default('queued'),
  stage: integer('stage').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  results: jsonb('results').notNull().default([]),
  errorCode: varchar('error_code', { length: 64 }),
  artifactCiphertext: text('artifact_ciphertext'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  photoKey: text('photo_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('privacy_job_work_idx').on(t.state,t.updatedAt),
  index('privacy_job_artifact_exp_idx').on(t.expiresAt).where(sql`${t.artifactCiphertext} IS NOT NULL`),
  check('privacy_job_state_chk', sql`${t.state} IN ('queued','running','failed','completed') AND ${t.stage} BETWEEN 0 AND 4 AND ${t.attempts}>=0`)]);

export const documentType = pgEnum('document_type', [
  // Identity — Gate 1
  'pan_card', 'aadhaar_masked', 'passport', 'driving_licence', 'voter_id',
  // Ownership — Gate 2, per listing
  'electricity_bill', 'property_tax', 'extract_7_12', 'extract_8a',
  'index_ii', 'sale_deed', 'na_order', 'authorisation_letter', 'noc',
  // Venue proof (0053): many play venues are leased commercial premises.
  'rent_agreement', 'shop_establishment', 'gst_certificate',
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
    reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    reviewNote: text('review_note'),

    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'restrict' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    /** Retention: set when the file is destroyed in Cloudinary. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    /** Generated from owner_type/owner_id so each owner kind has a real FK (0049). */
    applicationId: uuid('application_id')
      .generatedAlwaysAs(sql`CASE WHEN owner_type = 'client_application' THEN owner_id END`)
      .references(() => clientApplication.id, { onDelete: 'restrict' }),
    rentableId: uuid('rentable_id')
      .generatedAlwaysAs(sql`CASE WHEN owner_type = 'rentable' THEN owner_id END`)
      .references(() => rentable.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('document_owner_idx').on(t.ownerType, t.ownerId, t.status),
    // One LIVE file per (owner, type, side). A re-upload marks the previous row superseded.
    uniqueIndex('document_live_slot_idx').on(t.ownerType, t.ownerId, t.docType, t.side)
      .where(sql`${t.status} IN ('uploaded','accepted','rejected') AND ${t.deletedAt} IS NULL`),
    index('document_application_idx').on(t.applicationId).where(sql`${t.applicationId} IS NOT NULL`),
    index('document_rentable_idx').on(t.rentableId).where(sql`${t.rentableId} IS NOT NULL`),
    check('document_owner_chk', sql`${t.ownerType} IN ('client_application','rentable') AND num_nonnulls(${t.applicationId}, ${t.rentableId}) = 1`),
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
      .references(() => users.id, { onDelete: 'restrict' }),
    status: applicationStatus('status').notNull().default('draft'),

    // --- their details ---
    legalName: varchar('legal_name', { length: 160 }),
    residentialAddress: text('residential_address'),
    pincode: varchar('pincode', { length: 6 }),
    intendedListingCount: integer('intended_listing_count'),

    // --- the agent path ---
    ownerName: varchar('owner_name', { length: 160 }),
    ownerRelationship: varchar('owner_relationship', { length: 80 }),

    // --- KYC evidence. The verdict lives on user.kyc_status; files live in document. --
    kycDocType: varchar('kyc_doc_type', { length: 16 }), // 'pan' | 'aadhaar'
    kycNameOnDoc: varchar('kyc_name_on_doc', { length: 160 }),

    // Payout details live only in payout_destination (read through the client_payout_current view).

    // --- consent ---
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentIp: varchar('consent_ip', { length: 45 }),

    // --- review ---
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
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
    correlationId: uuid('correlation_id'),
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
  securityVersion: integer('security_version').notNull().default(1),
  enrollmentHash: text('enrollment_hash'),
  enrollmentSecret: text('enrollment_secret'),
  enrollmentExpiresAt: timestamp('enrollment_expires_at', { withTimezone: true }),
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
export const adminExportJob = pgTable('admin_export_job', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').notNull().references(() => adminUsers.id, { onDelete: 'restrict' }),
  requestKey: uuid('request_key').notNull(),
  dataset: varchar('dataset', { length: 32 }).notNull(),
  scope: jsonb('scope').notNull(),
  reason: text('reason').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('queued'),
  version: integer('version').notNull().default(1),
  attempts: integer('attempts').notNull().default(0),
  errorCode: varchar('error_code', { length: 64 }),
  artifactCiphertext: text('artifact_ciphertext'),
  receipt: jsonb('receipt'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('admin_export_request_idx').on(t.creatorId, t.requestKey),
  index('admin_export_work_idx').on(t.state, t.updatedAt),
  index('admin_export_queue_idx').on(t.createdAt, t.id).where(sql`${t.state} = 'queued'`),
  index('admin_export_artifact_exp_idx').on(t.expiresAt).where(sql`${t.artifactCiphertext} IS NOT NULL`),
  check('admin_export_state_chk', sql`${t.state} IN ('queued','failed','completed') AND ${t.version}>0 AND ${t.attempts}>=0 AND ${t.dataset} IN ('audit_events','payment_orders','operation_receipts')`),
]);

export const clientStaff = pgTable(
  'client_staff',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    phone: varchar('phone', { length: 15 }).notNull(),
    name: varchar('name', { length: 160 }),
    // CP16: { evidence: boolean } — record handover/return/completion. Never
    // earnings, pricing, KYC or staff administration: those are not grantable.
    permissions: jsonb('permissions').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the caretaker first accepts an invitation. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    /** Guards owner edits of access; bumped on every change. */
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('staff_client_phone_idx').on(t.clientId, t.phone)],
);

/** CP16: the owner's properties a caretaker may operate. Read live on every request. */
export const staffProperty = pgTable('staff_property', {
  staffId: uuid('staff_id').notNull().references(() => clientStaff.id, { onDelete: 'restrict' }),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.staffId, t.rentableId] }), index('staff_property_rentable_idx').on(t.rentableId)]);

/**
 * CP16: one-time invitation or sign-in link. Only the SHA-256 of the token is
 * stored; the link is shown to the owner once. Used, revoked or expired links
 * never create a session.
 */
export const staffInvitation = pgTable('staff_invitation', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id').notNull().references(() => clientStaff.id, { onDelete: 'restrict' }),
  deliveryState: varchar('delivery_state',{length:16}).notNull().default('not_sent'),
  providerId: text('provider_id'),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('staff_invitation_staff_idx').on(t.staffId, t.createdAt),check('staff_invitation_delivery_state_check',sql`${t.deliveryState} IN ('not_sent','sending','accepted','delivered','failed','unknown')`)]);

/* ==========================================================================
   GEOGRAPHY & TAXONOMY  —  these drive the SEO route tree, so they are real
   tables and never hardcoded strings.
   ========================================================================== */

export const city = pgTable('city', {
  version: integer('version').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  state: varchar('state', { length: 80 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

/** Every principal's session: customer, client, admin or caretaker. */
export const authSession = pgTable('auth_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  adminId: uuid('admin_id').references(() => adminUsers.id, { onDelete: 'cascade' }),
  /** CP16: a caretaker session; revoked with the caretaker's access. */
  staffId: uuid('staff_id').references(() => clientStaff.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deviceLabel: varchar('device_label',{length:120}).notNull().default('Browser session'),
  lastSeenAt: timestamp('last_seen_at',{withTimezone:true}).notNull().defaultNow(),
  reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
  check('auth_session_principal_chk', sql`((${t.userId} IS NOT NULL)::int + (${t.adminId} IS NOT NULL)::int + (${t.staffId} IS NOT NULL)::int) = 1`),
  index('auth_session_staff_idx').on(t.staffId),
  index('auth_session_user_idx').on(t.userId),
  index('auth_session_admin_idx').on(t.adminId),
  index('auth_session_purge_idx').on(t.expiresAt),
]);

export const area = pgTable(
  'area',
  {
    version: integer('version').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    id: uuid('id').primaryKey().defaultRandom(),
    cityId: uuid('city_id').notNull().references(() => city.id, { onDelete: 'restrict' }),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    centre: geometry('centre', { type: 'point', mode: 'xy', srid: 4326 }),
  },
  (t) => [
    uniqueIndex('area_city_slug_idx').on(t.cityId, t.slug),
    uniqueIndex('area_id_city_idx').on(t.id, t.cityId),
    index('area_centre_idx').using('gist', t.centre),
  ],
);

/**
 * Top-level verticals a guest switches between (0052). A lookup, not an enum,
 * so a new vertical never needs ALTER TYPE. status: hidden → partners → public.
 */
export const vertical = pgTable('vertical', {
  code: varchar('code', { length: 24 }).primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 60 }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('hidden'),
  sortOrder: integer('sort_order').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('vertical_status_check', sql`${t.status} IN ('hidden','partners','public')`)]);

export const category = pgTable('category', {
  version: integer('version').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 80 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  form: rentableForm('form').notNull().default('fixed'),
  defaultRentalUnit: rentalUnit('default_rental_unit').notNull().default('slot'),
  isActive: boolean('is_active').notNull().default(true),
  /** Immutable after create, like form and rental unit. Defaults to farmhouse for older writers. */
  verticalCode: varchar('vertical_code', { length: 24 }).notNull().default('farmhouse')
    .references(() => vertical.code, { onDelete: 'restrict', onUpdate: 'restrict' }),
  /** One of the icon keys the frontend ships; unknown keys fall back to a generic icon. */
  iconKey: varchar('icon_key', { length: 40 }),
}, (t) => [index('category_vertical_idx').on(t.verticalCode, t.isActive, t.sortOrder)]);

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

    categoryId: uuid('category_id').notNull().references(() => category.id, { onDelete: 'restrict' }),
    cityId: uuid('city_id').references(() => city.id, { onDelete: 'restrict' }),
    areaId: uuid('area_id').references(() => area.id, { onDelete: 'restrict' }),

    /** 1 for a farmhouse. 800 for a tent-house's chairs. */
    totalUnits: integer('total_units').notNull().default(1),

    capacity: integer('capacity').notNull().default(1),
    bedrooms: integer('bedrooms').notNull().default(0),
    highlight: varchar('highlight', { length: 60 }),
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

    depositMinor: minor('deposit_minor').notNull().default(0),
    cancellationTier: cancellationTier('cancellation_tier').notNull().default('moderate'),
    /** Explicit owner schedules; null is unavailable until reviewed/configured. */
    bookingConfig: jsonb('booking_config'),
    arrivalGuide:jsonb('arrival_guide').notNull().default({}),
    bookingConfigVersion: integer('booking_config_version').notNull().default(0),
    extraGuestChargeMinor: minor('extra_guest_charge_minor').notNull().default(0),

    // Denormalised so a listing card is one query, not N.
    ratingAvg: real('rating_avg'),
    reviewCount: integer('review_count').notNull().default(0),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    availabilityConfirmedAt: timestamp('availability_confirmed_at', { withTimezone: true }),

    /**
     * Stored when a listing is hidden, so reinstating a suspended Client
     * restores each listing to what it WAS rather than blanket-publishing.
     * A listing the owner had deliberately paused must come back paused.
     */
    priorStatus: listingStatus('prior_status'),
    /** PROP-05: the owner's pause ends on this IST date (worker resumes). */
    pausedUntil: date('paused_until', { mode: 'string' }),

    // The approved revision is listing_submission via published_submission_id.
    rejectionReason: text('rejection_reason'),
    /** Increments each time the listing goes back for review. */
    reviewPass: integer('review_pass').notNull().default(0),
    contentVersion: integer('content_version').notNull().default(1),
    /** Publication attribution (CP07): the exact reviewed revision that went live, by whom. */
    // FK to listing_submission is added in 0026 SQL (declared later in this file).
    publishedSubmissionId: uuid('published_submission_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    /**
     * Admin visibility restriction (CP08). Status 'hidden' is Rentra's alone:
     * owner pause/resume cannot reach it, and restore returns to prior_status.
     * lifecycle_version is bumped by the content trigger on every status change,
     * so an admin command prepared against an older state answers 409.
     */
    restrictedAt: timestamp('restricted_at', { withTimezone: true }),
    restrictedBy: uuid('restricted_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    restrictionReason: text('restriction_reason'),
    lifecycleVersion: integer('lifecycle_version').notNull().default(1),
    /** Constant; lets the composite FK prove the owner is a client account. */
    clientRole: varchar('client_role', { length: 16 }).notNull().default('client'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('rentable_money_chk', sql`${t.depositMinor} BETWEEN 0 AND 9007199254740991 AND ${t.extraGuestChargeMinor} BETWEEN 0 AND 9007199254740991`),
    check('rentable_client_role_chk', sql`${t.clientRole} = 'client'`),
    foreignKey({ name: 'rentable_client_role_fk', columns: [t.clientId, t.clientRole], foreignColumns: [users.id, users.role] }).onDelete('restrict'),
    index('rentable_city_cat_idx').on(t.cityId, t.categoryId, t.status),
    index('rentable_area_idx').on(t.areaId, t.status),
    index('rentable_client_idx').on(t.clientId),
    index('rentable_location_idx').using('gist', t.location),
    // rentable_location_geog_idx ((location::geography)) is created in 0041 SQL only when PostGIS exists.
    index('rentable_category_idx').on(t.categoryId),
    index('rentable_live_cursor_idx').on(t.id).where(sql`${t.status} = 'live'`),
    foreignKey({ name: 'rentable_area_city_fk', columns: [t.areaId, t.cityId], foreignColumns: [area.id, area.cityId] }).onDelete('restrict'),
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
    version: integer('version').notNull().default(1),
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
      .references(() => amenity.id, { onDelete: 'restrict' }),
    /** e.g. "15x25" for a pool, "8" for parking. NULL when valueType='none'. */
    value: varchar('value', { length: 40 }),
  },
  (t) => [primaryKey({ columns: [t.rentableId, t.amenityId] }), index('rentable_amenity_amenity_idx').on(t.amenityId)],
);

/** Which verticals may use an amenity (0052). Guarded on rentable_amenity by catalogue_reference_guard. */
export const amenityVertical = pgTable('amenity_vertical', {
  amenityId: uuid('amenity_id').notNull().references(() => amenity.id, { onDelete: 'cascade' }),
  verticalCode: varchar('vertical_code', { length: 24 }).notNull().references(() => vertical.code, { onDelete: 'restrict' }),
}, (t) => [primaryKey({ columns: [t.amenityId, t.verticalCode] }), index('amenity_vertical_vertical_idx').on(t.verticalCode)]);

/**
 * A bookable court, lane, turf or station inside a time-booked venue (0053).
 * Farmhouses have none: the whole property is the unit. Never deleted once
 * booked (bookings reference it); deactivate instead.
 */
export const rentableResource = pgTable('rentable_resource', {
  id: uuid('id').primaryKey().defaultRandom(),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 60 }).notNull(),
  capacity: integer('capacity').notNull(),
  isIndoor: boolean('is_indoor'),
  /** Activity-specific display facts (size, surface, format). Never read by booking logic. */
  details: jsonb('details').notNull().default({}),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('rentable_resource_id_rentable_idx').on(t.id, t.rentableId),
  // rentable_resource_name_idx is UNIQUE (rentable_id, lower(name)), created in 0053 SQL.
  index('rentable_resource_active_idx').on(t.rentableId, t.sortOrder).where(sql`${t.isActive}`),
  check('rentable_resource_capacity_check', sql`${t.capacity} BETWEEN 1 AND 500`),
]);

/** Activities (entertainment categories) a resource supports; a multi-sport turf has several. */
export const rentableResourceActivity = pgTable('rentable_resource_activity', {
  resourceId: uuid('resource_id').notNull(),
  rentableId: uuid('rentable_id').notNull(),
  categoryId: uuid('category_id').notNull().references(() => category.id, { onDelete: 'restrict' }),
}, (t) => [
  primaryKey({ columns: [t.resourceId, t.categoryId] }),
  foreignKey({ name: 'resource_activity_resource_fk', columns: [t.resourceId, t.rentableId], foreignColumns: [rentableResource.id, rentableResource.rentableId] }).onDelete('cascade'),
  index('resource_activity_category_idx').on(t.categoryId, t.rentableId),
]);

/**
 * Hourly rate bands per activity, weekday/weekend, in minutes from the
 * operating day's midnight (end ≤ 1800 = 06:00 next day). The no-overlap
 * exclusion constraint lives in 0053 SQL; full coverage is a service check.
 */
export const rentableRate = pgTable('rentable_rate', {
  id: uuid('id').primaryKey().defaultRandom(),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => category.id, { onDelete: 'restrict' }),
  dayKind: varchar('day_kind', { length: 8 }).notNull(),
  startMinute: smallint('start_minute').notNull(),
  endMinute: smallint('end_minute').notNull(),
  hourlyRateMinor: minor('hourly_rate_minor').notNull(),
}, (t) => [
  index('rentable_rate_lookup_idx').on(t.rentableId, t.categoryId, t.dayKind, t.startMinute),
  check('rentable_rate_valid_chk', sql`${t.dayKind} IN ('weekday','weekend') AND ${t.startMinute} BETWEEN 0 AND 1439
    AND ${t.endMinute} > ${t.startMinute} AND ${t.endMinute} <= 1800 AND ${t.hourlyRateMinor} BETWEEN 0 AND 50000000`),
]);

/**
 * GATE 2 — one row per review pass, so history survives.
 *
 * A listing that was sent back twice and then published has three rows here.
 * Overwriting a single row would lose exactly the context that makes a later
 * decision defensible.
 */
export const listingSubmission = pgTable('listing_submission', {
  id: uuid('id').primaryKey().defaultRandom(),
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  contentVersion: integer('content_version').notNull(),
  passNumber: integer('pass_number').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  submittedBy: uuid('submitted_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  assignedTo: uuid('assigned_to').references(() => adminUsers.id, { onDelete: 'set null' }),
}, t => [uniqueIndex('listing_submission_pass_idx').on(t.rentableId, t.passNumber),
  uniqueIndex('listing_submission_id_rentable_idx').on(t.id, t.rentableId)]);

export const listingReview = pgTable(
  'listing_review',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Review history is business history: never deleted with the property (CP08).
    rentableId: uuid('rentable_id').notNull()
      .references(() => rentable.id, { onDelete: 'restrict' }),
    passNumber: integer('pass_number').notNull().default(1),
    submissionId: uuid('submission_id').references(() => listingSubmission.id, { onDelete: 'restrict' }),
    /** { ownership, photos, contacts, price, rules, permits } — each a bool. */
    checklist: jsonb('checklist'),
    outcome: listingReviewOutcome('outcome').notNull(),
    reason: text('reason'),
    flaggedFields: jsonb('flagged_fields'),
    reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('listing_review_idx').on(t.rentableId, t.passNumber), uniqueIndex('listing_review_submission_idx').on(t.submissionId),
    foreignKey({ name: 'listing_review_submission_rentable_fk', columns: [t.submissionId, t.rentableId], foreignColumns: [listingSubmission.id, listingSubmission.rentableId] }).onDelete('restrict')],
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
      .references(() => rentable.id, { onDelete: 'restrict' }),
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
    submissionId: uuid('submission_id').references(() => listingSubmission.id, { onDelete: 'restrict' }),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Asia/Kolkata'),
    createdBy: uuid('created_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    recordedBy: uuid('recorded_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
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
    foreignKey({ name: 'verification_visit_submission_rentable_fk', columns: [t.submissionId, t.rentableId], foreignColumns: [listingSubmission.id, listingSubmission.rentableId] }).onDelete('restrict'),
  ],
);

/** Base price per slot. Weekend/weekday, in paise. */
export const rentablePrice = pgTable(
  'rentable_price',
  {
    rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'cascade' }),
    slot: bookingSlot('slot').notNull(),
    weekdayMinor: minor('weekday_minor').notNull(),
    weekendMinor: minor('weekend_minor').notNull(),
  },
  (t) => [primaryKey({ columns: [t.rentableId, t.slot] }),
    check('rentable_price_amount_chk', sql`${t.weekdayMinor} BETWEEN 0 AND 9007199254740991 AND ${t.weekendMinor} BETWEEN 0 AND 9007199254740991`)],
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
    /** Open-date calendar only. Prices: booking_price_override. Owner blocks: inventory_reservation. */
    unitsAvailable: integer('units_available').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.rentableId, t.day, t.slot] }),
    index('availability_day_idx').on(t.day, t.slot),
  ],
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
  index('booking_quote_customer_idx').on(t.customerId).where(sql`${t.customerId} IS NOT NULL`),
  index('booking_quote_rentable_idx').on(t.rentableId),
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
  /** Constant; lets the composite FK prove the customer is a customer account. */
  customerRole: varchar('customer_role', { length: 16 }).notNull().default('customer'),
}, (t) => [
  check('booking_order_customer_role_chk', sql`${t.customerRole} = 'customer'`),
  foreignKey({ name: 'booking_order_customer_role_fk', columns: [t.customerId, t.customerRole], foreignColumns: [users.id, users.role] }).onDelete('restrict'),
  uniqueIndex('booking_order_customer_key_idx').on(t.customerId, t.idempotencyKey),
  uniqueIndex('booking_order_scope_idx').on(t.id, t.customerId, t.rentableId, t.currency, t.timeZone),
  index('booking_order_history_idx').on(t.customerId, t.createdAt),
  index('booking_order_hold_idx').on(t.state, t.holdExpiresAt),
  index('booking_order_rentable_idx').on(t.rentableId, t.createdAt.desc()),
  index('booking_order_quote_idx').on(t.quoteId).where(sql`${t.quoteId} IS NOT NULL`),
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

    slot: bookingSlot('slot').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    unitsBooked: integer('units_booked').notNull().default(1),
    guests: integer('guests').notNull().default(1),

    state: bookingState('state').notNull().default('requested'),
    contactPhone: varchar('contact_phone', { length: 15 }),
    note: text('note'),

    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** customer | client | admin | system. NULL only on rows cancelled before 0043. */
    cancelledByKind: varchar('cancelled_by_kind', { length: 16 }),
    cancellationReason: text('cancellation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // A booking is one VISIT inside an order; listing/policy snapshots and versions live on the order.
    /** The parent order. Rows from before orders existed were moved into 'legacy' orders by 0047. */
    orderId: uuid('order_id').notNull().references(() => bookingOrder.id, { onDelete: 'restrict' }),
    /** 1-based position within the order, so a 3-visit order has a stable display order. */
    itemPosition: integer('item_position').notNull(),

    /** The property-LOCAL visit-start date, with an explicit timezone so it is never reinterpreted. */
    localDay: date('local_day').notNull(),
    timeZone: varchar('time_zone', { length: 64 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),

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

    // Paise. See `minor`.
    amountRentMinor: minor('amount_rent_minor').notNull(),
    amountFeeMinor: minor('amount_fee_minor').notNull(),
    amountDepositMinor: minor('amount_deposit_minor').notNull(),
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

    /** The visit as quoted (date, slot, hours, price). */
    slotSnapshot: jsonb('slot_snapshot'),
    /** The court of an hourly visit (0053). NULL for slot visits: the whole property. */
    resourceId: uuid('resource_id'),

    lifecycleVersion: integer('lifecycle_version').notNull().default(0),
  },
  (t) => [
    index('booking_rentable_day_idx').on(t.rentableId, t.localDay),
    index('booking_customer_idx').on(t.customerId, t.state),

    uniqueIndex('booking_id_rentable_idx').on(t.id, t.rentableId),
    foreignKey({ name: 'booking_resource_fk', columns: [t.resourceId, t.rentableId], foreignColumns: [rentableResource.id, rentableResource.rentableId] }).onDelete('restrict'),
    check('booking_resource_slot_chk', sql`(${t.slot}::text = 'hourly') = (${t.resourceId} IS NOT NULL)`),
    index('booking_resource_start_idx').on(t.resourceId, t.startsAt).where(sql`${t.resourceId} IS NOT NULL`),
    foreignKey({ name: 'booking_order_scope_fk',
      columns: [t.orderId, t.customerId, t.rentableId, t.currency, t.timeZone],
      foreignColumns: [bookingOrder.id, bookingOrder.customerId, bookingOrder.rentableId, bookingOrder.currency, bookingOrder.timeZone],
    }),
    check('booking_order_visit_chk', sql`${t.orderId} IS NULL OR (
      ${t.itemPosition} IS NOT NULL AND ${t.itemPosition} BETWEEN 1 AND 10
      AND ${t.localDay} IS NOT NULL AND ${t.currency} IS NOT NULL AND ${t.timeZone} IS NOT NULL
      AND ${t.guests} > 0 AND ${t.unitsBooked} = 1
      AND ${t.amountRentMinor} IS NOT NULL AND ${t.amountFeeMinor} IS NOT NULL AND ${t.amountDepositMinor} IS NOT NULL)`),
    uniqueIndex('booking_order_position_idx').on(t.orderId, t.itemPosition),
    /** One visit per order per local date and slot — a duplicated date is a bug, not a second visit. */
    uniqueIndex('booking_order_localday_slot_idx').on(t.orderId, t.localDay, t.slot),
    /** Simulated and legacy money can never become collected money. */
    check('booking_cancelled_by_kind_chk', sql`${t.cancelledByKind} IS NULL OR ${t.cancelledByKind} IN ('customer','client','admin','system')`),
    check('booking_collected_requires_real_chk',
      sql`${t.collectedMinor} = 0 OR ${t.paymentMode} = 'real'`),
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
 * Since 0053 the GiST exclusion is per (rentable_id, COALESCE(resource_id, nil uuid), blocked range).
 * The GiST exclusion is maintained in migration 0008 (Drizzle has no exclusion builder).
 * Expiry must be transitioned under the listing lock; a clock predicate is unsafe.
 */
export const inventoryReservation = pgTable('inventory_reservation', {
  kind:text('kind').notNull().default('block'), details:jsonb('details').notNull().default({}),
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id'), // Null for an owner block.
  rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
  source: varchar('source', { length: 24 }).notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason'),
  resourceKey: varchar('resource_key', { length: 64 }).notNull().default('property'),
  /** The court held (0053). NULL = the whole listing: every farmhouse row, and venue-wide closures. */
  resourceId: uuid('resource_id'),
  units: integer('units').notNull().default(1),
  blockedStartAt: timestamp('blocked_start_at', { withTimezone: true }).notNull(),
  blockedEndAt: timestamp('blocked_end_at', { withTimezone: true }).notNull(),
  state: reservationState('state').notNull(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'reservation_booking_listing_fk', columns: [t.bookingId, t.rentableId], foreignColumns: [booking.id, booking.rentableId] }),
  foreignKey({ name: 'reservation_resource_fk', columns: [t.resourceId, t.rentableId], foreignColumns: [rentableResource.id, rentableResource.rentableId] }).onDelete('restrict'),
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
/**
 * CP21: versioned payout destinations. Versions are append-only; only state
 * moves. Rentra never stores a full bank account number — a provider-backed
 * verification must collect it into the provider's vault. "verified" is
 * reachable only with provider evidence; a name or last-four comparison is not
 * verification.
 */
export const payoutDestination = pgTable('payout_destination', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),
  method: varchar('method', { length: 8 }).notNull(),
  holderName: varchar('holder_name', { length: 160 }).notNull(),
  accountLast4: varchar('account_last4', { length: 4 }),
  ifsc: varchar('ifsc', { length: 11 }),
  upiId: varchar('upi_id', { length: 100 }),
  nameCheck: varchar('name_check', { length: 12 }).notNull(),
  state: varchar('state', { length: 12 }).notNull().default('draft'),
  source: varchar('source', { length: 16 }).notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
  failureReason: text('failure_reason'),
  verificationProvider: varchar('verification_provider', { length: 32 }),
  verificationReference: varchar('verification_reference', { length: 160 }),
  verificationEvidenceHash: varchar('verification_evidence_hash', { length: 64 }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  requestKey: uuid('request_key'),
  requestHash: varchar('request_hash', { length: 64 }),
}, t => [uniqueIndex('payout_destination_version_idx').on(t.clientId, t.version),
  uniqueIndex('payout_destination_request_idx').on(t.clientId, t.requestKey).where(sql`${t.requestKey} IS NOT NULL`),
  uniqueIndex('payout_destination_draft_idx').on(t.clientId).where(sql`${t.state} = 'draft'`),
  uniqueIndex('payout_destination_current_idx').on(t.clientId).where(sql`${t.state} IN ('submitted','verified')`),
  check('payout_destination_valid_chk', sql`${t.version} >= 1 AND length(trim(${t.holderName})) BETWEEN 3 AND 160
    AND ${t.nameCheck} IN ('same','different','unknown') AND ${t.source} IN ('onboarding','settings','migration')
    AND ${t.state} IN ('draft','submitted','verified','failed','superseded')
    AND ((${t.method}='bank' AND ${t.accountLast4} ~ '^[0-9]{4}$' AND ${t.ifsc} ~ '^[A-Z]{4}0[A-Z0-9]{6}$' AND ${t.upiId} IS NULL)
      OR (${t.method}='upi' AND ${t.upiId} ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,32}$' AND ${t.accountLast4} IS NULL AND ${t.ifsc} IS NULL))
    AND ((${t.state}='draft') = (${t.submittedAt} IS NULL))
    AND (${t.state}<>'failed' OR (${t.decidedAt} IS NOT NULL AND length(trim(${t.failureReason})) BETWEEN 10 AND 500))
    AND (${t.state}<>'verified' OR (${t.verificationProvider} IS NOT NULL AND ${t.verificationReference} IS NOT NULL
      AND ${t.verificationEvidenceHash} ~ '^[a-f0-9]{64}$' AND ${t.verifiedAt} IS NOT NULL))
    AND ((${t.requestKey} IS NULL) = (${t.requestHash} IS NULL))
    AND (${t.requestHash} IS NULL OR ${t.requestHash} ~ '^[a-f0-9]{64}$')`)]);

export const payout = pgTable(
  'payout',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
    clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    fundingAllocationId: uuid('funding_allocation_id').references(() => paymentAllocation.id, { onDelete: 'restrict' }),
    actualNetMinor: minor('actual_net_minor').notNull().default(0),
    // Quoted amounts in paise. Only actual_net_minor, backed by a funding allocation, is money owed.
    grossMinor: minor('gross_minor').notNull(),
    commissionMinor: minor('commission_minor').notNull(),
    tds194oMinor: minor('tds_194o_minor').notNull().default(0),
    gstTcsMinor: minor('gst_tcs_minor').notNull().default(0),
    netMinor: minor('net_minor').notNull(),
    status: payoutStatus('status').notNull().default('pending'),
    /** CP21: the destination version this obligation is pinned to; never redirected. */
    destinationId: uuid('destination_id').references(() => payoutDestination.id, { onDelete: 'restrict' }),
    utr: varchar('utr', { length: 64 }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clientRole: varchar('client_role', { length: 16 }).notNull().default('client'),
  },
  (t) => [
    check('payout_amounts_chk', sql`${t.grossMinor} BETWEEN 0 AND 9007199254740991 AND ${t.commissionMinor} >= 0 AND ${t.tds194oMinor} >= 0 AND ${t.gstTcsMinor} >= 0 AND ${t.netMinor} BETWEEN 0 AND 9007199254740991`),
    check('payout_client_role_chk', sql`${t.clientRole} = 'client'`),
    foreignKey({ name: 'payout_client_role_fk', columns: [t.clientId, t.clientRole], foreignColumns: [users.id, users.role] }).onDelete('restrict'),
    index('payout_client_status_idx').on(t.clientId, t.status),
    index('payout_booking_idx').on(t.bookingId),
    index('payout_destination_fk_idx').on(t.destinationId).where(sql`${t.destinationId} IS NOT NULL`),
    uniqueIndex('payout_funding_allocation_idx').on(t.fundingAllocationId),
    check('payout_actual_funding_chk', sql`${t.actualNetMinor} BETWEEN 0 AND 9007199254740991 AND (${t.actualNetMinor} = 0 OR ${t.fundingAllocationId} IS NOT NULL)`),
  ],
);

/** Customer publication requires actual visit evidence and score-neutral moderation. */
export const review = pgTable(
  'review',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
    rentableId: uuid('rentable_id').notNull().references(() => rentable.id, { onDelete: 'restrict' }),
    authorId: uuid('author_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    authorRole: varchar('author_role', { length: 16 }).notNull().references(() => role.code, { onDelete: 'restrict', onUpdate: 'restrict' }),
    rating: integer('rating').notNull(),
    cleanliness: integer('cleanliness'),
    accuracy: integer('accuracy'),
    valueForMoney: integer('value_for_money'),
    behaviour: integer('behaviour'),
    moderationState: varchar('moderation_state', { length: 16 }).notNull().default('pending'),
    moderationReason: text('moderation_reason'),
    moderatedBy: uuid('moderated_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    ownerReply: text('owner_reply'),
    repliedBy: uuid('replied_by').references(() => users.id, { onDelete: 'restrict' }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),

    body: text('body'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('review_booking_author_idx').on(t.bookingId, t.authorId),
    index('review_rentable_public_idx').on(t.rentableId).where(sql`${t.authorRole} = 'customer' AND ${t.moderationState} = 'published'`),
    index('review_author_idx').on(t.authorId),
    foreignKey({ name: 'review_author_user_role_fk', columns: [t.authorId, t.authorRole], foreignColumns: [users.id, users.role] }).onDelete('restrict'),
    foreignKey({ name: 'review_booking_rentable_fk', columns: [t.bookingId, t.rentableId], foreignColumns: [booking.id, booking.rentableId] }).onDelete('restrict'),
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
  index('payment_method_customer_idx').on(t.customerId),
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
  index('refund_requested_idx').on(t.createdAt).where(sql`${t.state} = 'requested'`),
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
  index('refund_allocation_booking_idx').on(t.bookingId),
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
  index('payment_event_order_ref_idx').on(sql`(${t.redactedPayload}->>'orderId')`),
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
  /** CP13: the visit lifecycle version the transition was recorded against; null on earlier rows. */
  visitVersion: integer('visit_version'),
}, t => [uniqueIndex('visit_evidence_kind_idx').on(t.bookingId, t.kind),
  uniqueIndex('visit_evidence_request_idx').on(t.actorKind, t.actorId, t.requestKey),
  check('visit_evidence_valid_chk', sql`${t.kind} IN ('handover','return','complete') AND ${t.nature} IN ('actual','simulation')
    AND ${t.actorKind} IN ('owner','admin','staff','system') AND length(trim(${t.note})) BETWEEN 0 AND 1000
    AND ${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.occurredAt} <= ${t.recordedAt}`)]);

/**
 * CP13: visit-linked incidents. A report is immutable; only the admin closure
 * fields change, once. Financial liability belongs to a dispute case (CP23).
 */
export const visitIncident = pgTable('visit_incident', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: varchar('reference', { length: 24 }).notNull(),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
  category: varchar('category', { length: 24 }).notNull(),
  summary: varchar('summary', { length: 120 }).notNull(),
  description: text('description').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  nature: varchar('nature', { length: 16 }).notNull(),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('open'),
  resolutionNote: text('resolution_note'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
}, t => [uniqueIndex('visit_incident_reference_idx').on(t.reference),
  uniqueIndex('visit_incident_request_idx').on(t.actorKind, t.actorId, t.requestKey),
  index('visit_incident_booking_idx').on(t.bookingId, t.createdAt),
  check('visit_incident_valid_chk', sql`${t.category} IN ('damage','safety','access','conduct','amenity','other')
    AND ${t.nature} IN ('actual','simulation') AND ${t.actorKind} IN ('owner','admin','staff') AND ${t.state} IN ('open','closed')
    AND length(trim(${t.summary})) BETWEEN 5 AND 120 AND length(trim(${t.description})) BETWEEN 20 AND 2000
    AND ${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.occurredAt} <= ${t.createdAt} AND ${t.version} >= 1
    AND ((${t.state}='open' AND ${t.closedAt} IS NULL AND ${t.closedBy} IS NULL AND ${t.resolutionNote} IS NULL)
      OR (${t.state}='closed' AND ${t.closedAt} IS NOT NULL AND ${t.closedBy} IS NOT NULL AND length(trim(${t.resolutionNote})) BETWEEN 10 AND 1000))`)]);

/**
 * CP13: an admin evidence decision that supersedes earlier evidence without
 * erasing it. Corrections form one linear chain per evidence row.
 */
export const visitEvidenceCorrection = pgTable('visit_evidence_correction', {
  id: uuid('id').primaryKey().defaultRandom(),
  evidenceId: uuid('evidence_id').notNull().references(() => visitEvidence.id, { onDelete: 'restrict' }),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
  supersedesId: uuid('supersedes_id'),
  reason: text('reason').notNull(),
  correctedOccurredAt: timestamp('corrected_occurred_at', { withTimezone: true }),
  correctedNote: text('corrected_note'),
  nature: varchar('nature', { length: 16 }).notNull(),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
}, t => [foreignKey({ columns: [t.supersedesId], foreignColumns: [t.id], name: 'visit_evidence_correction_supersedes_fk' }).onDelete('restrict'),
  uniqueIndex('visit_evidence_correction_request_idx').on(t.actorKind, t.actorId, t.requestKey),
  uniqueIndex('visit_evidence_correction_first_idx').on(t.evidenceId).where(sql`${t.supersedesId} IS NULL`),
  uniqueIndex('visit_evidence_correction_next_idx').on(t.supersedesId).where(sql`${t.supersedesId} IS NOT NULL`),
  check('visit_evidence_correction_valid_chk', sql`${t.actorKind}='admin' AND ${t.nature} IN ('actual','simulation')
    AND length(trim(${t.reason})) BETWEEN 10 AND 500 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'
    AND (${t.correctedOccurredAt} IS NOT NULL OR ${t.correctedNote} IS NOT NULL)
    AND (${t.correctedNote} IS NULL OR length(trim(${t.correctedNote})) BETWEEN 20 AND 1000)
    AND (${t.correctedOccurredAt} IS NULL OR ${t.correctedOccurredAt} <= ${t.createdAt})`)]);

/**
 * CP13: private photos attached to one evidence record or one incident. The
 * storage key is content-addressed and never leaves the API.
 */
export const visitAttachment = pgTable('visit_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
  evidenceId: uuid('evidence_id').references(() => visitEvidence.id, { onDelete: 'restrict' }),
  incidentId: uuid('incident_id').references(() => visitIncident.id, { onDelete: 'restrict' }),
  position: integer('position').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  mimeType: varchar('mime_type', { length: 32 }).notNull(),
  bytes: integer('bytes').notNull(),
  retentionClass: varchar('retention_class', { length: 24 }).notNull(),
  nature: varchar('nature', { length: 16 }).notNull(),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('visit_attachment_booking_idx').on(t.bookingId),
  uniqueIndex('visit_attachment_evidence_idx').on(t.evidenceId, t.position),
  uniqueIndex('visit_attachment_incident_idx').on(t.incidentId, t.position),
  check('visit_attachment_valid_chk', sql`((${t.evidenceId} IS NOT NULL AND ${t.incidentId} IS NULL AND ${t.retentionClass}='visit_evidence')
      OR (${t.incidentId} IS NOT NULL AND ${t.evidenceId} IS NULL AND ${t.retentionClass}='incident_evidence'))
    AND ${t.position} BETWEEN 0 AND 2 AND ${t.mimeType} IN ('image/jpeg','image/png','image/webp')
    AND ${t.bytes} BETWEEN 1 AND 2097152 AND ${t.sha256} ~ '^[a-f0-9]{64}$'
    AND ${t.nature} IN ('actual','simulation') AND ${t.actorKind} IN ('owner','admin','staff')`)]);

/**
 * CP14: an admin booking case tied to exact visits. Owners request, admins
 * resolve once through a previewed command. A cancellation reuses the existing
 * cancellation/refund records; a case never edits accepted booking terms.
 */
export const bookingCase = pgTable('booking_case', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: varchar('reference', { length: 24 }).notNull(),
  orderId: uuid('order_id').notNull().references(() => bookingOrder.id, { onDelete: 'restrict' }),
  type: varchar('type', { length: 24 }).notNull(),
  requesterKind: varchar('requester_kind', { length: 16 }).notNull(),
  source: varchar('source', { length: 16 }).notNull(),
  reason: text('reason').notNull(),
  requestedOutcome: text('requested_outcome'),
  requestedChange: jsonb('requested_change'),
  state: varchar('state', { length: 16 }).notNull().default('open'),
  outcome: varchar('outcome', { length: 24 }),
  outcomeNote: text('outcome_note'),
  refundBasis: varchar('refund_basis', { length: 16 }),
  cancellationId: uuid('cancellation_id').references(() => bookingCancellation.id, { onDelete: 'restrict' }),
  assigneeId: uuid('assignee_id').references(() => adminUsers.id, { onDelete: 'restrict' }),
  version: integer('version').notNull().default(1),
  createdByKind: varchar('created_by_kind', { length: 16 }).notNull(),
  createdById: uuid('created_by_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  resolveKey: uuid('resolve_key'),
  resolveHash: varchar('resolve_hash', { length: 64 }),
}, t => [uniqueIndex('booking_case_reference_idx').on(t.reference),
  uniqueIndex('booking_case_request_idx').on(t.createdByKind, t.createdById, t.requestKey),
  index('booking_case_queue_idx').on(t.state, t.createdAt),
  index('booking_case_order_idx').on(t.orderId),
  index('booking_case_assignee_idx').on(t.assigneeId, t.state),
  check('booking_case_valid_chk', sql`${t.type} IN ('owner_cancellation','customer_cancellation','change_request','no_show','late_arrival','operational')
    AND ${t.requesterKind} IN ('customer','owner','admin') AND ${t.source} IN ('portal','support','phone','email','internal')
    AND ${t.createdByKind} IN ('owner','admin') AND (${t.createdByKind}='admin' OR (${t.requesterKind}='owner' AND ${t.source}='portal'
      AND ${t.type} IN ('owner_cancellation','no_show','late_arrival','operational')))
    AND length(trim(${t.reason})) BETWEEN 10 AND 1000 AND (${t.requestedOutcome} IS NULL OR length(${t.requestedOutcome}) <= 500)
    AND ${t.requestHash} ~ '^[a-f0-9]{64}$' AND ${t.version} >= 1 AND ${t.state} IN ('open','resolved')
    AND ((${t.state}='open' AND ${t.outcome} IS NULL AND ${t.outcomeNote} IS NULL AND ${t.refundBasis} IS NULL AND ${t.cancellationId} IS NULL
        AND ${t.resolvedAt} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.resolveKey} IS NULL AND ${t.resolveHash} IS NULL)
      OR (${t.state}='resolved' AND ${t.outcome} IN ('visits_cancelled','declined','no_change','no_show','partial_refund') AND length(trim(${t.outcomeNote})) BETWEEN 10 AND 1000
        AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.resolveKey} IS NOT NULL AND ${t.resolveHash} ~ '^[a-f0-9]{64}$'
        AND ((${t.outcome}='visits_cancelled') = (${t.cancellationId} IS NOT NULL))
        AND ((${t.outcome}='visits_cancelled') = (${t.refundBasis} IN ('policy','full')))))`)]);

/** CP14: the exact visits a case concerns. */
export const bookingCaseVisit = pgTable('booking_case_visit', {
  caseId: uuid('case_id').notNull().references(() => bookingCase.id, { onDelete: 'restrict' }),
  bookingId: uuid('booking_id').notNull().references(() => booking.id, { onDelete: 'restrict' }),
}, t => [primaryKey({ columns: [t.caseId, t.bookingId] }), index('booking_case_visit_booking_idx').on(t.bookingId)]);

/** CP14: case progress. Every update names who may read it. */
export const bookingCaseUpdate = pgTable('booking_case_update', {
  id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id').notNull().references(() => bookingCase.id, { onDelete: 'restrict' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  audience: varchar('audience', { length: 16 }).notNull(),
  body: text('body').notNull(),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  requestKey: uuid('request_key'),
}, t => [index('booking_case_update_case_idx').on(t.caseId, t.createdAt),
  uniqueIndex('booking_case_update_request_idx').on(t.caseId, t.actorKind, t.actorId, t.requestKey).where(sql`${t.requestKey} IS NOT NULL`),
  check('booking_case_update_valid_chk', sql`${t.kind} IN ('created','assigned','message','resolved')
    AND ${t.audience} IN ('internal','client','customer','everyone') AND ${t.actorKind} IN ('owner','admin','system')
    AND length(trim(${t.body})) BETWEEN 1 AND 2000 AND (${t.actorKind}<>'owner' OR ${t.audience}='client')`)]);

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
  index('notification_order_idx').on(t.orderId), index('notification_booking_idx').on(t.bookingId).where(sql`${t.bookingId} IS NOT NULL`),
  check('notification_valid_chk', sql`${t.template} IN ('confirmation','reminder','cancellation','refund','completion','review_invitation','arrival_guide')
    AND ${t.channel}='sms' AND ${t.attempts}>=0 AND ${t.state} IN ('pending','blocked','retry','sending','unknown','accepted','delivered','undelivered','suppressed','failed')`)]);

/**
 * The client's persisted updates inbox (CP15). Rows are written by database
 * triggers on audit_log, booking_lifecycle_event and booking_case_update, so
 * every writer produces them in its own transaction and a replayed event
 * (same event key) produces nothing new. Only client-safe detail is stored.
 * `kind` separates required work ('action') from information ('info').
 */
export const clientUpdate = pgTable('client_update', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  eventKey: varchar('event_key', { length: 160 }).notNull(),
  category: varchar('category', { length: 16 }).notNull(),
  kind: varchar('kind', { length: 8 }).notNull(),
  action: varchar('action', { length: 64 }).notNull(),
  rentableId: uuid('rentable_id').references(() => rentable.id, { onDelete: 'restrict' }),
  orderId: uuid('order_id').references(() => bookingOrder.id, { onDelete: 'restrict' }),
  detail: jsonb('detail').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, t => [uniqueIndex('client_update_event_idx').on(t.clientId, t.eventKey),
  index('client_update_client_idx').on(t.clientId, t.createdAt),
  index('client_update_rentable_idx').on(t.rentableId).where(sql`${t.rentableId} IS NOT NULL`),
  index('client_update_order_idx').on(t.orderId).where(sql`${t.orderId} IS NOT NULL`),
  check('client_update_valid_chk', sql`${t.category} IN ('account','property','booking','case','review','team') AND ${t.kind} IN ('action','info')`)]);

export const reviewReport = pgTable('review_report', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id').notNull().references(() => review.id, { onDelete: 'restrict' }),
  reporterId: uuid('reporter_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('open'),
  resolution: text('resolution'),
  resolvedBy: uuid('resolved_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('review_report_author_idx').on(t.reviewId, t.reporterId),
  check('review_report_valid_chk', sql`${t.state} IN ('open','closed') AND length(trim(${t.reason})) BETWEEN 10 AND 1000 AND (${t.state}='open' OR (${t.resolution} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL))`)]);

export const supportRequest = pgTable('support_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: varchar('reference', { length: 40 }).notNull().unique(),
  customerId: uuid('customer_id').references(() => users.id, { onDelete: 'restrict' }),
  clientId: uuid('client_id').references(() => users.id, { onDelete: 'restrict' }),
  propertyId: uuid('property_id').references(() => rentable.id, { onDelete: 'restrict' }),
  assignedTo: uuid('assigned_to').references(() => adminUsers.id, { onDelete: 'restrict' }),
  priority: varchar('priority', { length: 16 }).notNull().default('normal'),
  relatedRequestId: uuid('related_request_id').references(() => supportRequest.id, { onDelete: 'restrict' }),
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
}, t => [uniqueIndex('support_request_client_replay_idx').on(t.clientId, t.requestKey),
  check('support_participant_chk', sql`num_nonnulls(${t.customerId},${t.clientId})=1 AND (${t.clientId} IS NULL OR ${t.privacyRequestId} IS NULL) AND ${t.priority} IN ('normal','urgent') AND (${t.relatedRequestId} IS NULL OR ${t.relatedRequestId}<>${t.id})`),
  uniqueIndex('support_request_replay_idx').on(t.customerId, t.requestKey),
  index('support_request_inbox_idx').on(t.state, t.updatedAt), index('support_request_customer_idx').on(t.customerId, t.createdAt),
  index('support_request_order_idx').on(t.orderId).where(sql`${t.orderId} IS NOT NULL`),
  index('support_request_property_idx').on(t.propertyId).where(sql`${t.propertyId} IS NOT NULL`),
  index('support_request_assignee_idx').on(t.assignedTo, t.state).where(sql`${t.assignedTo} IS NOT NULL`),
  index('support_request_privacy_idx').on(t.privacyRequestId).where(sql`${t.privacyRequestId} IS NOT NULL`),
  check('support_request_valid_chk', sql`${t.category} IN ('booking','change','cancellation','payment','privacy','other','verification','account','property','calendar','earnings')
    AND ${t.state} IN ('open','in_progress','waiting_customer','resolved') AND ${t.version}>=0
    AND length(trim(${t.subject})) BETWEEN 5 AND 120 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'
    AND (${t.clientId} IS NOT NULL OR ${t.category} NOT IN ('booking','change','cancellation','payment') OR ${t.orderId} IS NOT NULL)
    AND (${t.clientId} IS NOT NULL OR ${t.category} NOT IN ('verification','account','property','calendar','earnings'))
    AND (${t.privacyRequestId} IS NULL OR (${t.category}='privacy' AND ${t.orderId} IS NULL))`)]);

export const supportMessage = pgTable('support_message', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => supportRequest.id, { onDelete: 'restrict' }),
  actorKind: varchar('actor_kind', { length: 16 }).notNull(),
  actorId: uuid('actor_id').notNull(),
  internal: boolean('internal').notNull().default(false),
  body: text('body').notNull(),
  stateAfter: varchar('state_after', { length: 20 }).notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('support_message_replay_idx').on(t.actorKind, t.actorId, t.requestKey),
  index('support_message_thread_idx').on(t.requestId, t.createdAt),
  check('support_message_valid_chk', sql`${t.actorKind} IN ('customer','owner','admin') AND (NOT ${t.internal} OR ${t.actorKind}='admin') AND length(trim(${t.body})) BETWEEN 2 AND 5000
    AND ${t.stateAfter} IN ('open','in_progress','waiting_customer','resolved') AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`)]);

export const supportAttachment = pgTable('support_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').notNull().references(() => supportMessage.id, { onDelete: 'restrict' }),
  storageKey: text('storage_key').notNull(),
  mimeType: varchar('mime_type', { length: 32 }).notNull(),
  bytes: integer('bytes').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('support_attachment_message_hash_idx').on(t.messageId,t.sha256),
  check('support_attachment_valid_chk',sql`${t.mimeType} IN ('image/jpeg','image/png','image/webp') AND ${t.bytes} BETWEEN 1 AND 2097152 AND ${t.sha256} ~ '^[a-f0-9]{64}$'`)]);

/** CP23: adjudication records; monetary execution stays in the payment/refund ledger. */
export const disputeCase = pgTable('dispute_case', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => bookingOrder.id, {onDelete:'restrict'}),
  visitId: uuid('visit_id').notNull().references(() => booking.id, {onDelete:'restrict'}),
  ownerId: uuid('owner_id').notNull().references(() => users.id, {onDelete:'restrict'}),
  customerId: uuid('customer_id').notNull().references(() => users.id, {onDelete:'restrict'}),
  kind: varchar('kind',{length:16}).notNull(),
  claimSummary: text('claim_summary'),
  subject: varchar('subject',{length:160}).notNull(),
  claimedMinor: bigint('claimed_minor',{mode:'number'}).notNull().default(0),
  state: varchar('state',{length:16}).notNull().default('open'),
  assigneeId: uuid('assignee_id').references(() => adminUsers.id,{onDelete:'restrict'}),
  requestedParty: varchar('requested_party',{length:16}),
  responseDue: timestamp('response_due',{withTimezone:true}),
  outcome: varchar('outcome',{length:24}),
  resolution: text('resolution'),
  resolvedBy: uuid('resolved_by').references(() => adminUsers.id,{onDelete:'restrict'}),
  resolvedAt: timestamp('resolved_at',{withTimezone:true}),
  version: integer('version').notNull().default(1),
  createdByKind: varchar('created_by_kind',{length:16}).notNull(),
  createdById: uuid('created_by_id').notNull(),
  requestKey: uuid('request_key').notNull(),
  requestHash: varchar('request_hash',{length:64}).notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('dispute_case_request_idx').on(t.createdByKind,t.createdById,t.requestKey),index('dispute_case_queue_idx').on(t.state,t.createdAt),index('dispute_case_owner_idx').on(t.ownerId,t.createdAt),index('dispute_case_customer_idx').on(t.customerId,t.createdAt),index('dispute_case_order_idx').on(t.orderId),index('dispute_case_visit_idx').on(t.visitId),
  check('dispute_case_claim_summary_check',sql`${t.claimSummary} IS NULL OR length(trim(${t.claimSummary})) BETWEEN 10 AND 2000`),
  check('dispute_case_valid_chk',sql`${t.kind} IN ('service','deposit','provider') AND length(trim(${t.subject})) BETWEEN 5 AND 160 AND ${t.claimedMinor} BETWEEN 0 AND 100000000
    AND ${t.state} IN ('open','resolved') AND ${t.version} >= 1 AND ${t.createdByKind} IN ('owner','customer','admin') AND ${t.requestHash} ~ '^[a-f0-9]{64}$'
    AND ((${t.requestedParty} IS NULL AND ${t.responseDue} IS NULL) OR (${t.requestedParty} IN ('owner','customer') AND ${t.responseDue} IS NOT NULL))
    AND ((${t.state}='open' AND ${t.outcome} IS NULL AND ${t.resolution} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.resolvedAt} IS NULL)
      OR (${t.state}='resolved' AND ${t.outcome} IN ('no_action','refund_review','support_escalation') AND length(trim(${t.resolution})) BETWEEN 10 AND 2000 AND ${t.resolvedBy} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND ${t.requestedParty} IS NULL))`)]);
export const disputeMessage = pgTable('dispute_message',{
  id:uuid('id').primaryKey().defaultRandom(),caseId:uuid('case_id').notNull().references(()=>disputeCase.id,{onDelete:'restrict'}),
  actorKind:varchar('actor_kind',{length:16}).notNull(),actorId:uuid('actor_id').notNull(),kind:varchar('kind',{length:16}).notNull(),
  audience:varchar('audience',{length:16}).notNull(),body:text('body').notNull(),
  requestKey:uuid('request_key').notNull(),requestHash:varchar('request_hash',{length:64}).notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('dispute_message_request_idx').on(t.caseId,t.actorKind,t.actorId,t.requestKey),index('dispute_message_case_idx').on(t.caseId,t.createdAt),check('dispute_message_valid_chk',sql`${t.actorKind} IN ('owner','customer','admin') AND ${t.kind} IN ('created','reply','assigned','requested','resolved') AND ${t.audience} IN ('owner','customer','everyone','internal') AND (${t.actorKind}='admin' OR ${t.audience}=${t.actorKind}) AND length(trim(${t.body})) BETWEEN 2 AND 2000 AND ${t.requestHash} ~ '^[a-f0-9]{64}$'`)]);
export const disputeAttachment = pgTable('dispute_attachment',{
  id:uuid('id').primaryKey().defaultRandom(),messageId:uuid('message_id').notNull().references(()=>disputeMessage.id,{onDelete:'restrict'}),storageKey:text('storage_key').notNull(),mimeType:varchar('mime_type',{length:32}).notNull(),bytes:integer('bytes').notNull(),sha256:varchar('sha256',{length:64}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('dispute_attachment_hash_idx').on(t.messageId,t.sha256),check('dispute_attachment_valid_chk',sql`${t.mimeType} IN ('image/jpeg','image/png','image/webp') AND ${t.bytes} BETWEEN 1 AND 2097152 AND ${t.sha256} ~ '^[a-f0-9]{64}$'`)]);

/** CP25: editable working copies; published documents are append-only. */
export const contentDraft = pgTable('content_draft', {
  kind: varchar('kind', { length: 20 }).primaryKey(),
  version: integer('version').notNull().default(1),
  body: jsonb('body').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('draft'),
  updatedBy: uuid('updated_by').notNull().references(() => adminUsers.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  basedOnVersion: varchar('based_on_version', { length: 32 }),
}, t => [check('content_draft_kind_chk', sql`${t.kind} IN ('terms','privacy','cancellation','help','contact','owner_help')`),
  check('content_draft_state_chk', sql`${t.state} IN ('draft','reviewed','published') AND ${t.version}>0`)]);

export const contentPublication = pgTable('content_publication', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: varchar('kind', { length: 20 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  body: jsonb('body').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  publishedBy: uuid('published_by').notNull().references(() => adminUsers.id, { onDelete: 'restrict' }),
  isBaseline: boolean('is_baseline').notNull().default(false),
  reviewedBy: uuid('reviewed_by').references(() => adminUsers.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  basedOnVersion: varchar('based_on_version', { length: 32 }),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('content_publication_version_idx').on(t.kind,t.version),
  index('content_publication_current_idx').on(t.kind,t.effectiveAt),
  check('content_publication_review_chk', sql`(${t.isBaseline}=false AND ${t.reviewedBy} IS NOT NULL) OR (${t.isBaseline}=true AND ${t.kind}='contact' AND ${t.version}='2026-09-21')`),
  check('content_publication_kind_chk', sql`${t.kind} IN ('terms','privacy','cancellation','help','contact','owner_help')`)]);

export const calendarFeed=pgTable('calendar_feed',{rentableId:uuid('rentable_id').primaryKey().references(()=>rentable.id,{onDelete:'cascade'}),tokenHash:text('token_hash').notNull().unique(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),revokedAt:timestamp('revoked_at',{withTimezone:true})});

export const ownerNotification=pgTable('owner_notification',{
 id:uuid('id').primaryKey().defaultRandom(),userId:uuid('user_id').notNull().references(()=>users.id,{onDelete:'restrict'}),updateId:uuid('update_id').notNull().references(()=>clientUpdate.id,{onDelete:'restrict'}),
 eventKey:text('event_key').notNull(),event:varchar('event',{length:64}).notNull(),category:varchar('category',{length:16}).notNull(),channel:varchar('channel',{length:16}).notNull(),payload:jsonb('payload').notNull().default({}),
 state:varchar('state',{length:16}).notNull().default('pending'),attempts:integer('attempts').notNull().default(0),nextAttemptAt:timestamp('next_attempt_at',{withTimezone:true}).notNull().defaultNow(),sentAt:timestamp('sent_at',{withTimezone:true}),deliveredAt:timestamp('delivered_at',{withTimezone:true}),failureCode:varchar('failure_code',{length:64}),providerId:text('provider_id'),providerAccount:text('provider_account'),recipient:text('recipient'),sender:text('sender'),bodyHash:varchar('body_hash',{length:64}),leaseToken:uuid('lease_token'),leaseUntil:timestamp('lease_until',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[uniqueIndex('owner_notification_event_idx').on(t.userId,t.eventKey,t.channel),index('owner_notification_due_idx').on(t.nextAttemptAt).where(sql`${t.state} IN ('pending','retry','blocked','accepted','sending')`),check('owner_notification_valid_chk',sql`${t.channel} IN ('mobile','email','whatsapp','sms') AND ${t.state} IN ('pending','sending','accepted','delivered','retry','blocked','failed','unknown','suppressed') AND ${t.attempts}>=0 AND jsonb_typeof(${t.payload})='object'`)]);
