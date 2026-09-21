export const POLICY_VERSION = '2026-09-21';
export const supportCategories = { booking: 'Booking or arrival', change: 'Change dates or guests', cancellation: 'Cancellation', payment: 'Test payment or refund', privacy: 'Privacy or account data', other: 'Something else' };
export const supportStates = { open: 'Open', in_progress: 'In progress', waiting_customer: 'Awaiting customer reply', resolved: 'Resolved' };
export const faqs = [
  { question: 'When is my booking confirmed?', answer: 'Your booking is confirmed only after Rentra verifies the Razorpay Test capture and reserves every selected visit. A payment window, bank-style Test message or pending status is not confirmation.', href: '/bookings', link: 'Check your bookings' },
  { question: 'Why are payments unavailable?', answer: 'New payments can be disabled by Rentra. You can still browse and check dates. Existing payment attempts and refund checks continue; do not start a second payment to resolve an uncertain result.', href: '/support', link: 'Ask about a payment' },
  { question: 'Can I book several dates or an overnight stay?', answer: 'Choose up to 10 visit start dates with the same slot and guest count. All times use the property timezone, Asia/Kolkata. Each visit has its own arrival and departure; separate or consecutive dates do not include access between visits.' },
  { question: 'How do I cancel one visit or check my refund?', answer: 'Open the booking record, choose Cancel visits or change plans, select visits and review the estimate before confirming. Cutoffs apply to each visit. Only verified captured amounts can be refunded. A pending Test refund is not complete and no actual bank money is refunded.', href: '/policies/cancellation', link: 'Read cancellation rules' },
  { question: 'How can I change dates or guest numbers?', answer: 'Open a change request from your booking if you need help. Sending it does not change or cancel your booking, reserve replacement dates, or promise the old price. The current change path is cancellation under the accepted rules and a fresh booking at current availability and prices.', href: '/bookings', link: 'Open your booking' },
  { question: 'Where are the address and host contact?', answer: 'Exact arrival details are in your private confirmed booking record. They are not on public pages. For an arrival problem, check that record and contact the host; support requests are not live chat or an emergency service.', href: '/bookings', link: 'Find arrival details' },
  { question: 'What do rent, fees and deposit mean?', answer: 'The quote shows rent and an 8% platform fee in INR, with the deposit separately. Test checkout collects the displayed full or advance amount, excluding the deposit. No actual bank money is taken in Razorpay Test. A listed deposit is not evidence it was collected.' },
  { question: 'Who can write a review?', answer: 'Only the customer for an eligible completed real visit with recorded handover, return and completion evidence. A Test payment does not prove a visit occurred. Reviews of every score undergo the same publication rules.', href: '/bookings', link: 'Find your completed visit' },
  { question: 'How do I request my data or account deletion?', answer: 'Submit a privacy request from your account and use its support link to ask questions. A saved request or resolved conversation does not mean export or deletion is complete. Necessary booking, payment, audit and dispute records are reviewed separately.', href: '/account/privacy', link: 'Privacy requests' },
  { question: 'How do support replies work?', answer: 'Sign in, send a request and keep its saved reference. Return to Your support requests to read replies or add details. You can reopen a resolved conversation by replying. No response time or continuous attendance is promised.', href: '/support', link: 'Your support requests' },
];
// Keep published versions addressable. Add a new version instead of editing accepted history.
export const policyVersions = { '2026-09-20': {
  terms: { title: 'Test booking terms', sections: [
    ['What this service offers', 'Rentra facilitates bookings between guests and property owners. The accepted listing, visit times, guest count, prices and house rules are retained in your booking record. The owner operates the property.'],
    ['Dates, prices and confirmation', 'A quote checks current availability and prices but does not reserve dates. Checkout holds are time-limited. Confirmation requires verified Test capture and reservation of all selected visits. Follow the exact arrival and departure times in Asia/Kolkata; full day does not automatically mean 24 hours.'],
    ['Test payments', 'Online checkout uses Razorpay Test. No actual bank money is collected, refunded or paid to an owner through these Test transactions. Review the quoted full or advance collection and separate deposit. Never send a real transfer because of a Test payment or support message.'],
    ['Changes and cancellations', 'Accepted per-visit cancellation rules apply. A support request does not alter a booking. Rebooking requires a new availability and price check; replacement dates are not guaranteed. Started visits and unsupported historical policies need staff review.'],
    ['Account and communication', 'Keep your account contact details accurate. Do not share OTPs, access codes or payment credentials in a review or support conversation. Support replies are available in your private account; no live-chat attendance or response deadline is promised.'],
  ] },
  cancellation: { title: 'Cancellation and Test refunds', sections: [
    ['Your accepted rules', 'The policy version and cancellation tier saved with each visit govern its estimate. The current supported booking policy is customer-v1. These public explanations do not replace a historical booking snapshot or authorize a refund for unsupported records.'],
    ['Per-visit cutoffs', 'Cutoffs count exact elapsed 24-hour days before the stored arrival time, not midnight calendar dates. Flexible: 100% rent at least 3 days before arrival, then 50% before arrival. Moderate: 100% at least 7 days before, 50% at least 3 days before, then 0%. Strict: 50% at least 7 days before, then 0%. At or after arrival, use support; self-service cancellation is unavailable.'],
    ['Fees and captured funds', 'The platform fee is refundable only with a full flexible-tier rent refund. Amounts are calculated in paise and capped at verified captured component amounts less prior refund obligations. Uncollected balances or deposits cannot be refunded by the gateway. Deposits are outside the current Test checkout collection.'],
    ['Preview, confirm and track', 'Select the visits and review the current estimate before confirming. Only selected visits are cancelled. A change to the estimate requires another review. A refund request remains pending until provider verification; a Test refund never represents actual bank money returned.'],
    ['Changing a booking', 'The current change path is cancellation and a fresh booking. Ask support when uncertain, but your original booking stays unchanged until you complete an authorized cancellation. New dates, guest counts and prices must be checked again.'],
  ] },
  privacy: { title: 'Privacy and retained records', sections: [
    ['Data used for your account and booking', 'Rentra stores your account contact details, sessions, preferences, saved places, booking and visit details, payment references, reviews and support messages to operate these services. Payment credentials are entered in the provider checkout, not in Rentra support.'],
    ['Who can see it', 'Your booking and support conversations require authentication and ownership checks. Authorized Rentra staff can review support and privacy requests. Property owners see the operational booking details needed for their listings; they do not have access to the customer support inbox. Published reviews are public. Exact arrival details are restricted to authorized booking records.'],
    ['Service providers', 'Razorpay processes Test checkout information. When configured, Twilio processes OTP or booking SMS delivery. Hosting and storage services process the data used to run Rentra. SMS availability is separate from the private support conversation; return to the account to read support replies.'],
    ['Retention and requests', 'Account data and support conversations remain stored while requests, bookings, reconciliation or disputes need review. Booking, financial and audit records may be retained separately when an account deletion is requested. Rentra currently reviews data-copy and deletion requests manually; there is no automatic deletion deadline or fixed retention period promised here. Request a review from Privacy and account requests, and staff can explain the records that must remain.'],
    ['Limits of a support resolution', 'Resolving a support conversation does not delete an account, export data, erase financial history or fulfill a linked privacy request. Its separate status remains visible. Do not include identity documents, OTPs, access codes, card details or bank credentials in messages.'],
  ] },
} };

policyVersions[POLICY_VERSION] = {
  ...policyVersions['2026-09-20'],
  privacy: { ...policyVersions['2026-09-20'].privacy, sections: [
    ...policyVersions['2026-09-20'].privacy.sections,
    ['Optional aggregate measurement', 'When enabled, Rentra counts selected page views, searches, date selections, share actions and service outcomes in daily groups. Browser measurements include only the action name, mobile or desktop size group and single or multiple visit group where known. They do not include your identity, phone, search text, dates, address, OTP or payment token, and use no analytics cookie or cross-site identifier. Browser signals respect Do Not Track and Global Privacy Control. Daily aggregate counters are removed by the scheduled worker after 90 days; required booking, security and financial records follow their separate retention process. A successful share or copy action does not prove that another person received it.'],
  ] },
};

export function supportContact(env = process.env) {
  const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(env.RENTRA_SUPPORT_EMAIL || '') ? env.RENTRA_SUPPORT_EMAIL : null;
  const whatsapp = /^\d{10,15}$/.test(env.NEXT_PUBLIC_WHATSAPP_NUMBER || '') ? env.NEXT_PUBLIC_WHATSAPP_NUMBER : null;
  return { email, whatsapp, hours: (env.RENTRA_SUPPORT_HOURS || '').trim().slice(0,200) || null };
}
