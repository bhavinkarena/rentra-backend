import { createHmac } from 'node:crypto';
export const REVIEW_REASONS = [
  'meets_policy',
  'private_information',
  'harassment',
  'spam',
  'unrelated_content',
];
export function reviewPreviewToken(
  actor,
  id,
  version,
  command,
  values,
  secret = process.env.SESSION_SECRET,
) {
  return createHmac('sha256', secret)
    .update(JSON.stringify([actor, id, version, command, values]))
    .digest('hex');
}
export function moderationAllowed(state, category) {
  return state === 'published'
    ? category === 'meets_policy'
    : ['private_information', 'harassment', 'spam', 'unrelated_content'].includes(category);
}
