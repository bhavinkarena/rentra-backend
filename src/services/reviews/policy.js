import { createHmac } from 'node:crypto';
export const REVIEW_REASONS = [
  'meets_policy',
  'private_information',
  'harassment',
  'spam',
  'unrelated_content',
  'manipulation',
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
    : REVIEW_REASONS.includes(category) && category !== 'meets_policy';
}
export const REVIEW_STATE_MESSAGES = {
  published: 'Your review is live.',
  pending:
    "Thanks — your review is being checked before it appears. This usually happens when it contains contact details, links or language our rules don't allow.",
  rejected: 'This review was not published. Contact support if you think this is wrong.',
  hidden: 'This review was not published. Contact support if you think this is wrong.',
};
