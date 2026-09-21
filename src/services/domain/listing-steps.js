/**
 * The listing walkthrough — one source of truth for BOTH chromes.
 *
 * The builder renders the same nine sections two ways:
 *   · /partner/listings/[id]/setup/[step]  full-screen walkthrough, one step
 *     at a time. For a DRAFT, where the job is "get to the end".
 *   · /partner/listings/[id]              every section on one page, random
 *     access. For a LIVE listing, where the job is "change one thing".
 *
 * That is what Airbnb does too, and it is why the sections live in their own
 * module: the walkthrough is a different chrome around identical forms, not a
 * second implementation.
 *
 * WHY CHAPTERS: nine steps is past the point where multi-step forms start
 * shedding people — the research consensus is that abandonment climbs beyond
 * about six. Grouping the nine into five named chapters means the bar reads
 * "2 of 5 · The space" instead of "4 of 9", which is the number that decides
 * whether someone keeps going. Labelled steps beat bare percentages for any
 * flow with five or more.
 */

/**
 * `advance` says what the Next button does:
 *   'submit'   — the step is a form; save it, and only move on if it saved.
 *   'navigate' — uploads already saved themselves as they happened, so Next
 *                is pure navigation. Forcing a redundant submit on the photo
 *                step would be a lie about what is happening.
 */
export const LISTING_CHAPTERS = [
  {
    id: 'place',
    label: 'The place',
    steps: [
      { id: 'basics', label: 'What it is', advance: 'submit' },
      { id: 'location', label: 'Where it is', advance: 'submit' },
    ],
  },
  {
    id: 'space',
    label: 'The space',
    steps: [
      { id: 'capacity', label: 'Size and capacity', advance: 'submit' },
      { id: 'amenities', label: 'What it has', advance: 'submit' },
    ],
  },
  {
    id: 'terms',
    label: 'Rules and price',
    steps: [
      { id: 'rules', label: 'House rules', advance: 'submit' },
      { id: 'pricing', label: 'Slots and pricing', advance: 'submit' },
      { id: 'terms', label: 'Deposit and cancellation', advance: 'submit' },
    ],
  },
  {
    id: 'photos',
    label: 'Photos',
    steps: [
      { id: 'photos', label: 'Photos', advance: 'navigate' },
    ],
  },
  {
    id: 'publish',
    label: 'Proof and publish',
    steps: [
      { id: 'ownership', label: 'Proof it is yours', advance: 'navigate' },
      /**
       * A real ending. Dropping someone back onto the dashboard the instant
       * the last field saves leaves them unsure whether anything happened —
       * the review step is where they see the whole thing and choose to send
       * it. It takes no input, so it never blocks the walkthrough.
       */
      { id: 'review', label: 'Check and send', advance: 'none' },
    ],
  },
];

/** Flat step list, in walkthrough order. */
export const LISTING_STEPS = LISTING_CHAPTERS.flatMap((c) =>
  c.steps.map((s) => ({ ...s, chapterId: c.id, chapterLabel: c.label })),
);

export const LISTING_STEP_IDS = LISTING_STEPS.map((s) => s.id);

/** Steps that a completion section actually gates. `review` has none. */
export const INPUT_STEP_IDS = LISTING_STEPS
  .filter((s) => s.advance !== 'none')
  .map((s) => s.id);

/**
 * The DOM id of a section wrapper — namespaced, and it has to stay that way.
 *
 * A section and the fields inside it share one document. `<Section id="photos">`
 * rendered `<section id="photos">` directly above `<input id="photos">`, so
 * `<label for="photos">` resolved to the SECTION — and a label pointing at an
 * element that cannot be labelled does nothing at all. The result was an "Add
 * photos" dropzone that looked like a button and was completely dead on click,
 * on the one step of the walkthrough that cannot be completed any other way.
 * `capacity` was silently broken in exactly the same way.
 *
 * Prefixing here fixes the whole class rather than the two instances: no field
 * will ever be named `section-something`.
 *
 * It lives in this module, not in chrome.jsx, because the manage page is a
 * SERVER component and chrome.jsx is `'use client'` — a plain function
 * exported from a client module is a client reference, and calling one on the
 * server throws.
 */
export function sectionAnchorId(id) {
  return `section-${id}`;
}

export function isListingStep(id) {
  return LISTING_STEP_IDS.includes(id);
}

export function getStep(id) {
  return LISTING_STEPS.find((s) => s.id === id) ?? null;
}

export function stepIndex(id) {
  return LISTING_STEP_IDS.indexOf(id);
}

export function nextStepId(id) {
  const i = stepIndex(id);
  return i >= 0 && i < LISTING_STEPS.length - 1 ? LISTING_STEP_IDS[i + 1] : null;
}

export function prevStepId(id) {
  const i = stepIndex(id);
  return i > 0 ? LISTING_STEP_IDS[i - 1] : null;
}

export function stepHref(listingId, stepId) {
  return `/partner/listings/${listingId}/setup/${stepId}`;
}

/**
 * Where to resume. DERIVED from completion, never stored — same reason the
 * completion bar is derived: a stored `current_step` is wrong the moment a
 * photo is deleted or an admin rejects the ownership document.
 */
export function firstIncompleteStepId(completion) {
  const bySection = new Map(completion.sections.map((s) => [s.id, s]));
  // A rejected section outranks an unstarted one — send them to the problem.
  const failed = INPUT_STEP_IDS.find((id) => bySection.get(id)?.failed);
  if (failed) return failed;
  const todo = INPUT_STEP_IDS.find((id) => !bySection.get(id)?.done);
  return todo ?? 'review';
}

/**
 * Progress for the walkthrough bar.
 *
 * Deliberately reports two different things:
 *   · `chapter` — where they are, which is what the label shows.
 *   · `doneCount` — how much is actually finished, which drives the fill.
 * Position and completion are not the same number, and conflating them is how
 * a bar ends up full while three sections are still empty.
 */
export function wizardProgress(completion, currentStepId) {
  const bySection = new Map(completion.sections.map((s) => [s.id, s]));
  const current = getStep(currentStepId);
  const chapterIndex = LISTING_CHAPTERS.findIndex((c) => c.id === current?.chapterId);

  const chapters = LISTING_CHAPTERS.map((c, i) => {
    const gated = c.steps.filter((s) => s.advance !== 'none');
    const done = gated.filter((s) => bySection.get(s.id)?.done).length;
    const failed = gated.some((s) => bySection.get(s.id)?.failed);
    const chapterSteps = c.steps.map((s) => {
      const section = bySection.get(s.id);
      const isReview = s.advance === 'none';
      return {
        id: s.id,
        label: s.label,
        index: stepIndex(s.id) + 1,
        done: isReview ? completion.done === completion.total : Boolean(section?.done),
        failed: Boolean(section?.failed),
        isCurrent: s.id === currentStepId,
        isReview,
      };
    });

    return {
      id: c.id,
      label: c.label,
      total: gated.length || 1,
      done: gated.length ? done : 1,
      complete: gated.length ? done === gated.length : true,
      failed,
      isCurrent: i === chapterIndex,
      firstStepId: c.steps[0].id,
      steps: chapterSteps,
    };
  });

  return {
    chapters,
    steps: chapters.flatMap((c) => c.steps.map((s) => ({ ...s, chapterId: c.id }))),
    chapterIndex,
    chapterNumber: chapterIndex + 1,
    chapterTotal: LISTING_CHAPTERS.length,
    chapterLabel: current?.chapterLabel ?? '',
    stepNumber: stepIndex(currentStepId) + 1,
    stepTotal: LISTING_STEPS.length,
    doneCount: completion.done,
    doneTotal: completion.total,
    percent: completion.total ? Math.round((completion.done / completion.total) * 100) : 0,
    minutesLeft: completion.minutesLeft,
  };
}
