import 'server-only';

import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';

/**
 * Admin customer directory and account controls (CP04).
 *
 * Minimization: lists and detail show the contact fields an operator needs
 * (admin-only, capability-guarded), never OTP challenges, session ids, payment-method tokens or
 * the profile photo key. Audit entries name changed FIELDS, not their values,
 * matching the customer's own profile audit.
 *
 * Identity corrections (name, email, language) are separate from
 * authentication: the phone number is the sign-in credential and is not
 * editable here. Phone changes go through the customer's verified flow.
 *
 * Concurrency: `user.lifecycle_version` guards every admin command on the
 * account; corrections also carry `customer_profile.version`, so a customer
 * saving their own profile in parallel produces a conflict, not a lost edit.
 */

const PAGE_SIZE = 20;
// `pending_application` is the column default: rows created without a status
// (older seed/import data). Such a customer cannot sign in until activated.
const STATUSES = ['active', 'pending_application', 'suspended', 'blocked'];
const uuid = z.string().uuid();
const reason = z.string().trim().min(4, 'Say why — this is the audit record.').max(1000);
const version = z.coerce.number().int().min(0);

export const customerListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  status: z.enum(['all', ...STATUSES]).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});

const correctionInput = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Enter at least two characters.')
    .max(160)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'Remove control characters.'),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email.').max(254)]),
  preferredLocale: z.enum(['en', 'hi', 'gu']),
  reason,
  expectedVersion: version,
  expectedProfileVersion: version,
});
const commandInput = z.object({ reason, expectedVersion: version });

const fieldErrors = (error) =>
  Object.fromEntries(error.issues.map((issue) => [issue.path[0], issue.message]));

const upcoming = (sql) =>
  sql`v.state IN ('confirmed','handed_over','disputed') AND v.ends_at > clock_timestamp()`;

export async function listCustomers(database, input = {}) {
  const f = customerListQuery.parse(input);
  const match = database`(${f.q} = '' OR position(lower(${f.q}) in lower(coalesce(u.name,''))) > 0
    OR position(lower(${f.q}) in lower(coalesce(u.email,''))) > 0
    OR position(${f.q} in coalesce(u.phone,'')) > 0)`;
  const [counts] = await database`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE u.account_status='active')::int AS active,
      count(*) FILTER (WHERE u.account_status='pending_application')::int AS pending_application,
      count(*) FILTER (WHERE u.account_status='suspended')::int AS suspended,
      count(*) FILTER (WHERE u.account_status='blocked')::int AS blocked
    FROM "user" u WHERE u.role='customer' AND ${match}`;
  const total = f.status === 'all' ? counts.total : counts[f.status];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const status = f.status === 'all' ? database`true` : database`u.account_status=${f.status}`;
  const rows = await database`SELECT u.id, u.name, u.email, u.phone, u.account_status, u.created_at,
      u.last_login_at,
      (SELECT count(*)::int FROM booking_order o WHERE o.customer_id=u.id) AS order_count,
      (SELECT count(*)::int FROM support_request s WHERE s.customer_id=u.id AND s.state<>'resolved') AS open_support
    FROM "user" u WHERE u.role='customer' AND ${match} AND ${status}
    ORDER BY u.created_at DESC, u.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  return {
    q: f.q,
    status: f.status,
    page,
    pages,
    pageSize: PAGE_SIZE,
    total,
    counts: {
      all: counts.total,
      ...Object.fromEntries(STATUSES.map((key) => [key, counts[key]])),
    },
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      accountStatus: r.account_status,
      orderCount: r.order_count,
      openSupport: r.open_support,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    })),
  };
}

async function loadCustomer(tx, customerId, { lock = false } = {}) {
  if (!uuid.safeParse(customerId).success) return null;
  const rows = lock
    ? await tx`SELECT u.*, coalesce(p.version, 0) AS profile_version FROM "user" u
        LEFT JOIN customer_profile p ON p.user_id=u.id
        WHERE u.id=${customerId} AND u.role='customer' FOR UPDATE OF u`
    : await tx`SELECT u.*, coalesce(p.version, 0) AS profile_version, p.marketing_consent FROM "user" u
        LEFT JOIN customer_profile p ON p.user_id=u.id
        WHERE u.id=${customerId} AND u.role='customer'`;
  return rows[0] ?? null;
}

async function impact(tx, customerId) {
  const [row] = await tx`SELECT
      (SELECT count(*)::int FROM customer_session s WHERE s.user_id=${customerId}
        AND s.revoked_at IS NULL AND s.expires_at > now()) AS open_sessions,
      (SELECT count(*)::int FROM booking v JOIN booking_order o ON o.id=v.order_id
        WHERE o.customer_id=${customerId} AND ${upcoming(tx)}) AS upcoming_visits,
      (SELECT count(*)::int FROM booking_order o WHERE o.customer_id=${customerId}
        AND o.state='held' AND o.hold_expires_at > clock_timestamp()) AS active_holds,
      (SELECT count(*)::int FROM support_request s WHERE s.customer_id=${customerId}
        AND s.state<>'resolved') AS open_support`;
  return {
    openSessions: row.open_sessions,
    upcomingVisits: row.upcoming_visits,
    activeHolds: row.active_holds,
    openSupport: row.open_support,
  };
}

function transition(action, status) {
  if (action === 'suspend') {
    return status === 'active'
      ? { allowed: true, to: 'suspended' }
      : { allowed: false, why: `A ${status} account cannot be restricted again.` };
  }
  // Reinstate restores a restricted account and activates a never-activated one.
  return status === 'suspended' || status === 'pending_application'
    ? { allowed: true, to: 'active' }
    : { allowed: false, why: status === 'blocked' ? 'Blocked accounts are not reinstated here.' : 'This account already has access.' };
}

function preview(action, customer, effects) {
  const step = transition(action, customer.account_status);
  return {
    action,
    allowed: step.allowed,
    blockedReason: step.allowed ? null : step.why,
    fromStatus: customer.account_status,
    toStatus: step.allowed ? step.to : null,
    expectedVersion: customer.lifecycle_version,
    effects,
    consequences:
      action === 'suspend'
        ? [
            `${effects.openSessions} open session(s) end on the customer's next request; phone sign-in is refused.`,
            `New quotes, holds and payments are refused; ${effects.activeHolds} active hold(s) expire on their own.`,
            `${effects.upcomingVisits} upcoming visit(s) stay booked. Changes or cancellations go through Rentra support cases.`,
            `${effects.openSupport} open support request(s) stay visible to staff.`,
          ]
        : customer.account_status === 'pending_application'
          ? [
              'This account was never activated, so phone sign-in is refused today.',
              'After activation the customer can sign in with a one-time code and book.',
            ]
          : [
              'The customer can sign in again with a new code; earlier sessions stay revoked.',
              'Booking, payment and support access return.',
            ],
  };
}

export async function readCustomer(database, customerId) {
  const customer = await loadCustomer(database, customerId);
  if (!customer) throw notFound('CUSTOMER_NOT_FOUND', 'No such customer.');
  const id = customer.id;
  const effects = await impact(database, id);
  const [orders, support, reviews, privacy, history, [sessions]] = await Promise.all([
    database`SELECT o.id, o.reference, o.state, o.created_at, o.listing_snapshot->>'title' AS title,
        (SELECT min(v.day)::text FROM booking v WHERE v.order_id=o.id) AS first_visit
      FROM booking_order o WHERE o.customer_id=${id} ORDER BY o.created_at DESC LIMIT 20`,
    database`SELECT id, reference, subject, category, state, updated_at FROM support_request
      WHERE customer_id=${id} ORDER BY updated_at DESC LIMIT 20`,
    database`SELECT rv.id, rv.rating, rv.moderation_state, rv.created_at, r.title AS listing_title
      FROM review rv LEFT JOIN rentable r ON r.id=rv.rentable_id
      WHERE rv.author_id=${id} ORDER BY rv.created_at DESC LIMIT 20`,
    database`SELECT id, kind, state, created_at FROM customer_privacy_request
      WHERE customer_id=${id} ORDER BY created_at DESC LIMIT 20`,
    database`SELECT l.id, l.action, l.actor_type, l.reason, l.at, l.after->'fields' AS fields,
        l.before->>'accountStatus' AS from_status, l.after->>'accountStatus' AS to_status,
        l.after->>'revoked' AS revoked, a.email AS admin_email
      FROM audit_log l LEFT JOIN admin_user a ON a.id=l.actor_id AND l.actor_type='admin'
      WHERE l.entity='user' AND l.entity_id=${id}
        AND l.action NOT IN ('customer_login')
      ORDER BY l.at DESC LIMIT 50`,
    database`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS open,
        max(created_at) AS latest
      FROM customer_session WHERE user_id=${id}`,
  ]);
  const [counts] = await database`SELECT
      (SELECT count(*)::int FROM booking_order WHERE customer_id=${id}) AS orders,
      (SELECT count(*)::int FROM support_request WHERE customer_id=${id}) AS support,
      (SELECT count(*)::int FROM review WHERE author_id=${id}) AS reviews`;

  return {
    customer: {
      id,
      name: customer.name,
      email: customer.email,
      emailVerifiedAt: customer.email_verified_at,
      phone: customer.phone,
      phoneVerifiedAt: customer.phone_verified_at,
      preferredLocale: customer.preferred_locale,
      marketingConsent: Boolean(customer.marketing_consent),
      accountStatus: customer.account_status,
      createdAt: customer.created_at,
      lastLoginAt: customer.last_login_at,
      lifecycleVersion: customer.lifecycle_version,
      profileVersion: customer.profile_version,
    },
    sessions: { open: sessions.open, total: sessions.total, latest: sessions.latest },
    bookings: {
      total: counts.orders,
      items: orders.map((o) => ({
        id: o.id,
        reference: o.reference,
        state: o.state,
        title: o.title || 'Booked property',
        firstVisit: o.first_visit,
        createdAt: o.created_at,
      })),
    },
    support: {
      total: counts.support,
      items: support.map((s) => ({
        id: s.id,
        reference: s.reference,
        subject: s.subject,
        category: s.category,
        state: s.state,
        updatedAt: s.updated_at,
      })),
    },
    reviews: {
      total: counts.reviews,
      items: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        moderationState: r.moderation_state,
        listingTitle: r.listing_title,
        createdAt: r.created_at,
      })),
    },
    privacy: privacy.map((p) => ({ id: p.id, kind: p.kind, state: p.state, createdAt: p.created_at })),
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      actorType: h.actor_type,
      adminEmail: h.admin_email,
      reason: h.reason,
      at: h.at,
      fields: Array.isArray(h.fields) ? h.fields : null,
      fromStatus: h.from_status,
      toStatus: h.to_status,
      revoked: h.revoked == null ? null : Number(h.revoked),
    })),
    lifecycle: preview(
      ['suspended', 'pending_application'].includes(customer.account_status) ? 'reinstate' : 'suspend',
      customer,
      effects,
    ),
  };
}

async function audit(tx, { adminId, customerId, action, before, after, reason: why, ip }) {
  await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, before, after, reason, ip)
    VALUES ('admin', ${adminId}, 'user', ${customerId}, ${action},
      ${before ? JSON.stringify(before) : null}::text::jsonb, ${after ? JSON.stringify(after) : null}::text::jsonb, ${why}, ${ip})`;
}

function stale(customer, expectedVersion) {
  if (customer.lifecycle_version !== expectedVersion) {
    throw conflict(
      'ACCOUNT_CONFLICT',
      'This account changed after you opened it. Reload to see the current details.',
    );
  }
}

/** Restrict (suspend) or reinstate. The 0011 trigger revokes sessions on restriction. */
export async function changeCustomerLifecycle(database, { adminId, customerId, action, input, ip = null }) {
  const parsed = commandInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fieldErrors(parsed.error));
  return database.begin(async (tx) => {
    const customer = await loadCustomer(tx, customerId, { lock: true });
    if (!customer) throw notFound('CUSTOMER_NOT_FOUND', 'No such customer.');
    stale(customer, parsed.data.expectedVersion);
    const step = transition(action, customer.account_status);
    if (!step.allowed) throw conflict('LIFECYCLE_NOT_ALLOWED', step.why);
    const effects = await impact(tx, customer.id);
    const [updated] = await tx`UPDATE "user" SET account_status=${step.to},
        lifecycle_version=lifecycle_version+1, updated_at=now()
      WHERE id=${customer.id} RETURNING account_status, lifecycle_version`;
    await audit(tx, {
      adminId,
      customerId: customer.id,
      action: action === 'suspend' ? 'customer_restricted' : 'customer_reinstated',
      before: { accountStatus: customer.account_status },
      after: { accountStatus: updated.account_status, impact: effects },
      reason: parsed.data.reason,
      ip,
    });
    return {
      customerId: customer.id,
      accountStatus: updated.account_status,
      lifecycleVersion: updated.lifecycle_version,
      impact: effects,
    };
  });
}

/** Sign the customer out everywhere without changing account status. */
export async function revokeCustomerSessions(database, { adminId, customerId, input, ip = null }) {
  const parsed = commandInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fieldErrors(parsed.error));
  return database.begin(async (tx) => {
    const customer = await loadCustomer(tx, customerId, { lock: true });
    if (!customer) throw notFound('CUSTOMER_NOT_FOUND', 'No such customer.');
    stale(customer, parsed.data.expectedVersion);
    // Same lock order as login and lockCustomerAccount: user row, then sessions.
    const revoked = await tx`UPDATE customer_session SET revoked_at=now()
      WHERE user_id=${customer.id} AND revoked_at IS NULL AND expires_at > now() RETURNING id`;
    if (!revoked.length) return { customerId: customer.id, revoked: 0, lifecycleVersion: customer.lifecycle_version };
    const [updated] = await tx`UPDATE "user" SET lifecycle_version=lifecycle_version+1
      WHERE id=${customer.id} RETURNING lifecycle_version`;
    await audit(tx, {
      adminId,
      customerId: customer.id,
      action: 'customer_sessions_revoked',
      after: { revoked: revoked.length },
      reason: parsed.data.reason,
      ip,
    });
    return { customerId: customer.id, revoked: revoked.length, lifecycleVersion: updated.lifecycle_version };
  });
}

/**
 * Permitted identity corrections: name, email, language. The phone number is
 * the credential and cannot be changed here. Changing email clears its
 * verification, as the customer's own flow does.
 */
export async function correctCustomerProfile(database, { adminId, customerId, input, ip = null }) {
  const parsed = correctionInput.safeParse(input ?? {});
  if (!parsed.success) throw unprocessable(fieldErrors(parsed.error));
  const value = parsed.data;
  const email = value.email || null;
  try {
    return await database.begin(async (tx) => {
      const customer = await loadCustomer(tx, customerId, { lock: true });
      if (!customer) throw notFound('CUSTOMER_NOT_FOUND', 'No such customer.');
      stale(customer, value.expectedVersion);
      if (Number(customer.profile_version) !== value.expectedProfileVersion) {
        throw conflict(
          'PROFILE_CONFLICT',
          'The customer updated their profile after you opened it. Reload before correcting.',
        );
      }
      const fields = [
        ['name', customer.name ?? '', value.name],
        ['email', customer.email, email],
        ['preferredLocale', customer.preferred_locale, value.preferredLocale],
      ]
        .filter(([, before, after]) => (before ?? null) !== (after ?? null))
        .map(([field]) => field);
      if (!fields.length) throw unprocessable({ _: 'Nothing changed. Edit a field before saving.' });

      const [updated] = await tx`UPDATE "user" SET name=${value.name}, email=${email},
          preferred_locale=${value.preferredLocale},
          email_verified_at=CASE WHEN email IS NOT DISTINCT FROM ${email} THEN email_verified_at ELSE NULL END,
          lifecycle_version=lifecycle_version+1, updated_at=now()
        WHERE id=${customer.id} RETURNING lifecycle_version`;
      // Keep the customer's own open profile form in step: its version moves too.
      const [profile] = await tx`UPDATE customer_profile SET version=version+1, updated_at=now()
        WHERE user_id=${customer.id} RETURNING version`;
      await audit(tx, {
        adminId,
        customerId: customer.id,
        action: 'customer_profile_corrected',
        after: { fields },
        reason: value.reason,
        ip,
      });
      return {
        customerId: customer.id,
        fields,
        lifecycleVersion: updated.lifecycle_version,
        profileVersion: profile?.version ?? 0,
      };
    });
  } catch (error) {
    if (error.code === '23505') {
      throw unprocessable({ email: 'Another customer account already uses this email.' });
    }
    throw error;
  }
}
