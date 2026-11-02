/** Deterministic server-side review content check. Returns REVIEW_REASONS codes; [] means clean. Ratings are never inputs. */
// ponytail: starter list of explicit abusive terms (English + Hindi transliterations); extend from real moderation cases.
const ABUSIVE = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole',
  'cunt', 'slut', 'whore', 'retard', 'chutiya', 'chutiye', 'madarchod', 'behenchod', 'bhenchod',
  'bhosdike', 'bhosdi', 'gaandu', 'gandu', 'haramkhor', 'kamina', 'kamine', 'randi', 'lavde',
  'lauda', 'lund',
];
const ABUSE = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${ABUSIVE.join('|')})(?![\\p{L}\\p{M}\\p{N}])`, 'iu');
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const UPI =
  /[\w.-]{2,}@(?:okaxis|oksbi|okhdfcbank|okicici|ybl|ibl|axl|paytm|upi|apl|yapl|ikwik|fbl|pthdfc|ptsbi|ptaxis|ptyes|waicici|wahdfcbank|axisbank|hdfcbank|icici|sbi|kotak|airtel|jio|freecharge)\b/i;
const HANDLE = /(?:^|\s)@[\w.]{3,}/;
const PHONE = /\+?\(?\d(?:[\s.()-]{0,2}\d){9,}/;
const URL = /\b(?:https?:\/\/|www\.)\S/i;
// A TLD must end the word: end, whitespace, '/', or punctuation not followed by a letter.
// Allowed ambiguity (a missing space after a full stop): a Capitalised TLD before a space ("stay.In the"),
// or any TLD followed by a space and a capitalised word ("great.in The").
const DOMAIN =
  /\b[a-z0-9-]+\.(com|in|net|org|io|co|me|info|biz|xyz|app|link|ly)(?=$|\/|\s|[^\p{L}\p{N}\s](?!\p{L}))/giu;
const hasDomain = (text) =>
  [...text.matchAll(DOMAIN)].some((m) => {
    const after = text.slice(m.index + m[0].length);
    return !(/^\s\p{Lu}/u.test(after) || (/^\p{Lu}\p{Ll}+$/u.test(m[1]) && /^\s/.test(after)));
  });

export function reviewContentFlags(body) {
  const text = String(body ?? '');
  const flags = new Set();
  const noEmail = text.replace(EMAIL, ' ');
  if (noEmail !== text || UPI.test(text) || HANDLE.test(text) || PHONE.test(text))
    flags.add('private_information');
  const letters = text.match(/[\p{L}\p{M}]/gu) ?? [];
  const upper = text.match(/\p{Lu}/gu) ?? [];
  const words = text.toLowerCase().match(/[\p{L}\p{M}\p{N}']+/gu) ?? [];
  const counts = words.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
  const counted = text.replace(/[\s\p{Extended_Pictographic}\u200d\ufe0f]/gu, '').length;
  if (
    URL.test(text) ||
    hasDomain(noEmail) ||
    /(.)\1{5,}/u.test(text) ||
    [...counts.values()].some((n) => n >= 6 && n / words.length > 0.3) ||
    (counted > 0 && letters.length / counted < 0.5) ||
    (letters.length >= 10 && upper.length / letters.length > 0.7)
  )
    flags.add('spam');
  if (ABUSE.test(text)) flags.add('harassment');
  if (counts.size < 3) flags.add('unrelated_content');
  return ['private_information', 'harassment', 'spam', 'unrelated_content'].filter((c) =>
    flags.has(c),
  );
}
