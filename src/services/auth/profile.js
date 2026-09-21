import 'server-only';

/**
 * Client onboarding completion — DERIVED, never stored.
 *
 * A stored `current_step = 4` silently goes wrong the moment reality changes
 * underneath it: a penny-drop that fails on retry, a KYC result that comes
 * back rejected, an admin who requests more information on one field.
 * Computing it from the data on every render means the bar cannot lie — and
 * a step can legitimately go *backwards* when something is invalidated,
 * which is correct behaviour rather than a bug.
 *
 * Two phases, deliberately (docs/rentra-role-flow.html §stepper):
 *   Phase 1 — the Client's steps.
 *   Phase 2 — Rentra's review, shown from the very first visit so that a
 *             filled bar never sits next to a still-locked button.
 */

/** Which sides each ID type needs. PAN is single-sided. */
export const REQUIRED_SIDES = {
  pan_card: ['front'],
  aadhaar_masked: ['front', 'back'],
  passport: ['front', 'back'],
  driving_licence: ['front', 'back'],
  voter_id: ['front', 'back'],
};

/**
 * @param {object} user             row from getCurrentUser()
 * @param {object|null} application client_application row
 * @param {Array} documents         live rows from listDocuments()
 */
export function profileCompletion(user, application = null, documents = []) {
  const app = application ?? {};

  // The identity step needs the actual images, not just a typed number.
  const needed = REQUIRED_SIDES[app.kycDocType] ?? [];
  const have = new Set(
    documents
      .filter((d) => d.docType === app.kycDocType && d.status !== 'rejected')
      .map((d) => d.side),
  );
  const kycDocsComplete = needed.length > 0 && needed.every((s) => have.has(s));
  const kycDocRejected = documents.some(
    (d) => d.docType === app.kycDocType && d.status === 'rejected',
  );

  const steps = [
    {
      id: 'email',
      label: 'Email verified',
      hint: 'done at sign-in',
      done: Boolean(user?.emailVerifiedAt),
      href: null,
    },
    {
      id: 'phone',
      label: 'Mobile verified',
      hint: 'where booking alerts will arrive',
      done: Boolean(user?.phoneVerifiedAt),
      href: '/partner/onboarding/phone',
      minutes: 1,
    },
    {
      id: 'details',
      label: 'Your details',
      hint: 'name, address, language, owner or agent',
      done: Boolean(user?.name && user?.clientType && app.residentialAddress),
      href: '/partner/onboarding/details',
      minutes: 2,
    },
    {
      id: 'kyc',
      label: 'Identity check',
      hint: 'Photos of one ID, and the name printed on it',
      /**
       * Done once the Client has PROVIDED the ID — both sides uploaded and the
       * name typed — not once we have verified it.
       *
       * Phase 1 is only what the Client controls. Whether the check comes back
       * verified is Rentra's outcome, and gating a Phase 1 step on it means the
       * bar can never fill no matter what they do, which is precisely the cliff
       * the two-phase split exists to prevent. Verification lives in Phase 2.
       */
      done: kycDocsComplete
        && Boolean(app.kycNameOnDoc)
        && !kycDocRejected
        && user?.kycStatus !== 'rejected',
      // A rejected check is NOT the same as an incomplete one — say which.
      failed: user?.kycStatus === 'rejected' || kycDocRejected,
      // Their side is finished, but be honest about what happens next.
      note: kycDocsComplete && app.kycNameOnDoc && user?.kycStatus === 'pending'
        ? `${needed.length === 1 ? 'Photo' : 'Photos'} uploaded — we verify this during review`
        : needed.length && !kycDocsComplete && have.size > 0
          ? `Only the ${[...have].join(' and ')} uploaded — ${needed.filter((s) => !have.has(s)).join(' and ')} still needed`
          : null,
      href: '/partner/onboarding/kyc',
      minutes: 3,
    },
    {
      id: 'payout',
      label: 'Where we should pay you',
      hint: 'UPI ID or bank account',
      /**
       * Complete once a destination exists and is not a *confirmed* mismatch.
       * `payoutNameMatch === null` means we could not check it yet — that is
       * for the Super Admin to resolve at review, not a reason to block the
       * Client from finishing their own side.
       */
      done: Boolean(
        (user?.payoutUpiId || app.payoutUpiId || app.payoutAccountRef)
        && app.payoutNameMatch !== false,
      ),
      failed: app.payoutNameMatch === false,
      href: '/partner/onboarding/payout',
      minutes: 1,
    },
    {
      id: 'consent',
      label: 'Agree to the terms',
      hint: 'one tick',
      done: Boolean(app.consentAt),
      href: '/partner/onboarding/consent',
      minutes: 1,
    },
  ];

  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const remaining = steps.filter((s) => !s.done);
  const minutesLeft = remaining.reduce((sum, s) => sum + (s.minutes ?? 0), 0);

  const submitted = app.status === 'submitted';
  const approved = user?.accountStatus === 'active';
  const changesRequested = app.status === 'more_info_needed';

  return {
    steps,
    done,
    total,
    remaining,
    minutesLeft,
    /** Bar percentage for phase 1 only — it never represents the review wait. */
    percent: Math.round((done / total) * 100),
    canSubmit: done === total && !submitted && !approved,
    submitted,
    approved,
    changesRequested,
    flaggedFields: app.flaggedFields ?? null,
    /**
     * Gate 1, as a single boolean the UI can trust.
     * The locked CTA reads this; `requireActiveClient` enforces it.
     */
    canPublish: approved,
    /** Phase 2, rendered as a step from the first visit. */
    review: {
      label: 'Rentra reviews your application',
      hint: '2 working days. We reply either way, by email and WhatsApp.',
      state: approved ? 'done' : submitted ? 'in_review' : 'waiting',
    },
  };
}

/** Copy for the gated CTA sheet — names the exact remaining steps. */
export function lockedCtaMessage(completion) {
  if (completion.approved) return null;
  if (completion.submitted) {
    return {
      title: 'Your application is with us',
      body: 'We reply within 2 working days, by email and WhatsApp. You can keep exploring meanwhile.',
      items: [],
    };
  }
  const n = completion.remaining.length;
  return {
    title: n === 1
      ? 'One thing left before you can add a property'
      : `${n} things left before you can add a property`,
    body: 'Then we review within 2 working days.',
    items: completion.remaining.map((s) => ({
      label: s.label,
      href: s.href,
      minutes: s.minutes,
    })),
  };
}
