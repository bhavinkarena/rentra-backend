export function whatsappListingUrl({ text, url }) {
  return `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
}

export async function copyListingUrl(clipboard, url) {
  try {
    await clipboard?.writeText(url);
    return clipboard?.writeText ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}

export async function shareListing(navigatorLike, payload) {
  if (navigatorLike?.share) {
    try {
      await navigatorLike.share(payload);
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }
  return copyListingUrl(navigatorLike?.clipboard, payload.url);
}
