import 'server-only';

import { z } from 'zod';
import { conflict, notFound, unprocessable } from '@/utils/apiError.js';
import { getClientListingsPage } from '../db/listing-queries.js';
import { listBookingRecords } from '../booking/records.js';

/**
 * The client's updates inbox and task list (CP15).
 *
 * Updates are persisted rows written by database triggers (migration 0030);
 * this module only reads them, marks them read and stores preferences. Tasks
 * are derived on each request from the same list queries their destination
 * pages run, so a task's count always equals the list it opens.
 */

export const MUTABLE_CATEGORIES = ['property', 'booking', 'case'];
const PAGE_SIZE = 20;

const listInput = z.object({
  filter: z.enum(['all', 'unread', 'action']).catch('all'),
  category: z.enum(['all', 'account', 'property', 'booking', 'case']).catch('all'),
  page: z.coerce.number().int().min(1).max(100000).catch(1),
});

const dto = (row) => ({
  id: row.id,
  category: row.category,
  kind: row.kind,
  action: row.action,
  rentableId: row.rentable_id,
  orderId: row.order_id,
  propertyTitle: row.property_title,
  detail: row.detail ?? {},
  createdAt: row.created_at,
  read: Boolean(row.read_at),
});

/** Unread and unread-required counts, for the navigation badge. */
export async function unreadCounts(database, clientId) {
  const [counts] = await database`SELECT count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
      count(*) FILTER (WHERE read_at IS NULL AND kind='action')::int AS action
    FROM client_update WHERE client_id=${clientId}`;
  return counts;
}

export async function listClientUpdates(database, clientId, input = {}) {
  const f = listInput.parse(input ?? {});
  const filter =
    f.filter === 'unread'
      ? database`u.read_at IS NULL`
      : f.filter === 'action'
        ? // Required work not yet read: the same set the dashboard task counts.
          database`u.kind='action' AND u.read_at IS NULL`
        : database`true`;
  const category = f.category === 'all' ? database`true` : database`u.category=${f.category}`;
  const where = database`u.client_id=${clientId} AND ${filter} AND ${category}`;
  const [{ total }] = await database`SELECT count(*)::int AS total FROM client_update u WHERE ${where}`;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const rows = await database`SELECT u.*, r.title AS property_title FROM client_update u
    LEFT JOIN rentable r ON r.id=u.rentable_id
    WHERE ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  return { ...f, page, pages, total, ...(await unreadCounts(database, clientId)), items: rows.map(dto) };
}

/** Marks one update (`id`) or every unread update (`all`) read; idempotent. */
export async function markClientUpdatesRead(database, clientId, input = {}) {
  if (input?.all === '1' || input?.all === true || input?.all === 'true') {
    const rows = await database`UPDATE client_update SET read_at=now()
      WHERE client_id=${clientId} AND read_at IS NULL RETURNING id`;
    return { updated: rows.length, ...(await unreadCounts(database, clientId)) };
  }
  const id = z.string().uuid().safeParse(input?.id);
  if (!id.success) throw unprocessable({ id: 'Choose an update.' });
  const [row] = await database`SELECT id, read_at FROM client_update WHERE id=${id.data} AND client_id=${clientId}`;
  // Another client's update id answers exactly like a missing one.
  if (!row) throw notFound('UPDATE_NOT_FOUND', 'That update does not exist.');
  if (!row.read_at) await database`UPDATE client_update SET read_at=now() WHERE id=${row.id} AND read_at IS NULL`;
  return { updated: row.read_at ? 0 : 1, ...(await unreadCounts(database, clientId)) };
}

export async function readClientPreferences(database, clientId) {
  const [row] = await database`SELECT muted, version, updated_at FROM client_update_preference WHERE user_id=${clientId}`;
  return {
    muted: Array.isArray(row?.muted) ? row.muted : [],
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
    categories: MUTABLE_CATEGORIES,
  };
}

/**
 * Saves which informational categories arrive already read. Version-guarded:
 * a second tab's stale form is refused rather than silently overwriting.
 */
export async function saveClientPreferences(database, clientId, input = {}) {
  const parsed = z
    .object({
      expectedVersion: z.coerce.number().int().min(0),
      muted: z.array(z.enum(MUTABLE_CATEGORIES)).default([]),
    })
    .safeParse({ ...input, muted: [].concat(input?.muted ?? []).filter(Boolean) });
  if (!parsed.success) throw unprocessable({ muted: 'Choose from the listed update types.' });
  const { expectedVersion, muted } = parsed.data;
  const value = JSON.stringify([...new Set(muted)].sort());
  return database.begin(async (tx) => {
    const [current] = await tx`SELECT version FROM client_update_preference WHERE user_id=${clientId} FOR UPDATE`;
    if ((current?.version ?? 0) !== expectedVersion)
      throw conflict('PREFERENCES_CHANGED', 'Your update preferences changed in another tab. Reload and try again.');
    const [row] = current
      ? await tx`UPDATE client_update_preference SET muted=${value}::text::jsonb, version=version+1, updated_at=now()
          WHERE user_id=${clientId} RETURNING muted, version, updated_at`
      : await tx`INSERT INTO client_update_preference(user_id, muted) VALUES (${clientId}, ${value}::text::jsonb)
          RETURNING muted, version, updated_at`;
    return { muted: row.muted, version: row.version, updatedAt: row.updated_at, categories: MUTABLE_CATEGORIES };
  });
}

/**
 * Required work first, then information. Each count comes from the query its
 * destination page runs, with the same filter, so the two cannot disagree.
 */
export async function clientTasks(database, clientId) {
  const listing = async (status) => (await getClientListingsPage(clientId, { status, pageSize: 5 })).total;
  const [attention, resubmit, unbookable, hidden, review, bookings, counts] = await Promise.all([
    listing('attention'),
    listing('resubmit'),
    listing('unbookable'),
    listing('hidden'),
    listing('review'),
    listBookingRecords(database, { kind: 'owner', id: clientId }, { tab: 'action_needed' }),
    unreadCounts(database, clientId),
  ]);
  const tasks = [
    { key: 'visits_action', kind: 'action', count: bookings.summary.action_needed, href: '/partner/bookings?tab=action_needed' },
    { key: 'properties_attention', kind: 'action', count: attention, href: '/partner/listings?status=attention' },
    { key: 'properties_resubmit', kind: 'action', count: resubmit, href: '/partner/listings?status=resubmit' },
    { key: 'properties_unbookable', kind: 'action', count: unbookable, href: '/partner/listings?status=unbookable' },
    { key: 'updates_action', kind: 'action', count: counts.action, href: '/partner/updates?filter=action' },
    { key: 'properties_hidden', kind: 'info', count: hidden, href: '/partner/listings?status=hidden' },
    { key: 'properties_review', kind: 'info', count: review, href: '/partner/listings?status=review' },
    { key: 'visits_today', kind: 'info', count: bookings.summary.today, href: '/partner/bookings?tab=today' },
    { key: 'updates_unread', kind: 'info', count: counts.unread, href: '/partner/updates?filter=unread' },
  ];
  return { tasks, unread: counts.unread, actionUnread: counts.action };
}
