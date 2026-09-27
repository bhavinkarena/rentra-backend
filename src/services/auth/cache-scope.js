import { createHash } from 'node:crypto';

// Stable across requests, different after same-user login or live permission changes.
// Legacy sessions without a generation keep using server-rendered pages.
export function portalCacheScope(actor, session) {
  if (!actor || !session?.sessionId || actor.role !== 'client') return null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        actor.role,
        actor.id,
        session.sessionId,
        actor.accountStatus,
        [...(actor.capabilities ?? [])].sort(),
      ]),
    )
    .digest('hex');
}
