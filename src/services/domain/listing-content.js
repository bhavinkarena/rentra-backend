const ABSOLUTE_HTTP = /^https?:\/\//i;
const PUBLIC_IMAGE_HOSTS = new Set(['res.cloudinary.com']);

/** Resolve only public listing-photo shapes. Invalid and private-looking values stay unpublished. */
export function publicPhotoUrl(photo, { cloudName = '' } = {}) {
  const source = typeof photo?.url === 'string' ? photo.url.trim() : '';
  if (source) {
    if (source.startsWith('/') && !source.startsWith('//')) return source.split(/[?#]/)[0];
    if (!ABSOLUTE_HTTP.test(source)) return null;
    try {
      const url = new URL(source);
      if (url.username || url.password) return null;
      if (url.protocol !== 'https:' || !PUBLIC_IMAGE_HOSTS.has(url.hostname)) return null;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  const key = typeof photo?.key === 'string' ? photo.key.trim() : '';
  if (!key || !cloudName || key.includes('..')) return null;
  const safeKey = key.split('/').map(encodeURIComponent).join('/');
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/upload/${safeKey}`;
}

/**
 * Alt text for Google Images and screen readers. Owner uploads store a
 * placeholder ("<title> — photo 3"), so when the listing context is known the
 * photo is described by its tag and place: "Pool at Green Acres, Dumas, Surat".
 * A hand-written alt (seeded photography) is kept as it is.
 */
export function photoAlt(photo, index, { title = '', place = '' } = {}) {
  const stored = String(photo?.alt ?? '').trim();
  const placeholder = !stored || stored === title || / — photo \d+$/.test(stored);
  if (!title || !placeholder) return stored || `Listing photo ${index + 1}`;
  const where = place ? `${title}, ${place}` : title;
  const tag = String(photo?.tag ?? '').trim();
  return tag && tag !== 'Other' ? `${tag} at ${where}` : `${where} — photo ${index + 1}`;
}

/** `title` and `place` ("Dumas, Surat") turn placeholder alts into descriptive ones. */
export function normalizePublicPhotos(photos, options = {}) {
  return (Array.isArray(photos) ? photos : []).flatMap((photo, index) => {
    const url = publicPhotoUrl(photo, options);
    return url ? [{
      url,
      alt: photoAlt(photo, index, options),
      width: Number(photo?.width ?? photo?.w) || undefined,
      height: Number(photo?.height ?? photo?.h) || undefined,
    }] : [];
  });
}

export function absolutePublicUrl(siteUrl, pathOrUrl) {
  if (!pathOrUrl) return null;
  if (ABSOLUTE_HTTP.test(pathOrUrl)) return pathOrUrl;
  return pathOrUrl.startsWith('/') && !pathOrUrl.startsWith('//')
    ? new URL(pathOrUrl, siteUrl).toString() : null;
}

export function formatAmenityValue(item) {
  const value = String(item.value ?? '').trim();
  if (!value) return item.label;
  return `${item.label} — ${value}`;
}

export function amenityStates({ selected = [], catalogue = [], legacy = [] }) {
  if (selected.length) {
    const selectedIds = new Set(selected.map((item) => item.id));
    return {
      included: selected.filter((item) => item.valueType !== 'charge').map(formatAmenityValue),
      extra: selected.filter((item) => item.valueType === 'charge').map(formatAmenityValue),
      unavailable: catalogue.filter((item) => !selectedIds.has(item.id)).map((item) => item.label),
      unknown: [],
    };
  }

  const labels = (Array.isArray(legacy) ? legacy : []).filter((value) => typeof value === 'string' && value.trim());
  return {
    included: labels,
    extra: [],
    unavailable: [],
    unknown: catalogue.map((item) => item.label),
  };
}

export function publicSlotSchedules(bookingConfig) {
  const slots = bookingConfig?.slots;
  if (!slots || typeof slots !== 'object') return [];
  return Object.entries(slots).flatMap(([slot, schedule]) => schedule?.enabled ? [{
    slot,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    endDayOffset: schedule.endDayOffset,
    capacity: schedule.capacity,
    includedGuests: schedule.includedGuests,
  }] : []);
}

const STAG = { no: 'No stag groups', on_request: 'Stag groups on request', yes: 'Stag groups welcome' };

/** Guest-facing lines for farmhouse rules; the owner editor stores structured toggles. */
export function publicHouseRules(rules) {
  if (Array.isArray(rules)) return rules;
  if (!rules || typeof rules !== 'object') return [];
  return [
    rules.petsAllowed ? 'Pets allowed' : 'No pets',
    rules.alcoholAllowed ? 'Alcohol allowed' : 'No alcohol',
    STAG[rules.stagGroups],
    rules.musicCutoff ? `Music off by ${rules.musicCutoff}` : null,
    rules.notes,
  ].filter(Boolean);
}
