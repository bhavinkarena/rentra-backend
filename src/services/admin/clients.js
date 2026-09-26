import 'server-only';

import { z } from 'zod';
import { revalidateListing } from '@/services/cache/listing-cache.js';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';

/**
 * Admin client directory and account lifecycle (CP03).
 *
 * Suspension policy (CP01): a suspended client has no portal access and no new
 * business — their listings leave every public read and cannot be quoted —
 * while already confirmed visits are fulfilled under Rentra admin control.
 *
 * Lifecycle commands are guarded by `user.lifecycle_version`, which only these
 * commands bump: an admin's reviewed impact preview goes stale when another
 * admin changes the account, not when the client merely signs in.
 */

const PAGE_SIZE = 20;
const STATUSES = ['active', 'pending_application', 'suspended', 'blocked'];
const uuid = z.string().uuid();

export const clientListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  status: z.enum(['all', ...STATUSES]).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});

const commandInput = z.object({
  reason: z.string().trim().min(4, 'Say why — this is the audit record.').max(1000),
  expectedVersion: z.coerce.number().int().min(1),
});

/** The same predicate the owner's own "upcoming" tab uses. */
const upcoming = (sql) =>
  sql`v.state IN ('confirmed','handed_over','disputed') AND v.ends_at > clock_timestamp()`;

function transition(action, status, applicationStatus, suspendedFrom) {
  if (action === 'suspend') {
    return ['active', 'pending_application'].includes(status)
      ? { allowed: true, to: 'suspended' }
      : { allowed: false, why: `A ${status.replace('_', ' ')} account cannot be suspended.` };
  }
  if (status !== 'suspended') {
    return {
      allowed: false,
      why:
        status === 'blocked'
          ? 'Blocked after repeated application rejections; reinstatement belongs to application review.'
          : 'Only a suspended account can be reinstated.',
    };
  }
  // Back to the status recorded when it was suspended; older suspensions
  // without that record fall back to the application outcome.
  if (['active', 'pending_application'].includes(suspendedFrom)) return { allowed: true, to: suspendedFrom };
  return { allowed: true, to: applicationStatus === 'approved' ? 'active' : 'pending_application' };
}

export async function listClients(database, input = {}) {
  const f = clientListQuery.parse(input);
  const match = database`(${f.q} = '' OR position(lower(${f.q}) in lower(coalesce(u.name,''))) > 0
    OR position(lower(${f.q}) in lower(coalesce(u.email,''))) > 0
    OR position(${f.q} in coalesce(u.phone,'')) > 0)`;
  const [counts] = await database`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE u.account_status='active')::int AS active,
      count(*) FILTER (WHERE u.account_status='pending_application')::int AS pending_application,
      count(*) FILTER (WHERE u.account_status='suspended')::int AS suspended,
      count(*) FILTER (WHERE u.account_status='blocked')::int AS blocked
    FROM "user" u WHERE u.role='client' AND ${match}`;
  const total = f.status === 'all' ? counts.total : counts[f.status];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const status = f.status === 'all' ? database`true` : database`u.account_status=${f.status}`;
  const rows = await database`SELECT u.id, u.name, u.email, u.phone, u.client_type, u.account_status,
      u.kyc_status, u.created_at, u.last_login_at, a.status AS application_status,
      (SELECT count(*)::int FROM rentable r WHERE r.client_id=u.id) AS listing_count,
      (SELECT count(*)::int FROM rentable r WHERE r.client_id=u.id AND r.status='live') AS live_count,
      (SELECT count(*)::int FROM booking v JOIN rentable r ON r.id=v.rentable_id
        WHERE r.client_id=u.id AND ${upcoming(database)}) AS upcoming_visits
    FROM "user" u LEFT JOIN client_application a ON a.user_id=u.id
    WHERE u.role='client' AND ${match} AND ${status}
    ORDER BY u.created_at DESC, u.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  return {
    q: f.q,
    status: f.status,
    page,
    pages,
    pageSize: PAGE_SIZE,
    total,
    counts: { all: counts.total, ...Object.fromEntries(STATUSES.map((key) => [key, counts[key]])) },
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      clientType: r.client_type,
      accountStatus: r.account_status,
      kycStatus: r.kyc_status,
      applicationStatus: r.application_status ?? 'not_started',
      listingCount: r.listing_count,
      liveCount: r.live_count,
      upcomingVisits: r.upcoming_visits,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    })),
  };
}

async function impact(tx, clientId) {
  const [counts] = await tx`SELECT
      (SELECT count(*)::int FROM rentable r WHERE r.client_id=${clientId} AND r.status='live') AS live_listings,
      (SELECT count(*)::int FROM booking v JOIN rentable r ON r.id=v.rentable_id
        WHERE r.client_id=${clientId} AND ${upcoming(tx)}) AS upcoming_visits,
      (SELECT count(*)::int FROM portal_session s
        WHERE s.user_id=${clientId} AND s.revoked_at IS NULL AND s.expires_at > now()) AS open_sessions`;
  return {
    liveListings: counts.live_listings,
    upcomingVisits: counts.upcoming_visits,
    openSessions: counts.open_sessions,
  };
}

async function upcomingVisits(tx, clientId, limit) {
  const rows = await tx`SELECT v.id, v.reference, v.state, v.day, v.slot, v.starts_at, v.ends_at,
      coalesce(v.time_zone, o.time_zone, 'Asia/Kolkata') AS time_zone, v.guests,
      o.id AS order_id, o.reference AS order_reference, r.title AS listing_title
    FROM booking v JOIN rentable r ON r.id=v.rentable_id LEFT JOIN booking_order o ON o.id=v.order_id
    WHERE r.client_id=${clientId} AND ${upcoming(tx)}
    ORDER BY v.starts_at ASC, v.id LIMIT ${limit}`;
  return rows.map((v) => ({
    id: v.id,
    reference: v.reference,
    state: v.state,
    day: v.day instanceof Date ? v.day.toISOString().slice(0, 10) : String(v.day),
    slot: v.slot,
    startsAt: v.starts_at,
    endsAt: v.ends_at,
    timeZone: v.time_zone,
    guests: v.guests,
    orderId: v.order_id,
    orderReference: v.order_reference,
    listingTitle: v.listing_title,
  }));
}

function preview(action, client, effects, visits) {
  const step = transition(action, client.account_status, client.application_status, client.suspended_from);
  return {
    action,
    allowed: step.allowed,
    blockedReason: step.allowed ? null : step.why,
    fromStatus: client.account_status,
    toStatus: step.allowed ? step.to : null,
    expectedVersion: client.lifecycle_version,
    effects,
    upcomingVisits: visits,
    consequences:
      action === 'suspend'
        ? [
            `${effects.openSessions} open portal session(s) end on the client's next request; sign-in is refused.`,
            `${effects.liveListings} live listing(s) leave search and public pages; new quotes and checkouts are refused.`,
            `${effects.upcomingVisits} upcoming visit(s) stay confirmed for customers and are fulfilled under Rentra admin control.`,
          ]
        : [
            'The client can sign in again with a new session; earlier sessions stay revoked.',
            `${effects.liveListings} live listing(s) return to search and public pages.`,
            'Listings that were paused or in review keep their own status.',
          ],
  };
}

/** The status the latest suspension moved the account from (written in the same transaction). */
const suspendedFrom = (sql) => sql`(SELECT l.before->>'accountStatus' FROM audit_log l
  WHERE l.entity='user' AND l.entity_id=u.id::text AND l.action='client_suspended'
  ORDER BY l.at DESC LIMIT 1) AS suspended_from`;

async function loadClient(tx, clientId, { lock = false } = {}) {
  if (!uuid.safeParse(clientId).success) return null;
  const rows = lock
    ? await tx`SELECT u.*, a.status AS application_status, ${suspendedFrom(tx)} FROM "user" u
        LEFT JOIN client_application a ON a.user_id=u.id
        WHERE u.id=${clientId} AND u.role='client' FOR UPDATE OF u`
    : await tx`SELECT u.*, a.status AS application_status, ${suspendedFrom(tx)} FROM "user" u
        LEFT JOIN client_application a ON a.user_id=u.id
        WHERE u.id=${clientId} AND u.role='client'`;
  return rows[0] ?? null;
}

export async function readClient(database, clientId) {
  const client = await loadClient(database, clientId);
  if (!client) throw notFound('CLIENT_NOT_FOUND', 'No such client.');

  const [application] = await database`SELECT id, status, submitted_at, reviewed_at, decision_reason,
      strike_count, legal_name FROM client_application WHERE user_id=${client.id}`;
  const listings = await database`SELECT r.id, r.title, r.public_code, r.slug, r.status, r.updated_at,
      c.name AS city_name FROM rentable r LEFT JOIN city c ON c.id=r.city_id
    WHERE r.client_id=${client.id} ORDER BY r.updated_at DESC LIMIT 50`;
  const effects = await impact(database, client.id);
  const visits = await upcomingVisits(database, client.id, 20);
  const history = await database`SELECT l.id, l.action, l.actor_type, l.reason, l.at,
      l.before->>'accountStatus' AS from_status, l.after->>'accountStatus' AS to_status,
      a.email AS admin_email
    FROM audit_log l LEFT JOIN admin_user a ON a.id=l.actor_id AND l.actor_type='admin'
    WHERE (l.entity='user' AND l.entity_id=${client.id})
       OR (l.entity='client_application' AND l.entity_id=${application?.id ?? ''})
    ORDER BY l.at DESC LIMIT 50`;
  const lifecycleAction = client.account_status === 'suspended' ? 'reinstate' : 'suspend';

  return {
    client: {
      id: client.id,
      name: client.name,
      email: client.email,
      phone: client.phone,
      emailVerifiedAt: client.email_verified_at,
      phoneVerifiedAt: client.phone_verified_at,
      clientType: client.client_type,
      accountStatus: client.account_status,
      kycStatus: client.kyc_status,
      preferredLocale: client.preferred_locale,
      createdAt: client.created_at,
      lastLoginAt: client.last_login_at,
      lifecycleVersion: client.lifecycle_version,
    },
    application: application
      ? {
          id: application.id,
          status: application.status,
          legalName: application.legal_name,
          submittedAt: application.submitted_at,
          reviewedAt: application.reviewed_at,
          decisionReason: application.decision_reason,
          strikeCount: application.strike_count,
        }
      : null,
    listings: listings.map((r) => ({
      id: r.id,
      title: r.title,
      publicCode: r.public_code,
      slug: r.slug,
      status: r.status,
      cityName: r.city_name,
      updatedAt: r.updated_at,
    })),
    upcoming: { total: effects.upcomingVisits, items: visits },
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      actorType: h.actor_type,
      adminEmail: h.admin_email,
      reason: h.reason,
      at: h.at,
      fromStatus: h.from_status,
      toStatus: h.to_status,
    })),
    lifecycle: preview(lifecycleAction, client, effects, visits.slice(0, 5)),
  };
}

export async function previewLifecycle(database, clientId, action) {
  const client = await loadClient(database, clientId);
  if (!client) throw notFound('CLIENT_NOT_FOUND', 'No such client.');
  const effects = await impact(database, client.id);
  return preview(action, client, effects, await upcomingVisits(database, client.id, 5));
}

/**
 * Suspend or reinstate. One transaction: lock the account, check the reviewed
 * version and transition, update, and write the admin audit entry. The CP01
 * trigger revokes the client's sessions inside the same transaction.
 */
export async function changeLifecycle(database, { adminId, clientId, action, input, ip = null }) {
  const parsed = commandInput.safeParse(input ?? {});
  if (!parsed.success) {
    throw unprocessable(
      Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])),
    );
  }
  const { reason, expectedVersion } = parsed.data;

  const result = await database.begin(async (tx) => {
    const client = await loadClient(tx, clientId, { lock: true });
    if (!client) throw notFound('CLIENT_NOT_FOUND', 'No such client.');
    if (client.lifecycle_version !== expectedVersion) {
      throw conflict(
        'LIFECYCLE_CONFLICT',
        'This account changed after you reviewed it. Reload to see the current status and impact.',
      );
    }
    const step = transition(action, client.account_status, client.application_status, client.suspended_from);
    if (!step.allowed) throw conflict('LIFECYCLE_NOT_ALLOWED', step.why);

    const effects = await impact(tx, client.id);
    const [updated] = await tx`UPDATE "user" SET account_status=${step.to},
        lifecycle_version=lifecycle_version+1, updated_at=now()
      WHERE id=${client.id} RETURNING account_status, lifecycle_version`;
    await tx`INSERT INTO audit_log(actor_type, actor_id, entity, entity_id, action, before, after, reason, ip)
      VALUES ('admin', ${adminId}, 'user', ${client.id},
        ${action === 'suspend' ? 'client_suspended' : 'client_reinstated'},
        ${JSON.stringify({ accountStatus: client.account_status, lifecycleVersion: client.lifecycle_version })}::jsonb,
        ${JSON.stringify({ accountStatus: updated.account_status, lifecycleVersion: updated.lifecycle_version, impact: effects })}::jsonb,
        ${reason}, ${ip})`;
    const live = await tx`SELECT id, slug, public_code FROM rentable
      WHERE client_id=${client.id} AND status='live'`;
    return { updated, effects, live };
  });

  // Public pages and cards change visibility with the owner's status.
  for (const listing of result.live) {
    revalidateListing({ id: listing.id, slug: listing.slug, publicCode: listing.public_code });
  }

  return {
    clientId,
    accountStatus: result.updated.account_status,
    lifecycleVersion: result.updated.lifecycle_version,
    impact: result.effects,
  };
}
