const policies = {
  terms: {
    title: 'Terms and conditions',
    sections: [
      [
        'Using Rentra',
        'Rentra helps customers discover and book farmhouses, villas and sports or play venues operated by property owners. The property owner operates the venue. Review the listing, house rules, activity, capacity, arrival instructions and cancellation tier before booking. The details accepted at checkout are saved with your booking.',
      ],
      [
        'Dates, times and availability',
        'Farmhouse bookings can contain up to 10 visit start dates using the same slot and guest count. Sports venue bookings use an activity, date, start time and duration, with a requested court or resource where available. Follow the exact arrival and departure times shown in Asia/Kolkata. Separate or consecutive visits do not include access between visits. A slot name such as full day does not override the actual times shown.',
      ],
      [
        'Quotes, checkout and confirmation',
        'A quote checks availability and prices without reserving inventory. Quotes and checkout holds are time-limited; the current default is 10 minutes. Your booking is confirmed only after Rentra verifies a captured payment and reserves the selected visits. Opening checkout, receiving a payment message or seeing a pending status does not confirm a booking. If the result is uncertain, check your booking or contact support before paying again.',
      ],
      [
        'Prices, fees and deposits',
        'Prices are shown in INR. Rent includes applicable extra-guest charges. The current platform fee is 8% of rent, and brokerage is zero. Review the actual full or advance collection shown at checkout and any remaining balance. A security deposit is shown separately for each visit and is excluded from online checkout collection. Displaying a deposit does not mean Rentra collected it.',
      ],
      [
        'Test payments and refunds',
        'The current online payment integration uses Razorpay Test. These transactions do not collect, refund or pay out actual bank money. New checkout attempts may be disabled while existing attempts and refund checks continue. A verified Test payment or refund is a sandbox outcome. Do not send a real transfer in response to a Test checkout or support message.',
      ],
      [
        'Changes, cancellations and accepted rules',
        'The cancellation rules saved with each visit govern its estimate, including whether cutoffs use days or hours. Cancelling selected visits does not cancel other visits in the order. The current change process is cancellation under those rules followed by a new booking at current availability and prices. A support request does not change a booking or reserve replacement dates. New listing prices or rules do not rewrite accepted booking records.',
      ],
      [
        'Owner listings and access',
        'Owners create private drafts, submit property and verification details, and use the review workflow before their properties are published. Owner and caretaker access depends on account status and assigned permissions. Do not share account credentials, OTPs or access codes. The approval and booking workflows do not guarantee a particular business outcome.',
      ],
      [
        'Arrival, reviews and support',
        'Exact arrival details are available in authorized confirmed booking records. Reviews require an eligible completed visit with recorded handover, return and completion evidence; a Test payment alone does not prove a visit occurred. Reviews undergo publication checks. Support requests and replies are available in your account and are not live chat or an emergency service. No response deadline is promised.',
      ],
    ],
  },
  cancellation: {
    title: 'Cancellation and refund policy',
    sections: [
      [
        'Rules saved with your booking',
        'Each visit keeps its accepted cancellation tier, policy version and, where available, its refund bands. Those saved rules govern the estimate. The current supported booking policy is customer-v1. Historical or unsupported records require staff review. Current public wording does not change previously accepted bookings.',
      ],
      [
        'Farmhouse and villa cutoffs',
        'Cutoffs use exact elapsed 24-hour days before the stored arrival time, rather than midnight calendar dates. Flexible: 100% of rent at least 3 days before arrival; 50% less than 3 days before arrival. Moderate: 100% at least 7 days before arrival; 50% at least 3 days but less than 7 days before arrival; 0% less than 3 days before arrival. Strict: 50% at least 7 days before arrival; 0% less than 7 days before arrival.',
      ],
      [
        'Sports and play venue cutoffs',
        'When the saved policy uses hours, cutoffs count exact hours before the booked start time. Flexible: 100% of rent at least 4 hours before the start; 0% less than 4 hours before. Moderate: 100% at least 24 hours before; 50% at least 6 hours but less than 24 hours before; 0% less than 6 hours before. Strict: 50% at least 48 hours before; 0% less than 48 hours before. The exact cutoff is included in the higher refund band.',
      ],
      [
        'Started visits',
        'Self-service cancellation is unavailable at or after a visit starts. Contact support for a started visit, arrival problem or unsupported historical record. Contacting support does not cancel the visit or promise a refund.',
      ],
      [
        'Platform fee, deposits and captured funds',
        'For the current default tiers, the platform fee is refundable only when the flexible tier grants a full rent refund. An explicitly saved fee rule takes precedence. Estimates are calculated in paise, with fractional paise rounded down, and capped by verified captured rent and fee components after prior refund obligations. Uncollected balances cannot be refunded through the gateway. Security deposits are excluded from current online checkout collection, so the gateway cannot return an uncollected deposit.',
      ],
      [
        'Review, cancel and track',
        'Open the booking record, select the visits and review the estimate before confirming. Only selected visits are cancelled. If the estimate changes, review it again. Cancellation and refund completion are separate outcomes. A refund remains pending until the provider result is verified; failed or uncertain outcomes need reconciliation. No fixed refund completion time is promised. Current Razorpay Test refunds do not return actual bank money.',
      ],
      [
        'Changing dates, activity or guest count',
        'The current process is cancellation and a fresh booking. Sending a change request leaves the original booking unchanged. Replacement dates, court availability and the old price are not guaranteed. Check new availability, guest limits and prices before rebooking.',
      ],
    ],
  },
  privacy: {
    title: 'Privacy policy',
    sections: [
      [
        'Information we use',
        'Rentra processes account names and contact details, authentication and session records, preferences and consents, saved properties, booking and visit details, payment references, reviews, support conversations and privacy requests. For owners, this also includes submitted property information, photos, verification and payout details, and caretaker access records. These records support account access, booking operations, verification, payments, support and service security.',
      ],
      [
        'Access and public information',
        'Your private booking, support and privacy records require authentication and ownership or permission checks. Authorized Rentra staff can review relevant records. Owners and assigned caretakers can access operational information for their properties according to their permissions. Owners do not have access to the customer support inbox. Published property content, reviews and approved owner replies are public. Exact arrival details are restricted to authorized confirmed booking records.',
      ],
      [
        'Payment and service providers',
        'Razorpay handles the current Test checkout. Rentra stores payment references and, when you authorize a saved payment method, protected provider tokens and limited method details; account closure disables local reuse without proving provider deletion. When configured, Twilio handles OTP or booking SMS delivery, and Cloudinary handles uploaded media. Hosting and database services process the records needed to run Rentra. Do not send OTPs, passwords, card details, bank credentials or identity documents in support messages.',
      ],
      [
        'Privacy requests and review',
        'Submit a data-copy or account-deletion request through your account privacy page. Owners can use their owner privacy settings. Requests are reviewed for identity, authority and scope before fulfillment. Recent authentication and appropriate permissions protect sensitive actions. Saving a request or resolving its linked support conversation does not complete the privacy request. Review or fulfillment may require follow-up, and no fixed completion deadline is promised.',
      ],
      [
        'Data copies',
        'Approved access requests can produce an encrypted, account-scoped export. Downloads require authorization, are logged and expire 24 hours after the export is generated. Expired or revoked copies cannot be downloaded; the scheduled worker clears expired export artifacts. Copies exclude authentication secrets, OTPs, sessions, payment tokens, internal notes and other participants’ private identifiers. Requests outside the automatic export scope require a separately reviewed copy.',
      ],
      [
        'Account closure',
        'Approved closure uses staged cleanup rather than immediate deletion of every record. Active visits, checkout holds, disputes and pending payments or refunds may need resolution first. Cleanup removes the profile photo and live profile contact fields, removes saved properties, disables saved payment methods and account access, and revokes authentication access. Owner closure also clears owner preferences and revokes caretaker access and invitations. Failed stages remain recorded for retry. The receipt describes the completed scope and retained or outstanding records.',
      ],
      [
        'Records that remain',
        'Historical booking contacts, transactions, refunds, cancellation evidence, support and dispute messages, review content, verification references, audit evidence and an account identifier may remain after live account cleanup. Retention depends on record purpose, reviewed schedules and any applicable holds. Shared verification records, provider-held data, protected payment tokens, delivered messages and backups require separate review or disposal. Account closure is not full erasure, provider deletion or a claim that every retained record is anonymous.',
      ],
      [
        'Optional aggregate measurement',
        'When enabled, Rentra counts selected page views, searches, date selections, share actions and service outcomes in daily groups. Browser measurements include only the action name, mobile or desktop size group and single or multiple visit group where known. They exclude identity, phone, search text, dates, address, OTP and payment tokens, and use no analytics cookie or cross-site identifier. Browser signals respect Do Not Track and Global Privacy Control. The scheduled worker removes daily aggregate counters after 90 days. Required booking, financial and security records follow their separate retention process.',
      ],
      [
        'Questions about your information',
        'Use your privacy request and its support link to ask about a copy, account closure or retained records. Return to your account to check replies and the separate request status. Support is not live chat. A resolved conversation is not evidence that data was exported, deleted or removed by a provider.',
      ],
    ],
  },
};
export default policies;
