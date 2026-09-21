/**
 * Derive booking-record access from the router mount, never from user input.
 * Express exposes nested mounts without a trailing slash (for example
 * `/api/v1/admin`), so matching `"/admin/"` incorrectly treats admins as
 * customers.
 */
export function recordKindFromBaseUrl(baseUrl = '') {
  const scope = baseUrl.split('/').filter(Boolean).at(-1);

  if (scope === 'admin') return 'admin';
  if (scope === 'partner') return 'owner';
  if (scope === 'customer') return 'customer';
  return null;
}
