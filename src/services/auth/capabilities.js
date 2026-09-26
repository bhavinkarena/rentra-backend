/** Business permissions; record ownership remains a separate service-layer check. */
const adminDomains = ['applications', 'properties', 'clients', 'customers', 'documents', 'payments', 'records', 'reviews', 'support', 'notifications', 'privacy', 'operations'];
export const ADMIN_CAPABILITIES = Object.freeze(adminDomains.flatMap(domain => [`admin.${domain}.read`, `admin.${domain}.write`]));
export const CLIENT_BASE_CAPABILITIES = Object.freeze(['client.application.read', 'client.application.write', 'client.documents.read', 'client.documents.write', 'client.settings.write', 'client.catalogue.read', 'client.listings.read', 'client.updates.read', 'client.updates.write']);
export const CLIENT_ACTIVE_CAPABILITIES = Object.freeze([...CLIENT_BASE_CAPABILITIES, 'client.listings.write', 'client.calendar.read', 'client.calendar.write', 'client.records.read', 'client.records.write', 'client.reviews.read', 'client.reviews.write', 'client.tasks.read']);
// Contract only: staff authentication and property assignments ship in CP16.
export const CARETAKER_CAPABILITIES = Object.freeze(['staff.assigned-visits.read', 'staff.assigned-visits.evidence']);

export function capabilitiesFor(actor, kind) {
  if (!actor) return [];
  if (kind === 'admin') {
    if (!actor.isActive) return [];
    return actor.permissions == null ? [...ADMIN_CAPABILITIES] : ADMIN_CAPABILITIES.filter(capability => Array.isArray(actor.permissions) && actor.permissions.includes(capability));
  }
  if (actor.role !== 'client') return [];
  if (actor.accountStatus === 'active') return [...CLIENT_ACTIVE_CAPABILITIES];
  if (actor.accountStatus === 'pending_application') return [...CLIENT_BASE_CAPABILITIES];
  return [];
}

export function routeCapability(kind, method, path) {
  const segments = path.split('/').filter(Boolean);
  let domain = segments[0];
  if (kind === 'admin' && domain === 'users' && segments[2] === 'documents') domain = 'documents';
  if (kind === 'client' && domain === 'listings' && segments[2] === 'calendar') domain = 'calendar';
  const capability = `${kind}.${domain}.${['GET', 'HEAD'].includes(method) ? 'read' : 'write'}`;
  const known = kind === 'admin' ? ADMIN_CAPABILITIES : CLIENT_ACTIVE_CAPABILITIES;
  return known.includes(capability) ? capability : null;
}

export function canAccessRoute(actor, kind, method, path) {
  const capability = routeCapability(kind, method, path);
  return Boolean(capability && capabilitiesFor(actor, kind).includes(capability));
}
